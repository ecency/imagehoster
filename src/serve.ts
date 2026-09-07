/** Serve files from upload store. */

import {isBlacklistedUrl, isStoreAbort, readStream} from './utils'
import {KoaContext, uploadStore} from './common'
import {APIError} from './error'
import {budgetSignal, DEFAULT_AVATAR_HASH, MAX_INPUT_PIXELS, SERVE_READ_TIMEOUT_MS, SERVICE_BASE_URL} from './constants'
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
    if (isBlacklistedUrl(urlString)) {
        _hash = DEFAULT_AVATAR_HASH
    }

    let buffer: Buffer
    // This route has no fetch path to fall through to, so a stalled object store
    // is answered as such: a 504 that the error middleware marks no-store, rather
    // than a wait until the edge cuts the request off at its own timeout, and
    // rather than a 404, which caches and would tell the client the upload is gone
    const signal = budgetSignal(undefined, SERVE_READ_TIMEOUT_MS)
    try {
        buffer = await readStream(uploadStore.createReadStream({ key: _hash, signal } as any), signal)
    } catch (error) {
        if (isStoreAbort(error)) {
            ctx.log.warn({hash: _hash, timeoutMs: SERVE_READ_TIMEOUT_MS}, 'upload store read timed out')
            throw new APIError({ cause: error as Error, code: APIError.Code.StoreTimeout, info: { hash: _hash } })
        }
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
        const metadata = await Sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS }).metadata()
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
