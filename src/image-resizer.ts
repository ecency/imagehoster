// utils/image-resizer.ts
import Sharp from 'sharp'
import { runEncode } from './encode-limit'
import { AVIF_EFFORT } from './constants'
import { APIError } from './error'
import {
    buildSharpPipeline, getProxyImageLimits, mimeMagic,
    OutputFormat, ProxyOptions, safeParseInt, ScalingMode,
} from './utils'

export async function resizeImageWithOptions(
    origData: Buffer,
    contentType: string,
    options: ProxyOptions,
    urlString: string,
    urlParams: string,
    userAgent: string,
    fallbackUrl: string,
    logger: any,
    // Required, not optional: a request-backed resize must say whether its client
    // is still there. Leaving it optional let a caller silently omit it and
    // reintroduce unremovable queue waiters. Pass `undefined` deliberately for
    // non-request callers.
    signal: AbortSignal | undefined,
    // Avatars and covers are fixed-size profile images that do not need animation.
    // When true, an animated source is flattened to its first frame instead of
    // passed through — far cheaper to decode/store and it keeps large animated
    // GIFs out of worker memory.
    forceStill: boolean = false,
): Promise<{ buffer: Buffer; contentType: string; isFallback: boolean }> {
    let isAnimated = contentType === 'image/gif' || contentType === 'image/apng'

    let meta: Sharp.Metadata
    let isFallback = false
    try {
        const { metadata, buffer, isFallback: fallbackUsed } = await import('./utils').then((mod) =>
            mod.getSharpMetadataWithRetry(origData, urlString, urlParams, userAgent, fallbackUrl, logger)
        )
        meta = metadata
        isFallback = fallbackUsed
        origData = buffer
        contentType = await mimeMagic(origData)
        // Use metadata.pages when available; if null, fall back to content-type detection
        // (conservative: assume GIF/APNG are animated when pages can't be determined)
        const isGifOrApng = contentType === 'image/gif' || contentType === 'image/apng'
        if (metadata.pages != null) {
            isAnimated = metadata.pages > 1
        } else {
            isAnimated = isGifOrApng
        }
    } catch (err) {
        throw new APIError({ cause: err, code: APIError.Code.InvalidImage, info: { metadata: 'read' } })
    }

    APIError.assert(meta.width && meta.height, APIError.Code.InvalidImage)

    // Animated images (GIF/APNG): preserve animation by passing the original
    // through untouched — Sharp resize can strip frames even with animated:true.
    // Callers that set forceStill (avatars/covers) opt out and fall through to
    // render only the first frame below.
    if (isAnimated && !forceStill) {
        return { buffer: origData, contentType, isFallback }
    }

    // First frame only. Reaching here with isAnimated true implies forceStill, so
    // we never decode every frame — that is the memory-heavy path we are avoiding.
    const image = buildSharpPipeline(origData, false)

    const { maxWidth, maxHeight, maxCustomWidth, maxCustomHeight } = getProxyImageLimits()
    let width = safeParseInt(options.width)
    let height = safeParseInt(options.height)

    if (width) {
        width = Math.min(width, maxCustomWidth)
    } else if (meta.width) {
        width = Math.min(meta.width, maxWidth)
    }

    if (height) {
        height = Math.min(height, maxCustomHeight)
    } else if (meta.height) {
        height = Math.min(meta.height, maxHeight)
    }

    switch (options.mode) {
        case ScalingMode.Cover:
            image.rotate().resize(width, height, { fit: 'cover' })
            break
        case ScalingMode.Fit:
            image.rotate().resize(width || maxWidth, height || maxHeight, {
                fit: 'inside',
                withoutEnlargement: true,
            })
            break
    }

    switch (options.format) {
        case OutputFormat.Match:
            if (contentType === 'image/svg+xml' || contentType === 'image/svg') {
                contentType = 'image/png'
                image.png({ quality: 80, compressionLevel: 9, force: true })
            } else if (contentType === 'image/heic' || contentType === 'image/heif') {
                contentType = 'image/jpeg'
                image.jpeg({ quality: 80, force: true })
            } else if (forceStill && isAnimated) {
                // Client negotiated neither WebP nor AVIF: emit a still PNG so we
                // never ship a (single-frame) GIF from a flattened animation.
                // quality is a no-op for full-colour PNG (only palette mode), so
                // only compressionLevel is set.
                contentType = 'image/png'
                image.png({ compressionLevel: 9, force: true })
            }
            break
        case OutputFormat.WEBP:
            contentType = 'image/webp'
            image.webp({ quality: 80, alphaQuality: 80 })
            break
        case OutputFormat.JPEG:
            contentType = 'image/jpeg'
            image.jpeg({ quality: 80, force: true })
            break
        case OutputFormat.PNG:
            contentType = 'image/png'
            image.png({ quality: 80, force: true, compressionLevel: 9 })
            break
        case OutputFormat.AVIF:
            contentType = 'image/avif'
            image.avif({ quality: 50, effort: AVIF_EFFORT, force: true })
            break
    }

    const buffer = await runEncode(() => image.toBuffer(), options, signal)
    return { buffer, contentType, isFallback }
}
