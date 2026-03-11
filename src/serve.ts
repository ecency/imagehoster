/** Serve files from upload store. */

import {readStream} from './utils'
import {KoaContext, uploadStore} from './common'
import {APIError} from './error'
import {imageBlacklist} from './blacklist'
import {DEFAULT_AVATAR_HASH, isEmptyImageUrl, SERVICE_BASE_URL} from './constants'
import {fetchUrl, NeedleResponse} from './utils'
import Sharp from 'sharp'

function detectMimeType(metadata: Sharp.Metadata): string {
    switch (metadata.format) {
        case 'jpeg':
            return 'image/jpeg'
        case 'png':
            return 'image/png'
        case 'webp':
            return 'image/webp'
        case 'gif':
            return 'image/gif'
        case 'svg':
            return 'image/svg+xml'
        case 'heif':
            return 'image/heif'
        case 'avif':
            return 'image/avif'
        default:
            return 'application/octet-stream'
    }
}

export async function serveHandler(ctx: KoaContext) {
    ctx.tag({handler: 'serve'})

    APIError.assert(ctx.method === 'GET', APIError.Code.InvalidMethod)
    APIError.assertParams(ctx.params, ['hash'])

    let _hash = ctx.params['hash']
    const _filename = ctx.params['filename']

    const urlString = `${SERVICE_BASE_URL}/${_hash}/${_filename}`
    if (imageBlacklist.includes(urlString) || isEmptyImageUrl(urlString)) {
        _hash = DEFAULT_AVATAR_HASH
    }

    let buffer: Buffer
    try {
        buffer = await readStream(uploadStore.createReadStream(_hash))
    } catch (error) {
        // fallback to Hive/Steemit if not found locally
        try {
            ctx.log.debug({url: ctx.params['hash']}, 'fetching from hive.blog image')
            let res: NeedleResponse = await fetchUrl(`https://images.hive.blog/0x0/${urlString}`, {
                parse_response: false,
                follow_max: 5,
                user_agent: 'SteemitProxy/1.0 (+https://github.com/steemit/imagehoster)',
            } as any)

            if (Math.floor((res.statusCode || 404) / 100) !== 2) {
                ctx.log.debug({url: urlString}, 'fetching from steemitimages image')
                res = await fetchUrl(`https://steemitimages.com/0x0/${urlString}`, {
                    parse_response: false,
                    follow_max: 5,
                    user_agent: 'SteemitProxy/1.0 (+https://github.com/steemit/imagehoster)',
                } as any)
            }

            buffer = res.body

            // Do NOT write fallback-fetched data to uploadStore — the fetched image
            // may be processed/resized by the proxy or a default fallback image,
            // which would permanently corrupt the original upload hash.
            // Only the upload handler should write to uploadStore.

            // still send 404 to force frontend retry proxy
            ctx.res.writeHead(404, 'Not Found')
            ctx.res.end()
            return

        } catch (err) {
            ctx.res.writeHead(404, 'Not Found')
            ctx.res.end()
            return
        }
    }

    let mimeType = 'application/octet-stream'
    try {
        const metadata = await Sharp(buffer).metadata()
        mimeType = detectMimeType(metadata)
    } catch (err) {
        ctx.log.warn(err, 'Sharp metadata detection failed')
    }

    ctx.set('Content-Type', mimeType)
    ctx.set('Cache-Control', 'public,max-age=31536000,immutable')
    ctx.body = buffer
}
