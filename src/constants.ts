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

/**
 * Largest animated source the proxy serves through untouched, in bytes.
 *
 * An animated GIF used to be handed back as it was at every size, because a
 * Sharp resize that forgets `animated: true` renders the first frame and ships a
 * still. That is why the LCP element of a feed page could be a 1.5MB GIF that
 * `?width=320` did nothing to. Above this size the animation is re-rendered at
 * the requested size (see animated.ts), which only keeps the result if it still
 * holds every frame and is smaller.
 *
 * Below it the encode is not worth its CPU: stickers and emotes are already
 * small, and a re-encode of one saves a few KB at best. Configurable via
 * `animated_passthrough_max_size`; 0 transforms every animated source.
 */
export const ANIMATED_PASSTHROUGH_MAX_SIZE = (() => {
    if (!config.has('animated_passthrough_max_size')) { return 100_000 }
    // TOML parses this as a number; Number() also tolerates a string override.
    const v = Number(config.get('animated_passthrough_max_size'))
    return Number.isSafeInteger(v) && v >= 0 ? v : 100_000
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
 * It is the escape hatch that gives an exhausted chain a chance to answer with a
 * placeholder instead of an error, so it must still run when the budget is
 * already blown. It is not a guarantee: this fetch has its own timeouts and can
 * fail, in which case the request still ends in an error.
 * It is bounded separately and tightly because it loops back through this
 * service's own Cloudflare-nginx-Varnish stack.
 */
export const FETCH_DEFAULT_OPEN_MS = 2000
export const FETCH_DEFAULT_RESPONSE_MS = 3000
export const FETCH_DEFAULT_READ_MS = 3000
export const FETCH_DEFAULT_WALL_MS = 5000

/**
 * First-byte timeout the cache in front of this service grants the image
 * backend. This is Varnish's `.first_byte_timeout` for the proxy backend in the
 * deployed VCL, not Varnish's 60s default: a request the origin has not started
 * answering by then is cut off and the client gets a 503. Every budget below is
 * derived from it, so that a change here is the one place to retune.
 */
export const EDGE_FIRST_BYTE_TIMEOUT_MS = 20000

/**
 * Wall-clock budget for the whole upstream fetch chain of one request.
 *
 * A proxy miss can walk up to eight mirror candidates, and each candidate used to
 * get the full 10s for every phase, so a request against a dead-but-listening
 * origin could spend well over a minute upstream. The origin's own budget then
 * exceeded the one its caller was willing to wait, so the request was cut off as
 * a 503 rather than finishing as a placeholder.
 *
 * The first attempt at this budget assumed the 60s Varnish default and picked
 * 25s. The deployed VCL sets 20s, so every walk that pressed against the 25s
 * budget was still a 503 at exactly 20s, and the placeholder path could never
 * win the race. The default is now derived: the walk must end early enough for
 * the reserved default-image fetch (its own worst case, FETCH_DEFAULT_WALL_MS)
 * and the render (FETCH_RENDER_SLACK_MS) to complete inside the edge budget.
 *
 * The render slack is a heuristic, not an enforced limit: metadata, the encode
 * gate's queue wait and the encode itself are not deadline-aware, so a saturated
 * worker can still push the first byte past the edge cutoff. It is sized for the
 * measured shape (a placeholder encode is tens of milliseconds, queue waits are
 * usually well under a second at the production limit) with headroom, and it
 * costs nothing in mirror depth: the first slow candidate's 12s wall consumes a
 * 12s and a 13s budget identically, so the second candidate never ran either way.
 *
 * Retune without a rebuild by restarting with
 * NODE_CONFIG='{"fetch_deadline_ms":11000}': config/ is baked into the image, so
 * editing a toml on the box does nothing unless it is mounted. An override is
 * taken as given, but the default is the value that is known to fit.
 */
export const FETCH_RENDER_SLACK_MS = 3000
export const FETCH_DEADLINE_DEFAULT_MS =
    EDGE_FIRST_BYTE_TIMEOUT_MS - FETCH_DEFAULT_WALL_MS - FETCH_RENDER_SLACK_MS
export const FETCH_DEADLINE_MS = (() => {
    if (!config.has('fetch_deadline_ms')) { return FETCH_DEADLINE_DEFAULT_MS }
    const v = Number(config.get('fetch_deadline_ms'))
    return Number.isSafeInteger(v) && v > 0 ? v : FETCH_DEADLINE_DEFAULT_MS
})()

/**
 * Object-store (S3) request floors, set on the shared client.
 *
 * The SDK's defaults leave connection and socket timeouts unbounded and retry
 * three times, so a stalled HEAD or GET against object storage blocked a request
 * until the edge cut it off at 20 s, and it did so BEFORE the mirror walk, whose
 * budget it silently consumed (a 503'd walk was seen logging `attempted: 0`).
 * The upload and retention stores live in the same data centre as the service:
 * a healthy call is tens of milliseconds, the measured p99 on the serve route was
 * 3.2 s, so these are floors for a stall, not budgets for normal work. Calls on
 * a request path additionally carry a signal from `budgetSignal`, reads and the
 * writes awaited before the response alike, so the floors only decide calls
 * made without one.
 */
export const S3_CONNECT_TIMEOUT_MS = 2000
export const S3_REQUEST_TIMEOUT_MS = 5000
export const S3_MAX_ATTEMPTS = 2
/**
 * Worst case for one unsignalled call: every attempt connects and then stalls
 * for the full request timeout. Pinned by a test to stay under the edge's 20 s
 * with room for backoff, because these floors are the only bound on calls made
 * without a request signal (writes off the request path, purges, removals).
 */
export const S3_WORST_CASE_MS = S3_MAX_ATTEMPTS * (S3_CONNECT_TIMEOUT_MS + S3_REQUEST_TIMEOUT_MS)

/**
 * The SDK's NodeHttpHandler options. `requestTimeout` alone only LOGS when it
 * elapses; it aborts the request only with `throwOnRequestTimeout`, and the idle
 * socket guard is the separate `socketTimeout`. Kept in one place so the client
 * and the test that proves a stalled endpoint is actually cut off share it.
 */
export function s3RequestHandlerOptions(overrides: Partial<{connectionTimeout: number, requestTimeout: number}> = {}) {
    const requestTimeout = overrides.requestTimeout ?? S3_REQUEST_TIMEOUT_MS
    return {
        connectionTimeout: overrides.connectionTimeout ?? S3_CONNECT_TIMEOUT_MS,
        requestTimeout,
        throwOnRequestTimeout: true,
        socketTimeout: requestTimeout,
    }
}

/**
 * Per-lookup budget for a store HEAD or GET on a request path, in ms.
 *
 * Every store call a read handler makes before its upstream fetch (upload-store
 * and retention HEADs, the read of a stored original) carries an AbortSignal of
 * at most this long, further clamped to what is left of the request's fetch
 * deadline, so a stall costs the request one bounded wait and then falls
 * through to the fetch path or the placeholder instead of eating the whole
 * budget. The serve route, which has no fetch to fall through to, allows three
 * times this for an original of up to max_image_size and answers 504 past it.
 * Configurable as `store_op_timeout_ms` (tests set it low).
 */
export const STORE_OP_TIMEOUT_MS = (() => {
    if (!config.has('store_op_timeout_ms')) { return 5000 }
    const v = Number(config.get('store_op_timeout_ms'))
    return Number.isSafeInteger(v) && v > 0 ? v : 5000
})()
export const SERVE_READ_TIMEOUT_MS = STORE_OP_TIMEOUT_MS * 3

/**
 * An AbortSignal for one store call: `capMs`, or what is left until `deadlineAt`
 * if that is sooner, never less than 1 ms so a blown budget aborts immediately
 * rather than disabling the timer.
 */
export function budgetSignal(deadlineAt: number | undefined, capMs: number): AbortSignal {
    const remaining = deadlineAt === undefined ? capMs : deadlineAt - Date.now()
    return AbortSignal.timeout(Math.max(1, Math.min(capMs, remaining)))
}
