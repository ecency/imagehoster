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
