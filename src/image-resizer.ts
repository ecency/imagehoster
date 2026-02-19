// utils/image-resizer.ts
import * as Sharp from 'sharp'
import { APIError } from './error'
import { buildSharpPipeline, getProxyImageLimits, OutputFormat, ProxyOptions, safeParseInt, ScalingMode } from './utils'

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
    const image = buildSharpPipeline(origData)

    let meta: Sharp.Metadata
    let isFallback = false
    try {
        const { metadata, isFallback: fallbackUsed } = await import('./utils').then((mod) =>
            mod.getSharpMetadataWithRetry(origData, urlString, urlParams, userAgent, fallbackUrl, logger)
        )
        meta = metadata
        isFallback = fallbackUsed
    } catch (err) {
        throw new APIError({ cause: err, code: APIError.Code.InvalidImage, info: { metadata: 'read' } })
    }

    APIError.assert(meta.width && meta.height, APIError.Code.InvalidImage)

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
            image.avif({ quality: 50, effort: 4, force: true })
            break
    }

    const buffer = await image.toBuffer()
    return { buffer, contentType, isFallback }
}
