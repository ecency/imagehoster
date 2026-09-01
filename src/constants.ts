/** Application constants and magic strings centralized in one location. */

import config from 'config'

/** Service base URL from configuration */
export const SERVICE_BASE_URL = config.get('service_url') as string
export const LEGACY_SERVICE_BASE_URL = 'https://images.ecency.com'
export const INTERNAL_SERVICE_BASE_URLS = Array.from(new Set([
    SERVICE_BASE_URL.replace(/\/+$/, ''),
    LEGACY_SERVICE_BASE_URL,
]))
export const INTERNAL_SERVICE_ORIGINS = INTERNAL_SERVICE_BASE_URLS.map((url) => new URL(url).origin)

/**
 * libaom search effort for AVIF encodes.
 *
 * Measured on five real proxy images (same source, quality held at 50, resized
 * to fit 1280): effort 2 encodes 1.6-2.3x faster than effort 3 and comes out the
 * same size or smaller (92-100% of effort 3's bytes), so lowering it costs no
 * bandwidth. Visual comparison at 200% showed no meaningful difference.
 *
 * Do not lower it further: effort 1 is not reliably faster than 2 (it was slower
 * on one image), and effort 0 produces ~8% LARGER files. Effort 4 is ~6x slower
 * than 3 for under 1% size reduction.
 *
 * Encode cost is why this matters: a full 1280 AVIF encode is ~578ms at effort 3
 * versus ~13ms for a 64px avatar, and encodes are bounded by a per-worker
 * semaphore (see encode-limit.ts), so cheaper encodes drain that queue faster.
 */
export const AVIF_EFFORT = 2

/**
 * Maximum input pixels (width * height) Sharp will decode before throwing.
 * Guards worker memory against decompression bombs and huge-dimension images: a
 * 16000x16000 image decodes to ~1GB of raw RGBA, and a handful in flight will
 * push workers into swap. Configurable via `max_input_pixels`; defaults to
 * 100 MP, which admits all real-world photos while rejecting the pathological.
 */
export const MAX_INPUT_PIXELS = (() => {
    if (!config.has('max_input_pixels')) { return 100_000_000 }
    // TOML parses this as a number; Number() also tolerates a string override.
    const v = Number(config.get('max_input_pixels'))
    return Number.isSafeInteger(v) && v > 0 ? v : 100_000_000
})()

/**
 * Largest original the proxy will keep a cached copy of, in bytes.
 *
 * On a proxy miss we store two things: the rendered variant we are about to
 * serve, and the untouched original, so a later request for a different size or
 * format can re-render locally instead of refetching upstream. The original is
 * pure cache (uploads live in the upload store, dead-origin rescues in the
 * retention store) and it is by far the more expensive of the two: measured over
 * 49k live proxy-store files, the median is 69KB but the 10% of files above 1MB
 * account for 67% of all bytes. Keeping that tail is what makes the store take
 * in roughly its own capacity per day.
 *
 * Above this size we skip the original and cache only the variant. Repeat hits
 * on the same variant are unaffected; only a *different* variant of a large
 * source image pays an extra upstream fetch.
 *
 * Configurable via `max_cached_original_size`; 0 disables caching originals
 * entirely. Defaults to 1MB, which keeps ~90% of originals by count.
 */
export const MAX_CACHED_ORIGINAL_SIZE = (() => {
    if (!config.has('max_cached_original_size')) { return 1_000_000 }
    // TOML parses this as a number; Number() also tolerates a string override.
    const v = Number(config.get('max_cached_original_size'))
    return Number.isSafeInteger(v) && v >= 0 ? v : 1_000_000
})()

/** Special empty image indicator - used to denote "proxy without resizing" */
export const SPECIAL_EMPTY_IMAGE_PATH = '0x0'

/** Full URL patterns for the special empty image */
export const EMPTY_IMAGE_URL_PATTERNS = INTERNAL_SERVICE_BASE_URLS.flatMap((url) => [
    `${url}/0x0/`,
    `${url}/0x0`,
])

/** Default 1x1 transparent pixel fallback image */
export const DEFAULT_FALLBACK_IMAGE_URL = `${SERVICE_BASE_URL}/DQmY4YngD8ByBgpFtcTRR6wvqYfM1owqtjS6NXyYhKtxv4u/1x1_000000.png`

/** Default avatar image hash (ecency default avatar) */
export const DEFAULT_AVATAR_HASH = 'DQmUVRvAmChYcJqBifekwpR9UTsxSbbbnEi9kJXRWEGzX47'

/** Default avatar URL pattern */
export const DEFAULT_AVATAR_URL_PATTERN = `${SERVICE_BASE_URL}/${DEFAULT_AVATAR_HASH}`

/**
 * Domain replacements for known CDN migrations and URL corrections.
 * Format: [oldDomain, newDomain]
 */
export const DOMAIN_REPLACEMENTS: Array<[string, string]> = [
    // 3speak CDN migration
    ['https://img.3speakcontent.online/', 'https://img.3speakcontent.co/'],
    // InLeo CDN migration
    ['https://img.inleo.io/D', 'https://img.leopedia.io/D']
]

/**
 * Path replacements for specific CDNs
 * Format: [domain, oldPath, newPath]
 */
export const PATH_REPLACEMENTS: Array<[string, string, string]> = [
    // 3speak thumbnail path correction
    ['https://img.3speakcontent.co/', '/post.png', '/thumbnails/default.png']
]

/**
 * Check if URL is the special empty image indicator
 */
export function isEmptyImageUrl(url: string): boolean {
    return EMPTY_IMAGE_URL_PATTERNS.includes(url)
}

/**
 * Check if URL starts with the empty image prefix (e.g., for proxied 0x0 URLs)
 */
export function startsWithEmptyImagePrefix(url: string): boolean {
    return EMPTY_IMAGE_URL_PATTERNS.some((pattern) => pattern.endsWith('/') && url.startsWith(pattern))
}

/**
 * Apply domain and path replacements to a URL string
 */
export function applyUrlReplacements(urlString: string): string {
    let result = urlString

    // Apply domain replacements
    for (const [oldDomain, newDomain] of DOMAIN_REPLACEMENTS) {
        result = result.replace(oldDomain, newDomain)
    }

    // Apply path replacements
    for (const [domain, oldPath, newPath] of PATH_REPLACEMENTS) {
        if (result.indexOf(domain) > -1) {
            result = result.replace(oldPath, newPath)
        }
    }

    return result
}

/**
 * Wall-clock budget for the whole upstream fetch chain of one request.
 *
 * A proxy miss can walk up to eight mirror candidates, and each candidate used to
 * get the full 10s for every phase, so a request against a dead-but-listening
 * origin could spend well over a minute upstream. Varnish gives the backend 60s
 * (the VCL sets no first_byte_timeout, so its default applies) and Cloudflare 100s,
 * so the origin's own budget exceeded the one its caller was willing to wait: the
 * request was cut off as a 503 rather than finishing as a placeholder. That
 * inversion is the likeliest source of the standing 1.0% 503 rate.
 *
 * 25s leaves room for the reserved default-image fetch, a metadata re-walk and a
 * worst-case encode while staying comfortably under 60s.
 *
 * Retune without a rebuild by restarting with
 * NODE_CONFIG='{"fetch_deadline_ms":40000}': config/ is baked into the image, so
 * editing a toml on the box does nothing unless it is mounted.
 */
export const FETCH_DEADLINE_MS = (() => {
    if (!config.has('fetch_deadline_ms')) { return 25000 }
    const v = Number(config.get('fetch_deadline_ms'))
    return Number.isSafeInteger(v) && v > 0 ? v : 25000
})()

/**
 * Per-candidate phase timeouts.
 *
 * needle arms these as separate serial phases and re-arms them per redirect leg,
 * so the phase values alone do not bound a candidate. FETCH_CANDIDATE_WALL_MS is
 * the actual per-candidate ceiling, enforced with an AbortSignal that spans every
 * hop. Connect is the cheapest signal that an origin is gone, so it gets the
 * shortest leash; read gets the longest because a slow-but-alive origin streaming
 * a large image should still succeed.
 */
export const FETCH_OPEN_TIMEOUT_MS = 4000
export const FETCH_RESPONSE_TIMEOUT_MS = 8000
export const FETCH_READ_TIMEOUT_MS = 10000
export const FETCH_CANDIDATE_WALL_MS = 12000

/** Below this much remaining budget, starting another candidate cannot finish. */
export const FETCH_MIN_REMAINING_MS = 1500

/**
 * The default-image fetch is deliberately NOT clamped by the deadline.
 *
 * It is the escape hatch that turns an exhausted chain into a 200 placeholder
 * instead of an error, so it must still run when the budget is already blown.
 * It is bounded separately and tightly because it loops back through this
 * service's own Cloudflare-nginx-Varnish stack.
 */
export const FETCH_DEFAULT_OPEN_MS = 2000
export const FETCH_DEFAULT_RESPONSE_MS = 3000
export const FETCH_DEFAULT_READ_MS = 3000
export const FETCH_DEFAULT_WALL_MS = 5000
