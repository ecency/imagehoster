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
import config from 'config'

import { KoaContext } from './common'
import { CACHE_KEY_TAG, isNegotiatedPath, supportsAvif, supportsWebP, untaggedSearch } from './utils'
import { hasEdgeToken } from './variant-guard'

const EDGE_TOKEN = config.has('variant_guard_edge_token') ? String(config.get('variant_guard_edge_token') || '') : ''
const EDGE_TOKEN_HEADER = 'x-edge-token'

/** The Accept group, by the same test `parseOptions` negotiates with. */
export function acceptBucket(acceptHeader: string): 'avif' | 'webp' | '0' {
    if (supportsAvif(acceptHeader)) { return 'avif' }
    if (supportsWebP(acceptHeader)) { return 'webp' }
    return '0'
}


/** Remove the tag from a redirect target, leaving the rest of the query as written. */
export function stripCacheKeyTag(location: string): string {
    const q = location.indexOf('?')
    return q < 0 ? location : location.slice(0, q) + untaggedSearch(location.slice(q))
}

/**
 * `edgeToken` is the secret the CDN adds to every request it forwards (the same
 * one the variant guard trusts). Only with it configured can the guard tell that a
 * request came through the CDN, and so that a missing tag means an edge rule
 * missed it.
 */
export function makeCacheKeyTagGuard(edgeToken: string) {
    return async function cacheKeyTagGuard(ctx: KoaContext, next: () => Promise<any>) {
    await next()
    // A canonicalising redirect copies the query; the tag belongs to the edge's
    // cache key, never to a URL the client is sent to
    const location = ctx.response.get('Location')
    if (location && location.includes(CACHE_KEY_TAG)) {
        ctx.set('Location', stripCacheKeyTag(location))
    }
    const tag = ctx.query[CACHE_KEY_TAG]
    if (!isNegotiatedPath(ctx.path, ctx.query['format'])) { return }
    if (tag === undefined) {
        // Through the CDN without a tag: a query shape the rewrite skipped, so every
        // client shares this key. Redirects are exempt, the `amp;` 301 is meant to be
        // cached and is the same for everyone
        const redirect = ctx.status >= 300 && ctx.status < 400
        if (edgeToken && !redirect && hasEdgeToken(ctx.get(EDGE_TOKEN_HEADER) || undefined, edgeToken)) {
            ctx.set('Cache-Control', 'no-store')
        }
        return
    }
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
}

export const cacheKeyTagGuard = makeCacheKeyTagGuard(EDGE_TOKEN)
