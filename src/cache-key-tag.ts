/**
 * The CDN cache-key tag (`_acc`).
 *
 * Cloudflare ignores `Vary: Accept`, so URL rewrites at the edge append
 * `_acc=avif|webp|0` to negotiated requests and each Accept group gets its own
 * cache entry (see "Cloudflare" in CLAUDE.md). The origin never renders from the
 * tag, but it has to police it: the edge skips URLs that already carry one, so a
 * client could send `?_acc=0` with an AVIF Accept and warm the key that JPEG-only
 * clients are rewritten to. The edge test is also a plain substring match, which
 * can file an Accept differently from the origin (upper case, `q=0`).
 *
 * So a tag that is not exactly the group this request's Accept falls into is
 * answered `no-store`: the response is still right for this client, and nothing
 * the CDN keeps under that key can differ from what the key's group would get.
 */
import { KoaContext } from './common'
import { supportsAvif, supportsWebP } from './utils'

export const CACHE_KEY_TAG = '_acc'

/** Formats a /p/ URL can name outright; anything else is negotiated. */
const EXPLICIT_FORMATS = new Set(['jpeg', 'jpg', 'png', 'webp', 'avif'])

/** The Accept group, by the same test `parseOptions` negotiates with. */
export function acceptBucket(acceptHeader: string): 'avif' | 'webp' | '0' {
    if (supportsAvif(acceptHeader)) { return 'avif' }
    if (supportsWebP(acceptHeader)) { return 'webp' }
    return '0'
}

function isNegotiated(ctx: KoaContext): boolean {
    if (ctx.path.startsWith('/u/')) { return true }
    if (!ctx.path.startsWith('/p/')) { return false }
    const format = ctx.query['format']
    return !(typeof format === 'string' && EXPLICIT_FORMATS.has(format))
}

/** Remove the tag from a redirect target, leaving the rest of the query as written. */
export function stripCacheKeyTag(location: string): string {
    const q = location.indexOf('?')
    if (q < 0) { return location }
    const kept = location.slice(q + 1).split('&').filter((pair) => {
        const key = pair.split('=', 1)[0]
        let decoded = key
        try { decoded = decodeURIComponent(key) } catch { /* keep the raw key */ }
        return decoded !== CACHE_KEY_TAG
    })
    return location.slice(0, q) + (kept.length ? '?' + kept.join('&') : '')
}

export async function cacheKeyTagGuard(ctx: KoaContext, next: () => Promise<any>) {
    await next()
    // A canonicalising redirect copies the query; the tag belongs to the edge's
    // cache key, never to a URL the client is sent to
    const location = ctx.response.get('Location')
    if (location && location.includes(CACHE_KEY_TAG)) {
        ctx.set('Location', stripCacheKeyTag(location))
    }
    const tag = ctx.query[CACHE_KEY_TAG]
    if (tag === undefined || !isNegotiated(ctx)) { return }
    if (Array.isArray(tag) || tag !== acceptBucket(ctx.get('accept'))) {
        ctx.set('Cache-Control', 'no-store')
        return
    }
    // The catch-all group holds clients that name no image type (`*/*`) and ones
    // that list only JPEG/PNG. For an AVIF or HEIF source the first get it passed
    // through (see needsMatchFallback), which the second cannot decode, so such a
    // body must not be cached under that group's key.
    if (tag === '0' && /^image\/(avif|heic|heif)$/.test(ctx.response.type)) {
        ctx.set('Cache-Control', 'no-store')
    }
}
