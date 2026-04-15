/** Serve files from upload store. */

import {readStream} from './utils'
import {KoaContext, uploadStore} from './common'
import {APIError} from './error'
import {imageBlacklist} from './blacklist'
import {DEFAULT_AVATAR_HASH, isEmptyImageUrl, SERVICE_BASE_URL} from './constants'
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
        // File not found in uploadStore — return 404 to let the client
        // retry via the proxy path (/p/) which has a full fallback chain.
        // Do NOT fetch from external proxies and write to uploadStore here —
        // the fetched data may be processed/resized or a default fallback,
        // which would permanently corrupt the original upload hash.
        ctx.log.debug({hash: _hash}, 'not found in uploadStore, returning 404')
        ctx.res.writeHead(404, 'Not Found')
        ctx.res.end()
        return
    }

    let mimeType = 'application/octet-stream'
    try {
        const metadata = await Sharp(buffer).metadata()
        mimeType = detectMimeType(metadata)
    } catch (err) {
        ctx.log.warn(err, 'Sharp metadata detection failed')
    }

    ctx.set('Content-Type', mimeType)
    if (mimeType === 'image/svg+xml') {
        ctx.set('Content-Disposition', 'attachment')
    }
    ctx.set('Cache-Control', 'public,max-age=31536000,immutable')
    ctx.body = buffer
}
