import { URL } from 'url'
import { redisDel, redisGet, redisSet } from './common'
import { captureImageFailure } from './sentry'
import { assertPublicUrl, fetchUrl, getUrlHashKey, isBlacklistedUrl, NeedleResponse } from './utils'

const buildFallbackUrls = (urlString: string, urlParams: string): string[] => {
    const hasQuery = urlString.indexOf('?') !== -1
    // Try HTTPS upgrade first for http:// URLs — many servers block HTTP
    // but serve HTTPS fine (e.g. hivebuzz.me). Keep original HTTP as fallback.
    const httpsUrl = urlString.startsWith('http://') ? urlString.replace('http://', 'https://') : null
    const urls: string[] = [
        ...(httpsUrl ? [httpsUrl] : []),
        urlString, // original URL
        // /p/ routes use base58 encoding — safely preserves query params
        'https://images.hive.blog/p/' + urlParams,
        'https://steemitimages.com/p/' + urlParams,
    ]
    // 0x0/ routes embed the URL in the path — query params get stripped
    // by the receiving proxy's router, so only useful for URLs without query params
    if (!hasQuery) {
        urls.push(
            'https://images.hive.blog/0x0/' + urlString,
            'https://steemitimages.com/0x0/' + urlString,
            'https://img.leopedia.io/0x0/' + urlString,
        )
    }
    // wsrv.nl needs URL-encoded value to preserve query params
    urls.push('https://wsrv.nl/?url=' + encodeURIComponent(urlString))
    // Add 0x0/ routes last as extra attempts for URLs with query params
    // (they'll lose the params but might still work for non-authenticated URLs)
    if (hasQuery) {
        urls.push(
            'https://images.hive.blog/0x0/' + urlString,
            'https://steemitimages.com/0x0/' + urlString,
            'https://img.leopedia.io/0x0/' + urlString,
        )
    }
    return urls
}

// Negative cache for exhausted fetches. Walking the whole mirror chain costs
// up to ~8 outbound requests with multi-second timeouts each, and the caller
// holds its upstream connection open for the duration — so dead URLs are
// remembered briefly and skipped straight to the default image. The local map
// bounds the blast radius when Redis is unavailable; Redis shares entries
// across cluster workers and survives worker restarts.
//
// Not every failure means the same thing. A 404/410 (or a host that does not
// resolve) is the origin definitively saying "this is not here" — worth
// remembering for the full TTL. A timeout, connection reset or 5xx usually means
// the origin, the network, or this service was momentarily busy: the image is
// very likely still alive. Remembering those for the full TTL replaces a live
// image with the default placeholder for ten minutes off a single blip, and
// under load that turns a transient slowdown into a self-sustaining one. Keep a
// short entry for them so the mirror chain is still not walked by every
// concurrent request, then let the URL recover on its own.
const NEGATIVE_TTL_SECONDS = 600
const NEGATIVE_TTL_TRANSIENT_SECONDS = 60
const NEGATIVE_LOCAL_MAX = 10000
const localNegativeCache = new Map<string, number>() // urlString -> expiry epoch ms

// Origin answered, and the answer was "this does not exist / you may not have it"
const TERMINAL_STATUS_CODES = new Set([400, 401, 403, 404, 405, 410, 414, 451])
// DNS could not resolve the host at all
const TERMINAL_ERROR_CODES = new Set(['ENOTFOUND', 'EAI_NONAME'])

function isTerminalStatus(statusCode?: number): boolean {
    return typeof statusCode === 'number' && TERMINAL_STATUS_CODES.has(statusCode)
}

function isTerminalError(e: any): boolean {
    const code = e && (e.code || e.errno)
    // Anything we cannot positively identify is treated as transient: a short
    // entry that expires is cheap, a wrong ten-minute one is user-visible.
    return typeof code === 'string' && TERMINAL_ERROR_CODES.has(code)
}

const negativeCacheKey = (urlString: string) => 'negfetch:' + getUrlHashKey(urlString)

export async function isKnownDeadUrl(urlString: string): Promise<boolean> {
    const expiry = localNegativeCache.get(urlString)
    if (expiry !== undefined) {
        if (expiry > Date.now()) { return true }
        localNegativeCache.delete(urlString)
    }
    return await redisGet(negativeCacheKey(urlString)) !== undefined
}

export async function markDeadUrl(urlString: string, ttlSeconds: number = NEGATIVE_TTL_SECONDS): Promise<void> {
    // Map iterates in insertion order, so evicting the first key drops the oldest entry
    while (localNegativeCache.size >= NEGATIVE_LOCAL_MAX) {
        localNegativeCache.delete(localNegativeCache.keys().next().value as string)
    }
    localNegativeCache.set(urlString, Date.now() + ttlSeconds * 1000)
    await redisSet(negativeCacheKey(urlString), 1, Math.max(1, Math.round(ttlSeconds)))
}

export async function clearDeadUrl(urlString: string): Promise<void> {
    localNegativeCache.delete(urlString)
    await redisDel(negativeCacheKey(urlString))
}

export function clearNegativeFetchCache(): void {
    localNegativeCache.clear()
}

// Remaining local-cache lifetime in ms, or undefined when not cached. Lets tests
// tell a terminal entry from a transient one without waiting out the TTL.
export function peekDeadUrlTtl(urlString: string): number | undefined {
    const expiry = localNegativeCache.get(urlString)
    return expiry === undefined ? undefined : expiry - Date.now()
}

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308])

/**
 * Fetch with redirects followed manually so every Location target is validated
 * before it is requested. Needle's follow_max would fetch a redirect target
 * with no blacklist or public-address check, letting an allowed URL bounce the
 * request to a blocked or private one.
 */
async function fetchWithGuardedRedirects(
    urlString: string,
    opts: any,
    maxRedirects: number = 5
): Promise<NeedleResponse> {
    let current = urlString
    for (let hop = 0; ; hop++) {
        const res = await fetchUrl(current, { ...opts, follow_max: 0 } as any)
        const status = res && res.statusCode
        if (!status || !REDIRECT_STATUS.has(status)) {
            return res
        }
        const rawLocation = res.headers && (res.headers as any).location
        const location = Array.isArray(rawLocation) ? rawLocation[0] : rawLocation
        if (!location || hop >= maxRedirects) {
            return res
        }
        const next = new URL(location, current).toString()
        if (isBlacklistedUrl(next)) {
            throw new Error('Redirect target is blacklisted')
        }
        if (process.env.NODE_ENV !== 'test') {
            assertPublicUrl(new URL(next))
        }
        current = next
    }
}

export async function fetchImageWithFallbacks(
    urlString: string,
    urlParams: string,
    userAgent: string,
    defaultUrl: string,
    ctxLog: any,
    options: { timeout?: number; skipUrls?: string[]; skipNegativeCache?: boolean } = {}
): Promise<{ res: NeedleResponse; isFallback: boolean }> {
    const timeout = options.timeout !== undefined && options.timeout !== null ? options.timeout : 10000
    const skipUrls = (options.skipUrls !== undefined && options.skipUrls !== null) ? options.skipUrls : []

    const urls = buildFallbackUrls(urlString, urlParams).filter((url) => {
        return !skipUrls.includes(url.trim())
    })

    if (isBlacklistedUrl(urlString)) {
        // Covers the avatar/cover paths, which have no pre-cache blacklist gate of
        // their own. Fall through to the default image without touching upstream
        // and without negative-caching the URL as dead.
        ctxLog.warn({ urlString }, 'Skipping mirror chain for blacklisted URL or domain')
    } else if (!options.skipNegativeCache && await isKnownDeadUrl(urlString)) {
        ctxLog.info({ urlString }, 'Skipping mirror chain for recently failed URL')
    } else {
        let sawTransientFailure = false
        // The HTTPS upgrade is an opportunistic probe: an origin that serves
        // plain HTTP will refuse it, and that tells us nothing about whether the
        // image exists. Only real answers count toward the terminal/transient
        // verdict, or every http:// URL would look transient.
        const speculativeHttpsUrl = urlString.startsWith('http://')
            ? urlString.replace('http://', 'https://')
            : null
        for (const candidate of urls) {
            if (isBlacklistedUrl(candidate)) {
                ctxLog.warn({ candidate }, 'Skipping blacklisted URL in fallback chain')
                continue
            }
            if (process.env.NODE_ENV !== 'test') {
                try {
                    assertPublicUrl(new URL(candidate))
                } catch (e) {
                    ctxLog.warn({ candidate }, 'Skipping private URL in fallback chain')
                    continue
                }
            }
            try {
                ctxLog.info({ candidate }, 'Trying fallback fetch')
                const res = await fetchWithGuardedRedirects(candidate, {
                    parse_response: false,
                    open_timeout: timeout,
                    response_timeout: timeout,
                    read_timeout: timeout,
                    user_agent: userAgent,
                })

                if (
                    res &&
                    res.statusCode &&
                    Math.floor(res.statusCode / 100) === 2 &&
                    Buffer.isBuffer(res.body)
                ) {
                    ctxLog.info({ candidate }, 'Fetch succeeded')
                    // A bypassed re-fetch (e.g. invalidate) may have proven a
                    // negatively cached URL alive again — drop the stale entry
                    await clearDeadUrl(urlString)
                    return { res, isFallback: false }
                }

                if (candidate !== speculativeHttpsUrl && !isTerminalStatus(res && res.statusCode)) {
                    sawTransientFailure = true
                }
                ctxLog.warn({ candidate, code: res && res.statusCode }, 'Fetch failed status')
            } catch (e) {
                if (candidate !== speculativeHttpsUrl && !isTerminalError(e)) {
                    sawTransientFailure = true
                }
                ctxLog.error(e, `Fetch error at ${candidate}`)
            }
        }
        // Only a chain that failed terminally at every hop is remembered for the
        // full TTL; if any hop merely timed out or errored, keep it brief.
        const ttl = sawTransientFailure ? NEGATIVE_TTL_TRANSIENT_SECONDS : NEGATIVE_TTL_SECONDS
        ctxLog.info({ urlString, ttl, transient: sawTransientFailure }, 'Negative-caching exhausted URL')
        await markDeadUrl(urlString, ttl)
    }

    // Final fallback: default image (avatar or cover)
    try {
        ctxLog.info('Trying final fallback: default image')
        const def = await fetchWithGuardedRedirects(defaultUrl, {
            parse_response: false,
            open_timeout: timeout,
            response_timeout: timeout,
            read_timeout: timeout,
            user_agent: userAgent,
        })

        if (
            def &&
            def.statusCode &&
            Math.floor(def.statusCode / 100) === 2 &&
            Buffer.isBuffer(def.body)
        ) {
            return { res: def, isFallback: true }
        }

        ctxLog.warn({ code: def && def.statusCode }, 'Default image fetch failed')
    } catch (e) {
        ctxLog.error(e, 'Failed to fetch default fallback image')
    }

    captureImageFailure('all_mirrors_exhausted', {}, { urlString, urlParams, triedUrls: buildFallbackUrls(urlString, urlParams).length })
    throw new Error('All fallbacks failed, including default image')
}
