/** Resizing image proxy. */

import {AbstractBlobStore} from 'abstract-blob-store'
import config from 'config'
import {createHash} from 'crypto'
import * as multihash from 'multihashes'
import Sharp from 'sharp'
import {URL} from 'url'
import {isArchiveStore, KoaContext, proxyStore, retentionStore, uploadStore} from './common'
import {
    AVIF_EFFORT,
    EMPTY_IMAGE_URL_PATTERNS,
    applyUrlReplacements,
    FETCH_DEADLINE_MS,
    FETCH_DEFAULT_OPEN_MS,
    FETCH_DEFAULT_READ_MS,
    FETCH_DEFAULT_RESPONSE_MS,
    FETCH_DEFAULT_WALL_MS,
    MAX_CACHED_ORIGINAL_SIZE,
    MAX_INPUT_PIXELS,
    budgetSignal, STORE_OP_TIMEOUT_MS,
} from './constants'
import {APIError} from './error'
import {serveOrBuildFallbackImage} from './fallback'
import {
    cacheControlFor, derive, etagFor, fallbackImage, FallbackImage, isFallbackImage, passthroughImage, Provenance,
    realImage, ServedImage, storeImage, worstOf,
} from './served-image'
import {renderAnimatedVariant} from './animated'
import {clientGoneSignal, isEncodeAborted, runEncode} from './encode-limit'
import {fetchImageWithFallbacks} from './fetch-image'
import {captureImageFailure} from './sentry'
import {
    AcceptedContentTypes,
    applyMatchFallbackFormat,
    applyProxyResize,
    assertPublicUrl,
    buildSharpPipeline,
    fetchUrl,
    getDefaultUrlAndParams,
    getImageKey,
    getSharpMetadataWithRetry,
    hasValidInvalidateKey,
    isBlacklistedUrl,
    mimeMagic,
    needsMatchFallback,
    NeedleResponse,
    OutputFormat,
    isInternalProxyUrl,
    isInternalUploadUrl,
    parseProxiedUrl,
    ProxyOptions,
    purgeCache,
    readStream,
    ScalingMode,
    isStoreAbort,
    storeExists,
    storeExistsBounded,
    storeRemove,
    storeStat,
    storeStatBounded,
    isAnimatedSource,
    primaryPageOf,
    streamHeadBounded,
    supportsAvif,
    supportsWebP,
    acceptsAnyImageType
} from './utils'

const MAX_IMAGE_SIZE = Number.parseInt(config.get('max_image_size'))
const DefaultAvatar = config.get('default_avatar') as string

if (!Number.isFinite(MAX_IMAGE_SIZE)) {
    throw new Error('Invalid max image size')
}

/**
 * Whether a freshly fetched original is worth persisting in the proxy cache.
 *
 * Fallback bytes must never be written (they would poison the key), and the
 * upload/esteem-legacy stores are archives we only read from here. Beyond that
 * the original is optional: it exists purely so a later request for a different
 * size or format can re-render without a second upstream fetch, so oversized
 * ones are skipped rather than allowed to dominate the cache (see
 * MAX_CACHED_ORIGINAL_SIZE).
 */
export function shouldCacheOriginal(
    bytes: number,
    opts: {image: {kind: Provenance}, usesUploadStore: boolean, isLegacy: boolean},
    cap: number = MAX_CACHED_ORIGINAL_SIZE,
): boolean {
    if (opts.image.kind === 'fallback' || opts.usesUploadStore || opts.isLegacy) { return false }
    // A cap of 0 means "never cache originals". Checked before the comparison
    // because `0 <= 0` would otherwise let a zero-byte body through.
    if (cap <= 0) { return false }
    return bytes <= MAX_IMAGE_SIZE && bytes <= cap
}


const SERVICE_URL = new URL(config.get('service_url'))
/** A rendered variant is addressed by a key that encodes its inputs, so it never changes. */
const IMMUTABLE_CACHE_CONTROL = 'public,max-age=31536000,immutable'

/**
 * A stored variant the service could never have produced. Output formats are
 * JPEG, PNG, WebP, AVIF or the source's own bytes for `match`, and `match` never
 * keeps HEIF because no browser renders it (see needsMatchFallback); so HEIF under
 * a variant key can only be a raw container stored by the old animated branch.
 */
export function isPoisonedVariant(mimeType: string): boolean {
    const t = mimeType.toLowerCase()
    return t === 'image/heif' || t === 'image/heic'
}

const fromFetch = (result: {res: NeedleResponse, isFallback: boolean}): ServedImage =>
    result.isFallback
        ? fallbackImage(result.res.body, 'every mirror failed, default substituted')
        : realImage(result.res.body)

// Public proxy hosts that old post bodies wrapped around img.esteem.ws URLs
// (e.g. https://steemitimages.com/500x0/https://img.esteem.ws/abc.jpg)
const ESTEEM_WRAP_PREFIX = /^https?:\/\/(?:steemitimages\.com|images\.hive\.blog)\/\d+x\d+\//

function parseOptions(query: {[key: string]: any}, acceptHeader: string = ''): ProxyOptions {
    const width = Number.parseInt(query['width']) || undefined
    const height = Number.parseInt(query['height']) || undefined
    const ignorecache = Number.parseInt(query['ignorecache']) || undefined
    const invalidate = Number.parseInt(query['invalidate']) || undefined
    let mode: ScalingMode
    switch (query['mode']) {
        case undefined:
        case 'cover':
            mode = ScalingMode.Cover
            break
        case 'fit':
            mode = ScalingMode.Fit
            break
        default:
            throw new APIError({message: 'Invalid scaling mode', code: APIError.Code.InvalidParam, info: {
                    metadata: 'scaling-failed'
                }})
    }
    let format: OutputFormat
    switch (query['format']) {
        case undefined:
        case 'match':
            // When format is not specified or 'match', use content negotiation via Accept header
            // Prefer AVIF > WebP > Match (original format)
            if (supportsAvif(acceptHeader)) {
                format = OutputFormat.AVIF
            } else if (supportsWebP(acceptHeader)) {
                format = OutputFormat.WEBP
            } else {
                format = OutputFormat.Match
            }
            break
        case 'jpeg':
        case 'jpg':
            format = OutputFormat.JPEG
            break
        case 'png':
            format = OutputFormat.PNG
            break
        case 'webp':
            format = OutputFormat.WEBP
            break
        case 'avif':
            format = OutputFormat.AVIF
            break
        default:
            format = OutputFormat.Match
    }
    const blur = query['blur'] === '1' || query['blur'] === 'true'
    return {width, height, mode, format, ignorecache, invalidate, blur}
}

/**
 * Transcode an already-sized cached Match variant for a client that cannot
 * decode its format. An animated source is handed back as it is (transcoding
 * would drop its frames) and is still the real variant. A failed conversion
 * also hands the cached bytes back, because an image one client cannot render
 * beats a failed request, but as a PASSTHROUGH: those bytes are not what this
 * client asked for, so they must not carry the variant's ETag or its year of
 * freshness, or a conditional request would keep validating them long after
 * the conversion recovers.
 */
async function convertCachedMatchVariant(
    ctx: KoaContext,
    cached: Buffer,
    mimeType: string,
    acceptHeader: string,
    options: ProxyOptions
): Promise<{image: ServedImage, contentType: string}> {
    try {
        const metadata = await Sharp(cached, { limitInputPixels: MAX_INPUT_PIXELS }).metadata()
        if (isAnimatedSource(metadata, mimeType)) {
            return {image: realImage(cached), contentType: mimeType}
        }
        const image = buildSharpPipeline(cached, false, primaryPageOf(metadata))
        const contentType = applyMatchFallbackFormat(image, mimeType, acceptHeader, metadata.hasAlpha)
        const buffer = await runEncode(() => image.toBuffer(), options, clientGoneSignal(ctx))
        ctx.log.debug({ mimeType, contentType }, 'converted cached match variant for client')
        return {image: realImage(buffer), contentType}
    } catch (err) {
        if (isEncodeAborted(err)) {
            throw err
        }
        ctx.log.error({ err, mimeType }, 'failed to convert cached match variant')
        return {image: passthroughImage(cached, 'cached variant conversion failed, stored bytes served'), contentType: mimeType}
    }
}

export async function proxyHandler(ctx: KoaContext) {
    ctx.tag({handler: 'proxy'})
    // One budget for every upstream fetch this request makes, including the
    // metadata re-walk. It is sized so that the walk, the reserved default-image
    // fetch and the render all fit inside the first-byte timeout the cache in
    // front of this service gives the backend (see FETCH_DEADLINE_MS), so an
    // exhausted chain gets the chance to answer with a placeholder instead of
    // being cut off as a 503.
    const fetchDeadlineAt = Date.now() + FETCH_DEADLINE_MS

    APIError.assert(ctx.method === 'GET', APIError.Code.InvalidMethod)
    APIError.assertParams(ctx.params, ['url'])

    const acceptHeader = ctx.get('accept') || ''
    const isLegacy = ctx.query['_src'] === 'legacy'
    const options = parseOptions(ctx.query, acceptHeader)
    // `ignorecache` forces the same expensive path as `invalidate` (skip the stored
    // variant and original, re-fetch upstream, re-decode, re-encode) but was
    // historically unauthenticated, so any anonymous caller could turn one cheap
    // cache hit into a full miss plus a mirror-chain walk. Honour it only for a
    // caller holding the invalidate token; otherwise treat it as absent, so the
    // request resumes normal cache handling. That is not a guaranteed cache hit:
    // a genuine miss still fetches and renders, and Varnish passes these to the
    // backend either way. What it removes is the ability to force a miss on a
    // variant that IS cached. Neutralised rather than rejected so a stray benign
    // caller still gets its image.
    if (options.ignorecache && !hasValidInvalidateKey(ctx)) {
        ctx.log.warn({url: ctx.params.url}, 'ignoring unauthenticated ignorecache')
        options.ignorecache = undefined
    }
    const shouldBypassCache = !!(options.ignorecache || options.invalidate)
    if (options.invalidate) {
        APIError.assert(
            hasValidInvalidateKey(ctx),
            { code: APIError.Code.Deplorable, message: 'Forbidden: invalid invalidate key' }
        )
    }
    const cleanUrl = ctx.params.url.replace(/\.(webp|png)$/, '')
    const proxyRequestPurgeUrls = (() => {
        const purgeUrl = new URL(ctx.request.url, SERVICE_URL.origin)
        purgeUrl.searchParams.delete('invalidate')
        purgeUrl.searchParams.delete('ignorecache')
        const urls = new Set<string>([purgeUrl.toString()])
        for (const suffix of ['', '.png', '.webp']) {
            purgeUrl.pathname = `/p/${cleanUrl}${suffix}`
            urls.add(purgeUrl.toString())
        }
        return [...urls]
    })()
    let url = parseProxiedUrl(cleanUrl)
    let urlParams = cleanUrl
    // Set when the request itself is answered with the default image (a blocked
    // source): every byte fetched from here on stands in for what was asked
    let substitution: FallbackImage<null> | undefined

    // resolve double proxied images
    while (isInternalProxyUrl(url)) {
        const cleanUrl2 = url.pathname.slice(3).replace(/\.(webp|png)$/, '')
        url = parseProxiedUrl(cleanUrl2)
    }

    // Validate dimensions
    if (options.width !== undefined) {
        APIError.assert(Number.isFinite(options.width), 'Invalid width')
        APIError.assert(options.width >= 0, 'Width must be non-negative')
    }
    if (options.height !== undefined) {
        APIError.assert(Number.isFinite(options.height), 'Invalid height')
        APIError.assert(options.height >= 0, 'Height must be non-negative')
    }

    // Dimension handling:
    // - 0x0 = proxy without resizing (passthrough)
    // - 500x0 = resize to width 500, height auto (maintain aspect ratio)
    // - 0x500 = resize to height 500, width auto (maintain aspect ratio)
    // - 500x300 = resize to exact dimensions

    // cache all proxy requests for a minimum 10 minutes, including failures
    ctx.set('Cache-Control', 'public,max-age=600')

    let urlString = url.toString()

    if (options.ignorecache || options.invalidate) {
        const normalizedSourceUrl = new URL(urlString)
        normalizedSourceUrl.searchParams.delete('ignorecache')
        normalizedSourceUrl.searchParams.delete('invalidate')
        url = normalizedSourceUrl
    }
    urlString = url.toString()
    ctx.tag({ normalizedUrl: urlString })

    // Check if URL/domain is in blocklist or is exactly the empty 0x0 URL (not URLs that start with it)
    if (isBlacklistedUrl(urlString)) {
        ({ url, urlParams } = getDefaultUrlAndParams())
        substitution = fallbackImage(null, 'blocked source, default substituted')
        ctx.log.error({ urlString }, 'Falling back to default image due to blacklist or 0x0 URL')
    }

    // Handle URLs that start with 0x0/ but have additional content (like proxied URLs)
    const matchedEmptyImagePrefix = EMPTY_IMAGE_URL_PATTERNS.find(
        (pattern) => pattern.endsWith('/') && urlString.startsWith(pattern)
    )
    if (matchedEmptyImagePrefix) {
        // Extract the actual URL after the prefix
        const actualUrl = urlString.substring(matchedEmptyImagePrefix.length)
        if (actualUrl && actualUrl.length > 0) {
            try {
                url = new URL(actualUrl)
                urlString = url.toString()
                ctx.log.debug({ originalUrl: urlString, extractedUrl: actualUrl }, 'Extracted URL from 0x0 prefix')
            } catch (err) {
                ctx.log.error({ err, originalUrl: urlString }, 'Failed to parse URL after 0x0 prefix')
            }
        }
    }
    urlString = url.toString()
    urlString = applyUrlReplacements(urlString)
    url = new URL(urlString)
    // Re-check after the 0x0-prefix extraction and URL replacements above: the
    // effective source can differ from the URL checked initially (a blocked
    // source nested inside an allowed proxy URL), and the extraction can even
    // overwrite the default-image substitution the first check made
    if (isBlacklistedUrl(urlString)) {
        ({ url, urlParams } = getDefaultUrlAndParams())
        urlString = url.toString()
        substitution = fallbackImage(null, 'blocked source, default substituted')
        ctx.log.error({ urlString }, 'Falling back to default image due to blacklist after URL normalization')
    }
    // img.esteem.ws is gone and its mirrors no longer have these images; surviving
    // originals were preserved in the upload store, keyed by the historically
    // rewritten URL (steemitimages.com/0x0/<url>). Unwrap public-proxy prefixes
    // first so every request form of an esteem image resolves to that same key.
    const isEsteemHost = (s: string) =>
        s.includes('://img.esteem.ws/') || s.includes('://img.esteem.app/')
    while (ESTEEM_WRAP_PREFIX.test(urlString) && isEsteemHost(urlString)) {
        urlString = urlString.replace(ESTEEM_WRAP_PREFIX, '')
        url = new URL(urlString)
    }
    // only esteem.ws was historically rewritten before hashing — keep that
    // rewrite so its keys stay stable; esteem.app keys are the raw URL hash
    // (rescued .app originals are served via the upload-store archive lookup)
    const isEsteemLegacy = urlString.includes('://img.esteem.ws/')
    if (isEsteemLegacy) {
        urlString = `https://steemitimages.com/0x0/${urlString}`
    }
    if (process.env.NODE_ENV !== 'test') {
        assertPublicUrl(url)
    }

    // where the original image is/will be stored
    let origStore: AbstractBlobStore
    let origKey: string
    let contentType: string
    ctx.originalUrl = urlString
    const origIsUpload = isInternalUploadUrl(url)
    // esteem-legacy originals live in the upload store; treat that store as
    // read-only here (never overwritten by fetches, never removed by invalidate)
    const usesUploadStore = origIsUpload || isEsteemLegacy
    ctx.tag({is_upload: origIsUpload})
    if (isEsteemLegacy) { ctx.tag({esteem_legacy: true}) }
    if (origIsUpload) {
        // if we are proxying our or own image, use the uploadStore directly
        // to avoid storing two copies of the same data
        origStore = uploadStore
        origKey = url.pathname.slice(1).split('/')[0]
    } else {
        const urlHash = createHash('sha1')
            .update(urlString)
            .digest()
        origStore = isEsteemLegacy ? uploadStore : proxyStore
        origKey = 'U' + multihash.toB58String(
            multihash.encode(urlHash, 'sha1')
        )
    }
    const imageKey = getImageKey(origKey, options)
    // No validator yet: a real variant's ETag is derived from its stored bytes
    // (see realEtag), so it is set once those are in hand, on a hit or a render
    ctx.tag({imageKey})
    if (options.invalidate) {
        // Purge CDN first (fire-and-forget)
        purgeCache(proxyRequestPurgeUrls)
        ctx.tag({ invalidate: true })
        // Delete only the specific requested variant and the original — no directory scan
        try {
            await storeRemove(proxyStore, imageKey)
            ctx.log.debug({ imageKey }, 'removed resized imageKey due to invalidate')
        } catch (_e) { /* may not exist */ }
        if (!usesUploadStore) {
            try {
                await storeRemove(origStore, origKey)
                ctx.log.debug({ image: origKey }, 'removed original due to invalidate')
            } catch (_e) { /* may not exist */ }
        }
    }
    // ctx.fresh only consults the conditional headers once the status is
    // 2xx/304, and Koa's default is 404 at this point, so without an explicit
    // 200 the revalidation branch inside the cache-hit block could never fire.
    // The 304 itself is answered only once a stored variant has been inspected
    // and found healthy, see below: a validator alone does not prove the bytes
    // behind it are the ones this service would render today.
    ctx.status = 200
    // Every store call before the upstream fetch, this first variant lookup
    // included, is bounded and charged to the same request budget the fetch
    // uses: a stalled store used to eat the whole budget here, so the walk
    // started with nothing left (see #44). A stall reads as a miss.
    const storeSignal = () => budgetSignal(fetchDeadlineAt, STORE_OP_TIMEOUT_MS)
    // check if we already have a converted image for a requested key
    let cachedVariant: {head: Buffer, stream: NodeJS.ReadableStream} | undefined
    // the store's own stream, kept so a branch that abandons the hit (304, repair)
    // can release the file handle rather than leave an unconsumed pipe behind
    let cachedInput: NodeJS.ReadableStream | undefined
    const variantStat = (!options.ignorecache && !options.invalidate)
        ? await storeStatBounded(proxyStore, imageKey, storeSignal(), ctx.log, 'variant') : {exists: false}
    if (variantStat.exists) {
        const headSignal = storeSignal()
        cachedInput = proxyStore.createReadStream({ key: imageKey, signal: headSignal } as any)
        try {
            cachedVariant = await streamHeadBounded(cachedInput, 16384, headSignal)
        } catch (err) {
            ctx.log.warn({ err: (err as Error).message, imageKey }, isStoreAbort(err)
                ? 'cached variant read timed out, treating as a miss'
                : 'cached variant read failed, treating as a miss')
        }
    }
    if (cachedVariant) {
        ctx.tag({store: 'resized'})
        ctx.log.debug('streaming %s from store', imageKey)
        const {head, stream} = cachedVariant
        const file = stream as NodeJS.ReadableStream & {destroy: () => void}
        const abandonHit = () => {
            file.destroy()
            if (cachedInput && (cachedInput as any).destroy) { (cachedInput as any).destroy() }
        }
        file.on('error', async (err) => {
            ctx.log.error({ err, imageKey }, 'unable to read')
            try {
                await storeRemove(proxyStore, imageKey)
                ctx.log.debug({ image: imageKey }, 'removed resized imageKey file')
            } catch (err) {
                ctx.log.error({ err, imageKey }, 'unable to remove onerror')
            }
            file.destroy()
            ctx.res.writeHead(500, 'Internal Error')
            ctx.res.end()
        })
        const mimeType = await mimeMagic(head)
        if (isPoisonedVariant(mimeType)) {
            // The service never renders to HEIF, so a stored HEIF under a variant
            // key is a raw container written back when a multi-image HEIC was
            // mistaken for an animation (#43): unresized, and for most clients
            // undisplayable. Drop it and take the miss path, which re-renders from
            // the original or refetches; the repaired variant is stored on the way.
            ctx.tag({repaired_variant: true})
            ctx.log.warn({ imageKey, mimeType }, 'stored variant is a raw HEIF container, discarding and re-rendering')
            abandonHit()
            try { await storeRemove(proxyStore, imageKey) } catch (_e) { /* best effort */ }
        } else {
        // A 304 is a promise that the client's copy is what this key renders to,
        // and it is made only here, with a healthy stored variant in hand. Before
        // this point a client could present the validator of a raw container the
        // old animated branch stored (#43) and be told to keep it. Without a
        // stored variant the request renders and answers 200 instead, so the
        // client replaces whatever it held. The ETag set earlier is the REAL
        // variant's: a placeholder never shares it (see etagFor), and a
        // substituted request derives its key from the default image, so a
        // client's copy of a blocked source cannot match; the guard is belt and
        // braces.
        // The validator names the stored bytes, so a client holding a copy the
        // repair replaced presents a different one and is not told to keep it
        ctx.set('ETag', etagFor(realImage(head), imageKey, head, variantStat.size))
        if (ctx.fresh && !shouldBypassCache && !substitution) {
            abandonHit()
            ctx.status = 304
            return
        }
        // Match variants are one bucket for every client that negotiated neither
        // AVIF nor WebP, so a stored AVIF/HEIF passthrough can be undecodable for
        // the client asking now. Convert the cached bytes rather than falling
        // through to the origin: the variant is already sized, and the original
        // may have been pruned or its remote host may be down.
        // The store only ever holds real variants (storeImage refuses the rest),
        // so a hit is real unless this whole request was substituted: a cached
        // variant of the DEFAULT image standing in for a blocked source must not
        // ship the immutable 1y header or the real ETag, or it would freeze the
        // placeholder at the edge long after the block is lifted. A conversion
        // for the client's Accept can also fail and hand the stored bytes back
        // as a passthrough, so the value, and the headers derived from it, are
        // settled only after that step has had its say.
        let served: ServedImage<NodeJS.ReadableStream | Buffer>
        let servedType = mimeType
        if (options.format === OutputFormat.Match && needsMatchFallback(mimeType, acceptHeader)) {
            ctx.tag({match_fallback: true})
            const cached = await readStream(stream)
            const converted = await convertCachedMatchVariant(ctx, cached, mimeType, acceptHeader, options)
            served = worstOf(converted.image, substitution)
            servedType = converted.contentType
        } else {
            served = worstOf(realImage(stream), substitution)
        }
        ctx.set('Content-Type', servedType)
        ctx.set('Vary', 'Accept')
        ctx.set('Cache-Control', cacheControlFor(served, IMMUTABLE_CACHE_CONTROL))
        ctx.set('ETag', etagFor(served, imageKey, head, variantStat.size))
        ctx.body = served.bytes
        return
        } // end healthy cached variant
    }

    // check if we have the original
    let origin: ServedImage
    let origFromCache = false
    // esteem-legacy originals are authoritative and unrefetchable: ignorecache/
    // invalidate still re-derives variants but never bypasses the stored original
    const bypassStoredOriginal = (options.ignorecache || options.invalidate) && !isEsteemLegacy
    // Rescued dead-origin originals are archived in the upload store under the
    // same derived key. The archive is an origin, not a cache: it is consulted
    // whenever the proxy-store original is absent or bypassed, and cache-bypass
    // flags never skip it (there is no live origin to refetch from).
    let servingStore = origStore
    let haveOriginal = await storeExistsBounded(origStore, origKey, storeSignal(), ctx.log, 'original') && !bypassStoredOriginal
    if (!haveOriginal && !usesUploadStore
        && await storeExistsBounded(uploadStore, origKey, storeSignal(), ctx.log, 'rescued original')) {
        servingStore = uploadStore
        haveOriginal = true
        ctx.tag({rescued_original: true})
    }
    // Retention archive: same contract as the upload store above — an origin,
    // not a cache — for originals migrated off local disk. A backend outage here
    // must not fail the request: fall through to the normal fetch path.
    if (!haveOriginal && retentionStore
        && await storeExistsBounded(retentionStore, origKey, storeSignal(), ctx.log, 'retention original')) {
        servingStore = retentionStore
        haveOriginal = true
        ctx.tag({retention_original: true})
    }
    if (haveOriginal) {
        origFromCache = true
        ctx.tag({store: 'original'})
        let res: NeedleResponse
        try {
            const readSignal = storeSignal()
            origin = worstOf(realImage(await readStream(
                servingStore.createReadStream({ key: origKey, signal: readSignal } as any), readSignal)), substitution)
            contentType = await mimeMagic(origin.bytes)
            // Validate stored data is actually an image — stale error pages or
            // truncated responses may have been cached by a previous request
            if (!AcceptedContentTypes.includes(contentType.toLowerCase())) {
                ctx.log.warn({ contentType, origKey, urlString }, 'stored original has invalid content type')
                // Archive stores (uploads, retention) hold irreplaceable originals —
                // never delete from them here
                if (!isArchiveStore(servingStore)) {
                    try { await storeRemove(servingStore, origKey) } catch (_e) { /* best effort */ }
                }
                throw new Error('Invalid stored content type: ' + contentType)
            }
        } catch (err) {
            ctx.tag({url: urlString})
            ctx.log.error({ err, urlString }, 'storeExist read / mimeMagic failed')
            const result = await fetchImageWithFallbacks(
                urlString,
                urlParams,
                'EcencyProxy/1.0 (+https://github.com/ecency)',
                DefaultAvatar,
                ctx.log,
                { skipNegativeCache: !!options.invalidate, deadlineAt: fetchDeadlineAt }
            )
            res = result.res
            origin = worstOf(fromFetch(result), substitution)
            if (shouldCacheOriginal(res.bytes, {image: origin, usesUploadStore, isLegacy})) {
                ctx.log.debug('storing original readStream catch %s', origKey)
                try {
                    await storeImage(origStore, origKey, origin, storeSignal())
                } catch (err) {
                    ctx.log.error({ err, origKey }, 'failed to store original proxy image (readStream catch)')
                    // Continue serving - storage failure shouldn't block response
                }
            } else {
                ctx.log.debug('not-storing original %s (upload=%s, kind=%s, legacy=%s, bytes=%d, cap=%d)',
                    origKey, usesUploadStore, origin.kind, isLegacy, res.bytes, MAX_CACHED_ORIGINAL_SIZE)
            }
            contentType = await mimeMagic(origin.bytes)
        }
    } else {
        ctx.tag({ store: 'fetch' })

        let res: NeedleResponse
        try {
            const result = await fetchImageWithFallbacks(
                urlString,
                urlParams,
                'EcencyProxy/1.0 (+https://github.com/ecency)',
                DefaultAvatar,
                ctx.log,
                { skipNegativeCache: !!options.invalidate, deadlineAt: fetchDeadlineAt }
            )
            res = result.res
            origin = worstOf(fromFetch(result), substitution)
        } catch (err) {
            ctx.log.error({ err, urlString }, 'fetchImageWithFallbacks failed')
            captureImageFailure('all_fallbacks_failed', ctx, { urlString, error: String(err) })
            throw new APIError({ code: APIError.Code.InvalidImage, info: { fallback: 'true' } })
        }

        contentType = await mimeMagic(origin.bytes)
        contentType = contentType.toLowerCase()

        if (!AcceptedContentTypes.includes(contentType)) {
            ctx.log.error({ url: urlString, type: contentType }, 'Unsupported content type, defaulted')
            captureImageFailure('unsupported_content_type', ctx, { urlString, contentType })
            // needle leaves response/read timeouts disabled by default, so this
            // could hang indefinitely, and it loops back through this service's own
            // edge stack to fetch it.
            const fallbackRes = await fetchUrl(DefaultAvatar, {
                parse_response: false,
                follow_max: 3,
                user_agent: 'EcencyProxy/1.0',
                open_timeout: FETCH_DEFAULT_OPEN_MS,
                response_timeout: FETCH_DEFAULT_RESPONSE_MS,
                read_timeout: FETCH_DEFAULT_READ_MS,
                signal: AbortSignal.timeout(FETCH_DEFAULT_WALL_MS),
            } as any)
            return await serveOrBuildFallbackImage(ctx, fallbackRes.body, {
                width: options.width, height: options.height, mode: options.mode, format: options.format,
            }, imageKey, `unsupported content type ${ contentType }, default rendered`)
        }

        APIError.assert(Buffer.isBuffer(origin.bytes), APIError.Code.InvalidImage)

        if (shouldCacheOriginal(res.bytes, {image: origin, usesUploadStore, isLegacy})) {
            ctx.log.debug('storing original image %s', origKey)
            try {
                await storeImage(origStore, origKey, origin, storeSignal())
            } catch (err) {
                ctx.log.error({ err, origKey }, 'failed to store original proxy image')
                // Continue serving - storage failure shouldn't block response
            }
        } else {
            ctx.log.debug('not-storing original %s (upload=%s, kind=%s, legacy=%s, bytes=%d, cap=%d)',
                origKey, usesUploadStore, origin.kind, isLegacy, res.bytes, MAX_CACHED_ORIGINAL_SIZE)
        }
    }

    // What goes out: a render of the origin (same provenance), or, when Sharp
    // cannot process the source, the origin's own bytes as a passthrough. The
    // value decides storage, Cache-Control and ETag below.
    let rendered: ServedImage
    let isAnimated = contentType === 'image/gif' || contentType === 'image/apng'
    if (contentType.indexOf('video') > -1) {
        rendered = origin
    } else {

        let metadata: Sharp.Metadata
        try {
            const metaResult = await getSharpMetadataWithRetry(
                origin.bytes,
                urlString,
                urlParams,
                'EcencyProxy/1.0 (+https://github.com/ecency)',
                DefaultAvatar,
                ctx.log,
                fetchDeadlineAt
            )
            metadata = metaResult.metadata
            // The retry may have swapped the bytes for the default image; the
            // provenance travels with them from here on
            origin = metaResult.isFallback
                ? fallbackImage(metaResult.buffer, 'source unreadable, default substituted')
                : derive(origin, metaResult.buffer)
            contentType = await mimeMagic(origin.bytes)
            // Only formats that can animate may say so through their page count;
            // a HEIF with an auxiliary image is a still, see isAnimatedSource
            isAnimated = isAnimatedSource(metadata, contentType)
        } catch (err) {
            ctx.log.error({ url: urlString, key: imageKey }, 'getSharpMetadataWithRetry failed')
            captureImageFailure('metadata_extraction_failed', ctx, { urlString, imageKey, origFromCache, error: String(err) })
            if (origFromCache) {
                // Archive stores (uploads, retention) hold irreplaceable originals —
                // never delete from them here either
                if (!isArchiveStore(servingStore)) {
                    ctx.log.warn({ origKey }, 'purging corrupt cached original after metadata failure')
                    try { await storeRemove(servingStore, origKey) } catch (_e) { /* best effort */ }
                }
                const fallbackRes = await fetchUrl(DefaultAvatar, {
                    parse_response: false, follow_max: 3, user_agent: 'EcencyProxy/1.0',
                    open_timeout: FETCH_DEFAULT_OPEN_MS,
                    response_timeout: FETCH_DEFAULT_RESPONSE_MS,
                    read_timeout: FETCH_DEFAULT_READ_MS,
                    signal: AbortSignal.timeout(FETCH_DEFAULT_WALL_MS),
                } as any)
                return await serveOrBuildFallbackImage(ctx, fallbackRes.body, {
                    width: options.width, height: options.height, mode: options.mode, format: options.format,
                }, imageKey, 'stored original unreadable, default rendered')
            }
            throw new APIError({ cause: err, code: APIError.Code.InvalidImage, info: { url: urlString, key: imageKey,
                    metadata: 'fallback-failed' } })
        }
        APIError.assert(metadata.width && metadata.height, APIError.Code.InvalidImage)

        // Animated sources (GIF, animated WebP, APNG) are re-rendered by a path of
        // their own, which keeps every frame or hands the source back untouched
        // (see animated.ts). A blur placeholder is not an animation: it is a ~20px
        // LQIP, so it is rendered from the first frame below rather than decoding
        // every frame to squash them into one.
        let animatedRender: {buffer: Buffer, contentType: string} | undefined
        // A render that THREW is not a passthrough decision: it may be transient,
        // and storing the source under this variant's key would freeze the
        // unresized original there for every later request.
        let animatedRenderFailed = false
        if (isAnimated && !options.blur && !isLegacy) {
            animatedRender = await renderAnimatedVariant({
                bytes: origin.bytes,
                metadata,
                options,
                acceptHeader,
                // {animated: true}: this encode walks every frame, so it must queue
                // even at thumbnail sizes, which the size-based gate would wave through.
                encode: (image) =>
                    runEncode(() => image.toBuffer(), {...options, animated: true}, clientGoneSignal(ctx)),
                log: ctx.log,
                onFramesDropped: (info) => captureImageFailure('animated_frames_dropped', ctx,
                    { urlString, imageKey, ...info }),
                onRenderFailed: () => { animatedRenderFailed = true },
            })
        }
        const clientRefusesWebp =
            !supportsWebP(acceptHeader) && !acceptsAnyImageType(acceptHeader)

        if (animatedRender && animatedRender.contentType === 'image/webp' && clientRefusesWebp) {
            // The variant for this key is WebP (its options negotiated or asked for
            // it), but THIS client enumerated the image types it reads and WebP was
            // not among them — an AVIF-only Accept, say. Hand it the source, which
            // every client can read, and do not store those bytes: the WebP variant
            // stays correct for the clients the key belongs to.
            //
            // `*/*` and `image/*` are NOT this case: a client that names no image
            // type told us nothing, so it keeps the smaller WebP.
            ctx.tag({animated: 'source-for-client-without-webp'})
            rendered = passthroughImage(origin.bytes, 'client does not accept the animated variant format')
        } else if (animatedRender) {
            ctx.tag({animated: animatedRender.contentType})
            rendered = derive(origin, animatedRender.buffer)
            contentType = animatedRender.contentType
        } else if (animatedRenderFailed) {
            // Serve the animation, but never as this key's variant: the next
            // request has to be free to try the encode again.
            ctx.tag({animated: 'render-failed'})
            rendered = passthroughImage(origin.bytes, 'animated render failed, source served uncached')
        } else if (isAnimated && !options.blur) {
            // Nothing safe or worthwhile to render: a deliberate passthrough of the
            // animation, and a real variant for this key, so every request for it
            // gets these same bytes. Legacy requests are never stored, so they are
            // never re-rendered either: the encode would be repeated per request.
            ctx.tag({animated: 'passthrough'})
            rendered = origin
        } else {
        // Reaching here with an animated source means a blur placeholder, which is
        // rendered from the first frame: `animated` stays false, so libvips decodes
        // one page instead of the whole roll.
        const image = buildSharpPipeline(origin.bytes, false, primaryPageOf(metadata))

        applyProxyResize(image, metadata, options)

        switch (options.format) {
            case OutputFormat.Match:
                // Match hands back the original bytes, which only works if the
                // client can decode the source format — see applyMatchFallbackFormat
                contentType = applyMatchFallbackFormat(image, contentType, acceptHeader, metadata.hasAlpha)
                break
            case OutputFormat.JPEG:
                image.jpeg({force: true})
                contentType = 'image/jpeg'
                break
            case OutputFormat.PNG:
                image.png({force: true})
                contentType = 'image/png'
                break
            case OutputFormat.WEBP:
                contentType = 'image/webp'
                image.webp({quality: 80, alphaQuality: 80, force: true})
                break
            case OutputFormat.AVIF:
                contentType = 'image/avif'
                image.avif({quality: 50, effort: AVIF_EFFORT, force: true})
                break
            default:
                break
        }

        // Blur placeholder: tiny ~20px wide JPEG for LQIP
        if (options.blur) {
            image.resize(20, undefined, { fit: 'inside' }).blur(2).jpeg({ quality: 15, force: true })
            contentType = 'image/jpeg'
        }

        try {
            rendered = derive(origin, await runEncode(() => image.toBuffer(), options, clientGoneSignal(ctx)))
        } catch (err) {
            if (isEncodeAborted(err)) {
                // The client gave up while we were queued. Nothing failed, and
                // there is no socket left to serve the fallback bytes to, so do
                // not walk the recovery path or report it as a Sharp failure.
                ctx.log.debug({ urlString, imageKey }, 'encode abandoned, client gone')
                throw err
            }
            ctx.log.error({ err, urlString, imageKey }, 'sharp.toBuffer() failed')
            captureImageFailure('sharp_tobuffer_failed', ctx, { urlString, imageKey, origIsUpload, origFromCache, error: String(err) })
            // Every branch below serves the unprocessed original instead of a
            // rendered variant: Sharp cannot decode or process the source (an
            // unsupported HEIF bitstream, a truncated JPEG) but browsers are
            // lenient. As a passthrough it is never stored under imageKey, which
            // would make later requests skip resizing and format negotiation, and
            // it carries its own ETag, so a client that cached it is not told
            // "not modified" by the real variant once a later render succeeds.
            const reason = 'sharp could not process the source, original bytes served'
            if (origIsUpload) {
                ctx.log.warn({ origKey }, 'serving original upload bytes after toBuffer failure')
            } else if (origFromCache) {
                ctx.log.warn({ origKey }, 'serving original bytes after toBuffer failure on cached image')
                try { await storeRemove(proxyStore, imageKey) } catch (_e) { /* best effort */ }
            } else {
                ctx.log.warn({ origKey }, 'serving original bytes after toBuffer failure on fetched image')
            }
            rendered = isFallbackImage(origin) ? origin : passthroughImage(origin.bytes, reason)
            contentType = await mimeMagic(origin.bytes)
        }
        } // end still Sharp pipeline

        // Legacy requests are never persisted (open proxy, see legacy-proxy.ts).
        // Everything else is decided by the value: storeImage writes a real render
        // and refuses a placeholder or a passthrough, whichever branch produced it.
        if (!isLegacy) {
            try {
                if (await storeImage(proxyStore, imageKey, rendered, storeSignal())) {
                    ctx.log.debug('stored converted %s', imageKey)
                }
            } catch (err) {
                ctx.log.error({ err, imageKey }, 'failed to store converted proxy image')
                // Continue serving - storage failure shouldn't block response
            }
        }

    }

    // The headers are a function of the value, not of a flag beside it
    ctx.set('Content-Type', contentType)
    // Vary on Accept header for proper content negotiation caching
    ctx.set('Vary', 'Accept')
    if (isFallbackImage(rendered)) {
        ctx.log.error({ finalUrl: urlString, reason: rendered.reason }, 'Responding with default image')
    }
    ctx.set('Cache-Control', cacheControlFor(rendered, IMMUTABLE_CACHE_CONTROL))
    ctx.set('ETag', etagFor(rendered, imageKey, rendered.bytes, rendered.bytes.length))
    ctx.body = rendered.bytes
}
