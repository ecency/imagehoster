/** Dynamic blacklist service that fetches from remote JSON. */

import * as config from 'config'
import { URL } from 'url'
import { logger } from './logger'
import { fetchUrl } from './utils'

interface BlacklistData {
    images?: string[]
    accounts?: string[]
    updated?: string
    version?: string
}

interface BlacklistCache {
    images: Set<string>
    accounts: Set<string>
    lastFetch: number
    failCount: number
}

// In-memory cache with TTL
const cache: BlacklistCache = {
    images: new Set(),
    accounts: new Set(),
    lastFetch: 0,
    failCount: 0
}

// Fallback to static blacklists (imported lazily to avoid circular deps)
let staticImageBlacklist: string[] = []
let staticAccountBlacklist: string[] = []

function normalizeUrl(url: string): string {
    try {
        const parsed = new URL(url)
        // new URL() already lowercases scheme and hostname (case-insensitive per RFC)
        // Preserve path case (case-sensitive) and query params (part of resource identity)
        parsed.hash = ''
        if (parsed.pathname.length > 1 && parsed.pathname.endsWith('/')) {
            parsed.pathname = parsed.pathname.slice(0, -1)
        }
        return parsed.toString()
    } catch {
        return url
    }
}

const CACHE_TTL = Number.parseInt(config.get('blacklist.cache_ttl') || '300000') // 5 minutes default
const MAX_FAIL_COUNT = 5
const FETCH_TIMEOUT = 10000

/**
 * Fetch blacklist data from remote JSON endpoint
 */
async function fetchBlacklistData(url: string): Promise<BlacklistData | null> {
    try {
        logger.info({ url }, 'fetching blacklist from remote')

        const response = await fetchUrl(url, {
            parse_response: false,
            json: true,
            open_timeout: FETCH_TIMEOUT,
            response_timeout: FETCH_TIMEOUT,
            read_timeout: FETCH_TIMEOUT,
            user_agent: 'EcencyImageHost/1.0 (+https://github.com/ecency/imagehoster)'
        } as any)

        if (!response || !response.body) {
            logger.warn({ url }, 'empty response from blacklist endpoint')
            return null
        }

        // Parse JSON if it's a string
        let data: BlacklistData
        if (typeof response.body === 'string') {
            data = JSON.parse(response.body)
        } else {
            data = response.body
        }

        // Validate structure
        if (!data || typeof data !== 'object') {
            logger.warn({ url, data }, 'invalid blacklist data structure')
            return null
        }

        logger.info({
            url,
            imageCount: (data.images && data.images.length) || 0,
            accountCount: (data.accounts && data.accounts.length) || 0,
            version: data.version
        }, 'blacklist fetched successfully')

        return data
    } catch (error) {
        logger.error({ error, url }, 'failed to fetch blacklist')
        return null
    }
}

/**
 * Update cache with fresh blacklist data
 */
async function updateCache(): Promise<boolean> {
    // Check if we should skip due to too many failures
    if (cache.failCount >= MAX_FAIL_COUNT) {
        const timeSinceLastFetch = Date.now() - cache.lastFetch
        if (timeSinceLastFetch < CACHE_TTL * 3) {
            logger.debug('skipping blacklist update due to consecutive failures')
            return false
        }
        // Reset fail count after extended wait
        cache.failCount = 0
    }

    const imageUrl = config.get('blacklist.images_url') as string | undefined
    const accountUrl = config.get('blacklist.accounts_url') as string | undefined

    if (!imageUrl && !accountUrl) {
        logger.debug('no remote blacklist URLs configured, using static lists')
        return false
    }

    let updated = false

    // Fetch image blacklist
    if (imageUrl) {
        const data = await fetchBlacklistData(imageUrl)
        if (data && data.images && Array.isArray(data.images)) {
            cache.images = new Set(data.images.map(normalizeUrl))
            updated = true
            logger.info({ count: cache.images.size }, 'image blacklist updated')
        } else {
            cache.failCount++
        }
    }

    // Fetch account blacklist
    if (accountUrl) {
        const data = await fetchBlacklistData(accountUrl)
        if (data && data.accounts && Array.isArray(data.accounts)) {
            cache.accounts = new Set(data.accounts)
            updated = true
            logger.info({ count: cache.accounts.size }, 'account blacklist updated')
        } else {
            cache.failCount++
        }
    }

    if (updated) {
        cache.lastFetch = Date.now()
        cache.failCount = 0
    }

    return updated
}

/**
 * Check if cache needs refresh and update if necessary
 */
async function ensureFreshCache(): Promise<void> {
    const now = Date.now()
    const age = now - cache.lastFetch

    if (age > CACHE_TTL) {
        await updateCache()
    }
}

/**
 * Initialize blacklist service with static fallbacks
 */
export function initBlacklistService(staticImages: string[], staticAccounts: string[]) {
    staticImageBlacklist = staticImages.map(normalizeUrl)
    staticAccountBlacklist = staticAccounts

    // Initialize cache with static data
    cache.images = new Set(staticImageBlacklist)
    cache.accounts = new Set(staticAccounts)
    cache.lastFetch = Date.now()

    logger.info({
        imageCount: staticImages.length,
        accountCount: staticAccounts.length
    }, 'blacklist service initialized with static data')

    // Fetch fresh data in background (don't await)
    updateCache().catch((err) => {
        logger.error({ err }, 'initial blacklist update failed')
    })

    // Set up periodic refresh
    setInterval(() => {
        updateCache().catch((err) => {
            logger.error({ err }, 'periodic blacklist update failed')
        })
    }, CACHE_TTL)
}

/**
 * Check if image URL is blacklisted
 */
export async function isImageBlacklisted(url: string): Promise<boolean> {
    await ensureFreshCache()
    const normalized = normalizeUrl(url)

    // Check dynamic cache first
    if (cache.images.has(normalized)) {
        return true
    }

    // Fallback to static list
    if (staticImageBlacklist.includes(normalized)) {
        return true
    }

    return false
}

/**
 * Check if account is blacklisted
 */
export async function isAccountBlacklisted(account: string): Promise<boolean> {
    await ensureFreshCache()

    // Check dynamic cache first
    if (cache.accounts.has(account)) {
        return true
    }

    // Fallback to static list
    if (staticAccountBlacklist.includes(account)) {
        return true
    }

    return false
}

/**
 * Synchronous check (uses cached data only, suitable for high-frequency checks)
 */
export function isImageBlacklistedSync(url: string): boolean {
    const normalized = normalizeUrl(url)
    return cache.images.has(normalized) || staticImageBlacklist.includes(normalized)
}

/**
 * Synchronous check (uses cached data only, suitable for high-frequency checks)
 */
export function isAccountBlacklistedSync(account: string): boolean {
    return cache.accounts.has(account) || staticAccountBlacklist.includes(account)
}

/**
 * Get current cache stats (for monitoring/debugging)
 */
export function getBlacklistStats() {
    return {
        images: {
            cached: cache.images.size,
            static: staticImageBlacklist.length
        },
        accounts: {
            cached: cache.accounts.size,
            static: staticAccountBlacklist.length
        },
        lastFetch: new Date(cache.lastFetch).toISOString(),
        cacheAge: Date.now() - cache.lastFetch,
        failCount: cache.failCount
    }
}

/**
 * Force refresh of blacklist data (for admin use)
 */
export async function forceRefresh(): Promise<boolean> {
    cache.failCount = 0 // Reset fail count
    return await updateCache()
}
