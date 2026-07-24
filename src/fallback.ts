import etag from 'etag'
import Sharp from 'sharp'
import {KoaContext} from './common'
import {clientGoneSignal, runEncode} from './encode-limit'
import { AVIF_EFFORT, MAX_INPUT_PIXELS } from './constants'
import {getImageKey, OutputFormat, ProxyOptions, ScalingMode} from './utils'

export async function serveOrBuildFallbackImage(
    ctx: KoaContext,
    fallbackBuffer: Buffer,
    options: {
        width?: number
        height?: number
        mode: ScalingMode
        format: OutputFormat
    },
    keyPrefix = 'default-avatar',
) {
    ctx.tag({handler: 'fallback'})
    const fallbackKey = getImageKey(keyPrefix, options as ProxyOptions)
    ctx.set('ETag', etag(fallbackKey))
    ctx.log.error({ fallbackKey }, 'serveOrBuildFallbackImage, falling back to default')

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

    const rv = await runEncode(() => image.toBuffer(), options, clientGoneSignal(ctx))

    ctx.set('Content-Type', contentType)
    ctx.set('Vary', 'Accept')
    ctx.set('Cache-Control', 'public,max-age=600')
    ctx.body = rv
}
