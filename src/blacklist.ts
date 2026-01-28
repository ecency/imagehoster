/** Upload and proxying blacklists. */

import * as fs from 'fs'
import * as path from 'path'
import {
    initBlacklistService,
    isImageBlacklistedSync,
    isAccountBlacklistedSync,
} from './blacklist-service'
import { logger } from './logger'

interface Blacklist<T> {
    includes: (item: T) => boolean
}

interface BlacklistData {
    images?: string[]
    accounts?: string[]
    updated?: string
    version?: string
}

/**
 * Load blacklist data from JSON file
 */
function loadBlacklistFile(filepath: string, type: 'images' | 'accounts'): string[] {
    try {
        const fullPath = path.resolve(__dirname, '..', filepath)

        if (!fs.existsSync(fullPath)) {
            logger.warn({ filepath: fullPath }, `blacklist file not found, using empty ${type} list`)
            return []
        }

        const content = fs.readFileSync(fullPath, 'utf8')
        const data: BlacklistData = JSON.parse(content)

        const items = type === 'images' ? data.images : data.accounts

        if (!Array.isArray(items)) {
            logger.warn({ filepath: fullPath }, `invalid blacklist format for ${type}`)
            return []
        }

        logger.info({
            filepath: fullPath,
            count: items.length,
            version: data.version,
            updated: data.updated
        }, `loaded ${type} blacklist from file`)

        return items
    } catch (error) {
        logger.error({ error, filepath }, `failed to load ${type} blacklist file`)
        return []
    }
}

// Load static blacklists from JSON files
const staticImageBlacklist = loadBlacklistFile('blacklist-images.json', 'images')
const staticAccountBlacklist = loadBlacklistFile('blacklist-accounts.json', 'accounts')

// Initialize the blacklist service with static data
// This will also start fetching from remote URLs if configured
initBlacklistService(staticImageBlacklist, staticAccountBlacklist)

// Export dynamic blacklist objects that check both remote and static lists
export const imageBlacklist: Blacklist<string> = {
    includes: (url: string) => isImageBlacklistedSync(url)
}

export const accountBlacklist: Blacklist<string> = {
    includes: (account: string) => isAccountBlacklistedSync(account)
}
