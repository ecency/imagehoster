import Sharp from 'sharp'
import {KoaContext} from './common'
import {clientGoneSignal, runEncode} from './encode-limit'
import { AVIF_EFFORT, MAX_INPUT_PIXELS } from './constants'
import {cacheControlFor, etagFor, fallbackImage} from './served-image'
import {OutputFormat, ScalingMode} from './utils'

/**
 * Renders the default image in place of a source the pipeline could not use
 * (unsupported content type, unreadable stored original) and serves it as the
 * placeholder it is: the fallback Cache-Control and the fallback ETag for the
 * requested key, derived from the value like every other response.
 */
export async function serveOrBuildFallbackImage(
    ctx: KoaContext,
    fallbackBuffer: Buffer,
    options: {
        width?: number
        height?: number
        mode: ScalingMode
        format: OutputFormat
    },
    imageKey: string,
    reason: string,
) {
    ctx.tag({handler: 'fallback'})
    ctx.log.error({ imageKey, reason }, 'serveOrBuildFallbackImage, falling back to default')

    const image = Sharp(fallbackBuffer, { limitInputPixels: MAX_INPUT_PIXELS })

    switch (options.mode) {
        case ScalingMode.Cover:
            image.rotate().resize(options.width, options.height, { fit: 'cover' })
            break
        case ScalingMode.Fit:
        default:
            image.rotate().resize(options.width, options.height, {
                fit: 'inside',
                withoutEnlargement: true,
            })
    }

    let contentType: string
    switch (options.format) {
        case OutputFormat.JPEG:
            image.jpeg({ force: true })
            contentType = 'image/jpeg'
            break
        case OutputFormat.PNG:
            image.png({ force: true })
            contentType = 'image/png'
            break
        case OutputFormat.WEBP:
            image.webp({ force: true, quality: 80, alphaQuality: 80 })
            contentType = 'image/webp'
            break
        case OutputFormat.AVIF:
            image.avif({ force: true, quality: 50, effort: AVIF_EFFORT })
            contentType = 'image/avif'
            break
        case OutputFormat.Match:
        default:
            image.jpeg({ force: true })
            contentType = 'image/jpeg'
    }

    const served = fallbackImage(await runEncode(() => image.toBuffer(), options, clientGoneSignal(ctx)), reason)

    ctx.set('Content-Type', contentType)
    ctx.set('Vary', 'Accept')
    ctx.set('Cache-Control', cacheControlFor(served, 'public,max-age=31536000,immutable'))
    ctx.set('ETag', etagFor(served, imageKey))
    ctx.body = served.bytes
}
