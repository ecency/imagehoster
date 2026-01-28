/** Application constants and magic strings centralized in one location. */

import * as config from 'config'

/** Service base URL from configuration */
export const SERVICE_BASE_URL = config.get('service_url') as string

/** Special empty image indicator - used to denote "proxy without resizing" */
export const SPECIAL_EMPTY_IMAGE_PATH = '0x0'

/** Full URL patterns for the special empty image */
export const EMPTY_IMAGE_URL_PATTERNS = [
    `${SERVICE_BASE_URL}/0x0/`,
    `${SERVICE_BASE_URL}/0x0`
]

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
    return url === EMPTY_IMAGE_URL_PATTERNS[0] || url === EMPTY_IMAGE_URL_PATTERNS[1]
}

/**
 * Check if URL starts with the empty image prefix (e.g., for proxied 0x0 URLs)
 */
export function startsWithEmptyImagePrefix(url: string): boolean {
    return url.startsWith(EMPTY_IMAGE_URL_PATTERNS[0])
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
