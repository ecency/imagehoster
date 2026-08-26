/** Resizing image proxy. */

import {AbstractBlobStore} from 'abstract-blob-store'
import config from 'config'
import {createHash} from 'crypto'
import etag from 'etag'
import * as multihash from 'multihashes'
import Sharp from 'sharp'
import streamHead from 'stream-head/dist-es6'
import {URL} from 'url'
import {isArchiveStore, KoaContext, proxyStore, retentionStore, uploadStore} from './common'
import { AVIF_EFFORT, EMPTY_IMAGE_URL_PATTERNS, applyUrlReplacements, MAX_CACHED_ORIGINAL_SIZE, MAX_INPUT_PIXELS } from './constants'
import {APIError} from './error'
import {serveOrBuildFallbackImage} from './fallback'
import {clientGoneSignal, isEncodeAborted, runEncode} from './encode-limit'
import {fetchImageWithFallbacks} from './fetch-image'
import {captureImageFailure} from './sentry'
import {
    AcceptedContentTypes,
    applyMatchFallbackFormat,
    assertPublicUrl,
    buildSharpPipeline,
    fetchUrl,
    getDefaultUrlAndParams,
    getImageKey,
    getProxyImageLimits,
    getSharpMetadataWithRetry,
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
    safeParseInt,
    ScalingMode,
    storeExists,
    storeRemove,
    storeWrite,
    supportsAvif,
    supportsWebP
} from './utils'

const MAX_IMAGE_SIZE = Number.parseInt(config.get('max_image_size'))
const DefaultAvatar = config.get('default_avatar') as string
const INVALIDATE_TOKEN = config.has('invalidate_token')
    ? config.get('invalidate_token') as string
    : ''

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
    opts: {isDefaultImage: boolean, usesUploadStore: boolean, isLegacy: boolean},
    cap: number = MAX_CACHED_ORIGINAL_SIZE,
): boolean {
    if (opts.isDefaultImage || opts.usesUploadStore || opts.isLegacy) { return false }
    // A cap of 0 means "never cache originals". Checked before the comparison
    // because `0 <= 0` would otherwise let a zero-byte body through.
    if (cap <= 0) { return false }
    return bytes <= MAX_IMAGE_SIZE && bytes <= cap
}
const SERVICE_URL = new URL(config.get('service_url'))

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
 * decode its format. Animated sources and encode failures fall back to the
 * cached bytes: an image that one client cannot render beats a failed request.
 */
async function convertCachedMatchVariant(
    ctx: KoaContext,
    cached: Buffer,
    mimeType: string,
    acceptHeader: string,
    options: ProxyOptions
): Promise<{buffer: Buffer, contentType: string}> {
    try {
        const metadata = await Sharp(cached, { limitInputPixels: MAX_INPUT_PIXELS }).metadata()
        if (metadata.pages != null && metadata.pages > 1) {
            // Transcoding an animated source here would drop its frames
            return {buffer: cached, contentType: mimeType}
        }
        const image = buildSharpPipeline(cached, false)
        const contentType = applyMatchFallbackFormat(image, mimeType, acceptHeader, metadata.hasAlpha)
        const buffer = await runEncode(() => image.toBuffer(), options, clientGoneSignal(ctx))
        ctx.log.debug({ mimeType, contentType }, 'converted cached match variant for client')
        return {buffer, contentType}
    } catch (err) {
        if (isEncodeAborted(err)) {
            throw err
        }
        ctx.log.error({ err, mimeType }, 'failed to convert cached match variant')
        return {buffer: cached, contentType: mimeType}
    }
}

export async function proxyHandler(ctx: KoaContext) {
    ctx.tag({handler: 'proxy'})

    APIError.assert(ctx.method === 'GET', APIError.Code.InvalidMethod)
    APIError.assertParams(ctx.params, ['url'])

    const acceptHeader = ctx.get('accept') || ''
    const isLegacy = ctx.query['_src'] === 'legacy'
    const options = parseOptions(ctx.query, acceptHeader)
    const shouldBypassCache = !!(options.ignorecache || options.invalidate)
    if (options.invalidate) {
        const invalidateKey = ctx.get('x-invalidate-key')
        APIError.assert(
            INVALIDATE_TOKEN && invalidateKey && invalidateKey === INVALIDATE_TOKEN,
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
    let isDefaultImage = false

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
        isDefaultImage = true
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
    ctx.set('ETag', etag(imageKey))
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
    // check if content is same with user cache
    if (ctx.fresh && !shouldBypassCache) {
        ctx.status = 304
        return
    }
    // check if we already have a converted image for a requested key
    if (await storeExists(proxyStore, imageKey) && !options.ignorecache && !options.invalidate) {
        ctx.tag({store: 'resized'})
        ctx.log.debug('streaming %s from store', imageKey)
        const file = proxyStore.createReadStream(imageKey)
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
        const {head, stream} = await streamHead(file, {bytes: 16384})
        const mimeType = await mimeMagic(head)
        // Match variants are one bucket for every client that negotiated neither
        // AVIF nor WebP, so a stored AVIF/HEIF passthrough can be undecodable for
        // the client asking now. Convert the cached bytes rather than falling
        // through to the origin: the variant is already sized, and the original
        // may have been pruned or its remote host may be down.
        if (options.format === OutputFormat.Match && needsMatchFallback(mimeType, acceptHeader)) {
            ctx.tag({match_fallback: true})
            const cached = await readStream(stream)
            const served = await convertCachedMatchVariant(ctx, cached, mimeType, acceptHeader, options)
            ctx.set('Content-Type', served.contentType)
            ctx.set('Vary', 'Accept')
            ctx.set('Cache-Control', 'public,max-age=31536000,immutable')
            ctx.body = served.buffer
            return
        } else {
            ctx.set('Content-Type', mimeType)
            ctx.set('Vary', 'Accept')
            ctx.set('Cache-Control', 'public,max-age=31536000,immutable')
            ctx.body = stream
            return
        }
    }

    // check if we have the original
    let origData: Buffer
    let origFromCache = false
    // esteem-legacy originals are authoritative and unrefetchable: ignorecache/
    // invalidate still re-derives variants but never bypasses the stored original
    const bypassStoredOriginal = (options.ignorecache || options.invalidate) && !isEsteemLegacy
    // Rescued dead-origin originals are archived in the upload store under the
    // same derived key. The archive is an origin, not a cache: it is consulted
    // whenever the proxy-store original is absent or bypassed, and cache-bypass
    // flags never skip it (there is no live origin to refetch from).
    let servingStore = origStore
    let haveOriginal = await storeExists(origStore, origKey) && !bypassStoredOriginal
    if (!haveOriginal && !usesUploadStore && await storeExists(uploadStore, origKey)) {
        servingStore = uploadStore
        haveOriginal = true
        ctx.tag({rescued_original: true})
    }
    // Retention archive: same contract as the upload store above — an origin,
    // not a cache — for originals migrated off local disk. A backend outage here
    // must not fail the request: fall through to the normal fetch path.
    if (!haveOriginal && retentionStore) {
        try {
            if (await storeExists(retentionStore, origKey)) {
                servingStore = retentionStore
                haveOriginal = true
                ctx.tag({retention_original: true})
            }
        } catch (err) {
            ctx.log.warn({ err, origKey }, 'retention store lookup failed, falling through')
        }
    }
    if (haveOriginal) {
        origFromCache = true
        ctx.tag({store: 'original'})
        let res: NeedleResponse
        try {
            origData = await readStream(servingStore.createReadStream(origKey))
            contentType = await mimeMagic(origData)
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
                { skipNegativeCache: !!options.invalidate }
            )
            res = result.res
            if (result.isFallback) { isDefaultImage = true }
            origData = res.body
            // Don't write fallback data to uploadStore — could corrupt original hash
            if (shouldCacheOriginal(res.bytes, {isDefaultImage, usesUploadStore, isLegacy})) {
                ctx.log.debug('storing original readStream catch %s', origKey)
                try {
                    await storeWrite(origStore, origKey, origData)
                } catch (err) {
                    ctx.log.error({ err, origKey }, 'failed to store original proxy image (readStream catch)')
                    // Continue serving - storage failure shouldn't block response
                }
            } else {
                ctx.log.debug('not-storing original %s (upload=%s, default=%s, legacy=%s, bytes=%d, cap=%d)',
                    origKey, usesUploadStore, isDefaultImage, isLegacy, res.bytes, MAX_CACHED_ORIGINAL_SIZE)
            }
            contentType = await mimeMagic(origData)
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
                { skipNegativeCache: !!options.invalidate }
            )
            res = result.res
            isDefaultImage = result.isFallback
        } catch (err) {
            ctx.log.error({ err, urlString }, 'fetchImageWithFallbacks failed')
            captureImageFailure('all_fallbacks_failed', ctx, { urlString, error: String(err) })
            throw new APIError({ code: APIError.Code.InvalidImage, info: { fallback: 'true' } })
        }

        origData = res.body
        contentType = await mimeMagic(origData)
        contentType = contentType.toLowerCase()

        if (!AcceptedContentTypes.includes(contentType)) {
            ctx.log.error({ url: urlString, type: contentType }, 'Unsupported content type, defaulted')
            captureImageFailure('unsupported_content_type', ctx, { urlString, contentType })
            const fallbackRes = await fetchUrl(DefaultAvatar, {
                parse_response: false,
                follow_max: 3,
                user_agent: 'EcencyProxy/1.0',
            })
            const fallbackBuffer = fallbackRes.body
            isDefaultImage = true
            return await serveOrBuildFallbackImage(
                ctx,
                fallbackBuffer,
                {
                    width: options.width,
                    height: options.height,
                    mode: options.mode,
                    format: options.format,
                }
            )
        }

        APIError.assert(Buffer.isBuffer(origData), APIError.Code.InvalidImage)

        // Don't write fallback data to uploadStore — could corrupt original hash
        if (shouldCacheOriginal(res.bytes, {isDefaultImage, usesUploadStore, isLegacy})) {
            ctx.log.debug('storing original image %s', origKey)
            try {
                await storeWrite(origStore, origKey, origData)
            } catch (err) {
                ctx.log.error({ err, origKey }, 'failed to store original proxy image')
                // Continue serving - storage failure shouldn't block response
            }
        } else {
            ctx.log.debug('not-storing original %s (upload=%s, default=%s, legacy=%s, bytes=%d, cap=%d)',
                origKey, usesUploadStore, isDefaultImage, isLegacy, res.bytes, MAX_CACHED_ORIGINAL_SIZE)
        }
    }

    let rv: Buffer
    // Set when Sharp failed and we fall back to serving the original bytes; those
    // are not a rendered variant and must not be cached as one.
    let encodeFallback = false
    let isAnimated = contentType === 'image/gif' || contentType === 'image/apng'
    if (contentType.indexOf('video') > -1) {
        rv = origData
    } else {

        let metadata: Sharp.Metadata
        try {
            const metaResult = await getSharpMetadataWithRetry(
                origData,
                urlString,
                urlParams,
                'EcencyProxy/1.0 (+https://github.com/ecency)',
                DefaultAvatar,
                ctx.log
            )
            metadata = metaResult.metadata
            origData = metaResult.buffer
            contentType = await mimeMagic(origData)
            // Use metadata.pages when available; if null, fall back to content-type detection
            // (conservative: assume GIF/APNG are animated when pages can't be determined)
            const isGifOrApng = contentType === 'image/gif' || contentType === 'image/apng'
            if (metadata.pages != null) {
                isAnimated = metadata.pages > 1
            } else {
                isAnimated = isGifOrApng
            }
            if (metaResult.isFallback) {
                isDefaultImage = true
            }
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
                })
                return await serveOrBuildFallbackImage(ctx, fallbackRes.body, {
                    width: options.width, height: options.height, mode: options.mode, format: options.format,
                })
            }
            throw new APIError({ cause: err, code: APIError.Code.InvalidImage, info: { url: urlString, key: imageKey,
                    metadata: 'fallback-failed' } })
        }
        APIError.assert(metadata.width && metadata.height, APIError.Code.InvalidImage)

        // Animated images (GIF/APNG): skip Sharp pipeline entirely to preserve animation.
        // Sharp resize can strip frames even with animated:true, so passthrough is the only safe option.
        if (isAnimated && !options.blur) {
            rv = origData
        } else {
        const image = buildSharpPipeline(origData, isAnimated)

        const { maxWidth, maxHeight, maxCustomWidth, maxCustomHeight } = getProxyImageLimits()
        let width: number | undefined = safeParseInt(options.width)
        let height: number | undefined = safeParseInt(options.height)

        // Cap user-specified dimensions against custom limits
        if (width !== undefined && width > 0) {
          if (width > maxCustomWidth) { width = maxCustomWidth }
        }
        if (height !== undefined && height > 0) {
          if (height > maxCustomHeight) { height = maxCustomHeight }
        }

        // When neither dimension is specified by the user, cap oversized images
        // to default max limits to save bandwidth. Only apply when BOTH are
        // unspecified — if one dimension is set, the other should auto-calculate
        // from aspect ratio to avoid unnatural crops.
        const bothUnspecified = (width === undefined || width === 0) && (height === undefined || height === 0)
        if (bothUnspecified) {
          if (metadata.width && metadata.width > maxWidth) { width = maxWidth }
          if (metadata.height && metadata.height > maxHeight) { height = maxHeight }
        }

        // Convert 0 to undefined for Sharp (means auto-calculate based on aspect ratio)
        if (width === 0) { width = undefined }
        if (height === 0) { height = undefined }

        switch (options.mode) {
            case ScalingMode.Cover:
                if (bothUnspecified) {
                    // User didn't request specific dimensions — preserve aspect ratio
                    image.rotate().resize(width, height, { fit: 'inside', withoutEnlargement: true })
                } else {
                    image.rotate().resize(width, height, {fit: 'cover'})
                }
                break
            case ScalingMode.Fit:
                // Only set defaults if BOTH dimensions are undefined
                // If one dimension is defined, Sharp will auto-calculate the other
                if (width === undefined && height === undefined) {
                    width = maxWidth
                    height = maxHeight
                }

                image.rotate().resize(width, height, { fit: 'inside', withoutEnlargement: true })
                break
        }

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
            rv = await runEncode(() => image.toBuffer(), options, clientGoneSignal(ctx))
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
            // rendered variant. Storing those bytes under imageKey would make
            // later requests skip resizing and format negotiation entirely, so
            // the variant write is suppressed.
            encodeFallback = true
            if (origIsUpload) {
                // Sharp can't decode this image (e.g. unsupported HEIF/AVIF bitstream)
                // but browsers likely can — serve the original unresized bytes
                ctx.log.warn({ origKey }, 'serving original upload bytes after toBuffer failure')
                rv = origData
                contentType = await mimeMagic(origData)
            } else if (origFromCache) {
                // Sharp can't process this image (e.g. truncated JPEG) but browsers
                // are lenient and will render it fine — serve the original bytes
                ctx.log.warn({ origKey }, 'serving original bytes after toBuffer failure on cached image')
                try { await storeRemove(proxyStore, imageKey) } catch (_e) { /* best effort */ }
                rv = origData
                contentType = await mimeMagic(origData)
            } else {
                // Sharp can't process but browsers are lenient — serve original bytes
                ctx.log.warn({ origKey }, 'serving original bytes after toBuffer failure on fetched image')
                rv = origData
                contentType = await mimeMagic(origData)
            }
        }
        } // end non-animated Sharp pipeline

        if (!isDefaultImage && !isLegacy && !encodeFallback) {
            ctx.log.debug('storing converted %s', imageKey)
            try {
                await storeWrite(proxyStore, imageKey, rv)
            } catch (err) {
                ctx.log.error({ err, imageKey }, 'failed to store converted proxy image')
                // Continue serving - storage failure shouldn't block response
            }
        }

    }

    ctx.set('Content-Type', contentType)
    // Vary on Accept header for proper content negotiation caching
    ctx.set('Vary', 'Accept')
    if (isDefaultImage) {
        ctx.log.error({ finalUrl: urlString }, 'Responding with default image')
        ctx.set('Cache-Control', 'public,max-age=600') // 10 minutes
    } else {
        ctx.set('Cache-Control', 'public,max-age=31536000,immutable') // 1 year
    }
    ctx.body = rv
}
