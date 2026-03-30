// utils/image-resizer.ts
import Sharp from 'sharp'
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
    logger: any
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

    // Animated images (GIF/APNG): skip Sharp pipeline entirely to preserve animation.
    // Sharp resize can strip frames even with animated:true, so passthrough is the only safe option.
    if (isAnimated) {
        return { buffer: origData, contentType, isFallback }
    }

    const image = buildSharpPipeline(origData, isAnimated)

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
            image.avif({ quality: 50, effort: 3, force: true })
            break
    }

    const buffer = await image.toBuffer()
    return { buffer, contentType, isFallback }
}
