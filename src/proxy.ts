/** Resizing image proxy. */

import {AbstractBlobStore} from 'abstract-blob-store'
import * as config from 'config'
import {createHash} from 'crypto'
import * as etag from 'etag'
import * as multihash from 'multihashes'
import * as Sharp from 'sharp'
import streamHead from 'stream-head/dist-es6'
import {URL} from 'url'
import {imageBlacklist} from './blacklist'
import {KoaContext, proxyStore, uploadStore} from './common'
import {applyUrlReplacements, isEmptyImageUrl, startsWithEmptyImagePrefix, EMPTY_IMAGE_URL_PATTERNS} from './constants'
import {APIError} from './error'
import {serveOrBuildFallbackImage} from './fallback'
import {fetchImageWithFallbacks} from './fetch-image'
import {
    AcceptedContentTypes,
    buildSharpPipeline,
    fetchUrl,
    getDefaultUrlAndParams,
    getImageKey,
    getProxyImageLimits,
    getSharpMetadataWithRetry,
    mimeMagic,
    NeedleResponse,
    OutputFormat,
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

if (!Number.isFinite(MAX_IMAGE_SIZE)) {
    throw new Error('Invalid max image size')
}
const SERVICE_URL = new URL(config.get('service_url'))

function parseOptions(query: {[key: string]: any}, acceptHeader: string = ''): ProxyOptions {
    const width = Number.parseInt(query['width']) || undefined
    const height = Number.parseInt(query['height']) || undefined
    const ignorecache = Number.parseInt(query['ignorecache']) || undefined
    const invalidate = Number.parseInt(query['invalidate']) || undefined
    const refetch = Number.parseInt(query['refetch']) || undefined
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
    return {width, height, mode, format, ignorecache, invalidate, refetch}
}

export async function proxyHandler(ctx: KoaContext) {
    ctx.tag({handler: 'proxy'})

    APIError.assert(ctx.method === 'GET', APIError.Code.InvalidMethod)
    APIError.assertParams(ctx.params, ['url'])

    const acceptHeader = ctx.get('accept') || ''
    const options = parseOptions(ctx.query, acceptHeader)

    const cleanUrl = ctx.params.url.replace(/\.(webp|png)$/, '')
    let url = parseProxiedUrl(cleanUrl)
    let urlParams = cleanUrl
    let isDefaultImage = false

    // resolve double proxied images
    while (url.origin === SERVICE_URL.origin && url.pathname.slice(0, 2) === '/p') {
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

    if (options.ignorecache) {
        url = new URL(urlString.replace('&ignorecache=1', '').replace('?ignorecache=1', ''))
    }
    if (options.invalidate) {
        url = new URL(urlString.replace('&invalidate=1', '').replace('?invalidate=1', ''))
        await purgeCache(urlString)
    }
    if (options.refetch) {
        url = new URL(urlString.replace('&refetch=1', '').replace('?refetch=1', ''))
    }
    urlString = url.toString()
    ctx.tag({ normalizedUrl: urlString })

    // Check if URL is in blocklist or is exactly the empty 0x0 URL (not URLs that start with it)
    if (imageBlacklist.includes(urlString) || isEmptyImageUrl(urlString)) {
        ({ url, urlParams } = getDefaultUrlAndParams())
        isDefaultImage = true
        ctx.log.error({ msg: 'Falling back to default image due to blacklist or 0x0 URL', urlString })
    }

    // Handle URLs that start with 0x0/ but have additional content (like proxied URLs)
    if (startsWithEmptyImagePrefix(urlString)) {
        // Extract the actual URL after the prefix
        const actualUrl = urlString.substring(EMPTY_IMAGE_URL_PATTERNS[0].length)
        if (actualUrl && actualUrl.length > 0) {
            try {
                url = new URL(actualUrl)
                urlString = url.toString()
                ctx.log.debug({ originalUrl: urlString, extractedUrl: actualUrl }, 'Extracted URL from 0x0 prefix')
            } catch (err) {
                ctx.log.error({ err, msg: 'Failed to parse URL after 0x0 prefix', originalUrl: urlString })
            }
        }
    }
    urlString = url.toString()
    urlString = applyUrlReplacements(urlString)
    url = new URL(urlString)
    // Ecency team does not own esteem.ws domain anymore, assume steemit has images from those old domain
    if (urlString.includes('https://img.esteem.ws/')) {
        urlString = `https://steemitimages.com/0x0/${urlString}`
    }
    // where the original image is/will be stored
    let origStore: AbstractBlobStore
    let origKey: string
    let contentType: string
    ctx.originalUrl = urlString
    const origIsUpload = SERVICE_URL.origin === url.origin && url.pathname[1] === 'D'
    ctx.tag({is_upload: origIsUpload})
    if (origIsUpload) {
        // if we are proxying our or own image, use the uploadStore directly
        // to avoid storing two copies of the same data
        origStore = uploadStore
        origKey = url.pathname.slice(1).split('/')[0]
    } else {
        const urlHash = createHash('sha1')
            .update(urlString)
            .digest()
        origStore = proxyStore
        origKey = 'U' + multihash.toB58String(
            multihash.encode(urlHash, 'sha1')
        )
    }
    const imageKey = getImageKey(origKey, options)
    ctx.set('ETag', etag(imageKey))
    // check if content is same with user cache
    if (ctx.fresh) {
        ctx.status = 304
        return
    }
    ctx.tag({imageKey})
    if (options.refetch) {
        try {
            await storeRemove(proxyStore, imageKey)
            await purgeCache(urlString)
            ctx.log.debug({ image: imageKey }, 'removed original file')
        } catch (err) {
            ctx.log.error({err, msg: 'unable to remove on refetch', imageKey})
        }
        if (!origIsUpload) {
            try {
                await storeRemove(origStore, origKey)
                await purgeCache(urlString)
                ctx.log.debug({ image: origKey }, 'removed original file')
            } catch (err) {
                ctx.log.error({err, origKey, msg: 'unable to remove on refetch non orig'})
            }
        }
        ctx.tag({ refetch: true })
    }
    // check if we already have a converted image for a requested key
    if (await storeExists(proxyStore, imageKey) && !options.ignorecache && !options.invalidate && !options.refetch) {
        ctx.tag({store: 'resized'})
        ctx.log.debug('streaming %s from store', imageKey)
        const file = proxyStore.createReadStream(imageKey)
        file.on('error', async (err) => {
            ctx.log.error({err, msg: 'unable to read', imageKey})
            try {
                await storeRemove(proxyStore, imageKey)
                ctx.log.debug({ image: imageKey }, 'removed resized imageKey file')
            } catch (err) {
                ctx.log.error({err, msg: 'unable to remove onerror', imageKey})
            }
            file.destroy()
            ctx.res.writeHead(500, 'Internal Error')
            ctx.res.end()
        })
        const {head, stream} = await streamHead(file, {bytes: 16384})
        const mimeType = await mimeMagic(head)
        ctx.set('Content-Type', mimeType)
        ctx.set('Cache-Control', 'public,max-age=31536000,immutable')
        ctx.body = stream
        return
    }

    // check if we have the original
    let origData: Buffer
    let origFromCache = false
    if (await storeExists(origStore, origKey) && !options.ignorecache && !options.invalidate && !options.refetch) {
        origFromCache = true
        ctx.tag({store: 'original'})
        let res: NeedleResponse
        try {
            origData = await readStream(origStore.createReadStream(origKey))
            contentType = await mimeMagic(origData)
            // Validate stored data is actually an image — stale error pages or
            // truncated responses may have been cached by a previous request
            if (!AcceptedContentTypes.includes(contentType.toLowerCase())) {
                ctx.log.warn({contentType, origKey, urlString, msg: 'stored original has invalid content type, purging and re-fetching'})
                try { await storeRemove(origStore, origKey) } catch (_e) { /* best effort */ }
                throw new Error('Invalid stored content type: ' + contentType)
            }
        } catch (err) {
            ctx.tag({url: urlString})
            ctx.log.error({err, urlString, msg: 'storeExist read / mimeMagic failed'})
            const result = await fetchImageWithFallbacks(
                urlString,
                urlParams,
                'EcencyProxy/1.0 (+https://github.com/ecency)',
                DefaultAvatar,
                ctx.log
            )
            res = result.res
            if (result.isFallback) { isDefaultImage = true }
            origData = res.body
            if (res.bytes <= MAX_IMAGE_SIZE && !isDefaultImage) {
                ctx.log.debug('storing original readStream catch %s', origKey)
                try {
                    await storeWrite(origStore, origKey, origData)
                } catch (err) {
                    ctx.log.error({ err, origKey }, 'failed to store original proxy image (readStream catch)')
                    // Continue serving - storage failure shouldn't block response
                }
            } else {
                ctx.log.debug('not-storing PayloadTooLarge original %s', origKey)
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
                ctx.log
            )
            res = result.res
            isDefaultImage = result.isFallback
        } catch (err) {
            ctx.log.error({ err, urlString, msg: 'fetchImageWithFallbacks failed'})
            throw new APIError({ code: APIError.Code.InvalidImage, info: { fallback: 'true' } })
        }

        origData = res.body
        contentType = await mimeMagic(origData)
        contentType = contentType.toLowerCase()

        if (!AcceptedContentTypes.includes(contentType)) {
            ctx.log.error({ url: urlString, type: contentType, msg: 'Unsupported content type, defaulted'})
            const fallbackRes = await fetchUrl(DefaultAvatar, {
                parse_response: false,
                follow_max: 3,
                user_agent: 'EcencyProxy/1.0',
            })
            const fallbackBuffer = fallbackRes.body
            isDefaultImage = true
            return await serveOrBuildFallbackImage(
                ctx,
                proxyStore,
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

        if (res.bytes <= MAX_IMAGE_SIZE && !isDefaultImage) {
            ctx.log.debug('storing original image %s', origKey)
            try {
                await storeWrite(origStore, origKey, origData)
            } catch (err) {
                ctx.log.error({ err, origKey }, 'failed to store original proxy image')
                // Continue serving - storage failure shouldn't block response
            }
        } else {
            ctx.log.debug('not-storing PayloadTooLarge original %s', origKey)
        }
    }

    let rv: Buffer
    if ((contentType === 'image/gif' || contentType === 'video/mp4' || contentType === 'image/apng') &&
        (options.format === OutputFormat.Match || options.format === OutputFormat.WEBP || options.format === OutputFormat.AVIF) &&
        options.mode === ScalingMode.Fit
    ) {
        // pass through GIF if requested with the original size
        // this is needed since resizing GIFs creates still images
        rv = origData
    } else if (contentType.indexOf('video') > -1) {
        rv = origData
    } else {

        const image = buildSharpPipeline(origData)
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
            // We don't replace `origData` with `metaResult.buffer` because the Sharp pipeline
            // has already been initialized with the original buffer.
            // The fallback fetch is used solely to get metadata in case the original fails.

            metadata = metaResult.metadata
            if (!isDefaultImage && metaResult.isFallback) {
                isDefaultImage = true
            }
        } catch (err) {
            ctx.log.error({ url: urlString, key: imageKey, msg: 'getSharpMetadataWithRetry failed'})
            if (origFromCache) {
                ctx.log.warn({origKey, msg: 'purging corrupt cached original after metadata failure'})
                try { await storeRemove(origStore, origKey) } catch (_e) { /* best effort */ }
                const fallbackRes = await fetchUrl(DefaultAvatar, {
                    parse_response: false, follow_max: 3, user_agent: 'EcencyProxy/1.0',
                })
                return await serveOrBuildFallbackImage(ctx, proxyStore, fallbackRes.body, {
                    width: options.width, height: options.height, mode: options.mode, format: options.format,
                })
            }
            throw new APIError({ cause: err, code: APIError.Code.InvalidImage, info: { url: urlString, key: imageKey,
                    metadata: 'fallback-failed' } })
        }
        APIError.assert(metadata.width && metadata.height, APIError.Code.InvalidImage)

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
                image.rotate().resize(width, height, {fit: 'cover'})
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
                image.avif({quality: 50, effort: 4, force: true})
                break
            default:
                break
        }

        try {
            rv = await image.toBuffer()
        } catch (err) {
            ctx.log.error({ err, urlString, imageKey, msg: 'sharp.toBuffer() failed' })
            if (origFromCache) {
                ctx.log.warn({origKey, msg: 'purging corrupt cached original after toBuffer failure'})
                try { await storeRemove(origStore, origKey) } catch (_e) { /* best effort */ }
                const fallbackRes = await fetchUrl(DefaultAvatar, {
                    parse_response: false, follow_max: 3, user_agent: 'EcencyProxy/1.0',
                })
                return await serveOrBuildFallbackImage(ctx, proxyStore, fallbackRes.body, {
                    width: options.width, height: options.height, mode: options.mode, format: options.format,
                })
            }
            isDefaultImage = true
            throw new APIError({ cause: err, code: APIError.Code.InvalidImage })
        }

        if (!isDefaultImage) {
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
        ctx.log.error({ msg: 'Responding with default image', finalUrl: urlString })
        ctx.set('Cache-Control', 'public,max-age=600') // 10 minutes
    } else {
        ctx.set('Cache-Control', 'public,max-age=31536000,immutable') // 1 year
    }
    ctx.body = rv
}
