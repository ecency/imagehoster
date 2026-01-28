/** Legacy proxy API redirects. */
import * as config from 'config'
import * as querystring from 'querystring'
import {URL} from 'url'

import {KoaContext} from './common'
import {DEFAULT_FALLBACK_IMAGE_URL} from './constants'
import {APIError} from './error'
import { base58Enc } from './utils'

export async function legacyProxyHandler(ctx: KoaContext) {
    ctx.tag({handler: 'legacy-proxy'})

    APIError.assert(ctx.method === 'GET', APIError.Code.InvalidMethod)
    APIError.assertParams(ctx.params, ['width', 'height', 'url'])

    const width = Number.parseInt(ctx.params['width'])
    const height = Number.parseInt(ctx.params['height'])

    APIError.assert(Number.isFinite(width), 'Invalid width')
    APIError.assert(Number.isFinite(height), 'Invalid height')
    APIError.assert(width >= 0, 'Width must be non-negative')
    APIError.assert(height >= 0, 'Height must be non-negative')

    // Dimension handling:
    // - 0x0 = proxy without resizing (passthrough)
    // - 500x0 = resize to width 500, height auto (maintain aspect ratio)
    // - 0x500 = resize to height 500, width auto (maintain aspect ratio)
    // - 500x300 = resize to exact dimensions

    let url: URL
    const uu = ctx.params['url']

    if (uu) {
        try {
            url = new URL(uu.replace(/\/+$/, ''))
        } catch (err) {
            ctx.log.error({ err, uu }, 'legacyProxyHandler url failed')
            throw new APIError({cause: err, code: APIError.Code.InvalidProxyUrl})
        }
    } else {
        // black pixel fallback
        ctx.log.error({ uu }, 'legacyProxyHandler url undefined')
        url = new URL(DEFAULT_FALLBACK_IMAGE_URL)
    }

    const options: {[key: string]: any} = {
        format: 'match',
        mode: 'fit',
    }

    if (width > 0) { options['width'] = width }
    if (height > 0) { options['height'] = height }

    const qs = querystring.stringify(options)
    const b58url = base58Enc(url.toString())

    ctx.status = 301
    ctx.redirect(`/p/${ b58url }.png?${ qs }`)
}

/**
 * @deprecated Use legacyProxyHandler - WebP is now auto-detected via Accept header
 * Redirects to non-webp URL for backward compatibility
 */
export async function legacyWProxyHandler(ctx: KoaContext) {
    ctx.tag({handler: 'legacy-webp-proxy'})

    APIError.assert(ctx.method === 'GET', APIError.Code.InvalidMethod)
    APIError.assertParams(ctx.params, ['width', 'height', 'url'])

    const width = Number.parseInt(ctx.params['width'])
    const height = Number.parseInt(ctx.params['height'])

    APIError.assert(Number.isFinite(width), 'Invalid width')
    APIError.assert(Number.isFinite(height), 'Invalid height')
    APIError.assert(width >= 0, 'Width must be non-negative')
    APIError.assert(height >= 0, 'Height must be non-negative')

    // Dimension handling:
    // - 0x0 = proxy without resizing (passthrough)
    // - 500x0 = resize to width 500, height auto (maintain aspect ratio)
    // - 0x500 = resize to height 500, width auto (maintain aspect ratio)
    // - 500x300 = resize to exact dimensions

    const uu = ctx.params['url']

    // Redirect to non-webp legacy endpoint, let Accept header determine format
    const redirectPath = `/${width}x${height}/${uu}`
    ctx.status = 301
    ctx.redirect(redirectPath)
}
