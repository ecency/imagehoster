import {AbstractBlobStore} from 'abstract-blob-store'
import * as etag from 'etag'
import * as Sharp from 'sharp'
import streamHead from 'stream-head/dist-es6'
import {KoaContext} from './common'
import {getImageKey, mimeMagic, OutputFormat, ProxyOptions, ScalingMode, storeExists, storeWrite} from './utils'

export async function serveOrBuildFallbackImage(
    ctx: KoaContext,
    store: AbstractBlobStore,
    fallbackBuffer: Buffer,
    options: {
        width?: number
        height?: number
        mode: ScalingMode
        format: OutputFormat
    },
    keyPrefix = 'default-avatar'
) {
    ctx.tag({handler: 'fallback'})
    const fallbackKey = getImageKey(keyPrefix, options as ProxyOptions)
    ctx.set('ETag', etag(fallbackKey))
    ctx.log.error({ fallbackKey, msg: 'serveOrBuildFallbackImage, falling back to default'})

    // If already exists in store
    if (await storeExists(store, fallbackKey)) {
        ctx.log.error('streaming fallback %s from store', fallbackKey)
        const file = store.createReadStream(fallbackKey)
        const { head, stream } = await streamHead(file, { bytes: 16384 })
        const mimeType = await mimeMagic(head)
        ctx.set('Content-Type', mimeType)
        ctx.set('Cache-Control', 'public,max-age=600')
        ctx.body = stream
        return
    }

    // Else: build and store
    const image = Sharp(fallbackBuffer)

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
        case OutputFormat.Match:
        default:
            image.jpeg({ force: true })
            contentType = 'image/jpeg'
    }

    const rv = await image.toBuffer()
    try {
        await storeWrite(store, fallbackKey, rv)
    } catch (err) {
        ctx.log.error({ err, fallbackKey }, 'failed to store fallback image')
        // Continue serving - storage failure shouldn't block response
    }

    ctx.set('Content-Type', contentType)
    ctx.set('Cache-Control', 'public,max-age=600')
    ctx.body = rv
}
