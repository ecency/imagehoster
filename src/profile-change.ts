/**
 * Clear every cache layer when a user's avatar or cover changes.
 *
 * `/u/<user>/avatar` and `/u/<user>/cover` keep their URL when the image behind
 * them changes, so Varnish (1h + 1h grace) and the CDN (max-age=3600) keep the
 * old bytes until they expire. This module:
 *
 * 1. Records which avatar and cover URL each fresh profile lookup resolved to.
 *    When the next fresh lookup resolves to a different URL, it bans the user's
 *    paths in Varnish and then purges them at the CDN. Varnish goes first, or
 *    the CDN would refill from Varnish's stale copy.
 * 2. Follows the chain so that a fresh lookup happens soon after an
 *    `account_update`, instead of whenever a request happens to reach the origin.
 *
 * The record lives for longer than every cache layer holds a response. A user
 * with no record has nothing cached in our layers, so their updates are skipped.
 */

import config from 'config'
import { FETCH_DEADLINE_MS } from './constants'
import { getProfile, HiveProfile, redisClient, redisGet, redisReady, redisSet, rpc } from './common'
import { logger } from './logger'
import { purgeCache } from './utils'

export type ImageKind = 'avatar' | 'cover'

/** The URLs a user's images resolved to. '' means none, so the default was served. */
export interface ServedImages {
    avatar: string
    cover: string
}

/** Longer than Varnish ttl + grace (2h) and the CDN max-age (1h). */
const RECORD_TTL = 3 * 60 * 60

/** Mockable record store. Tests replace `get`/`set`. */
export const imageRecord = {
    get: async (user: string): Promise<ServedImages | undefined> => redisGet(`profile:images:${user}`),
    set: async (user: string, value: ServedImages): Promise<void> => redisSet(`profile:images:${user}`, value, RECORD_TTL),
}

const httpOrEmpty = (value: any): string =>
    typeof value === 'string' && /^https?:\/\//.test(value) ? value : ''

/**
 * Every path that serves a user's avatar or cover. The `/webp/u/...` routes only
 * redirect to these, so their cached responses never go stale.
 */
export function imagePaths(user: string, kind: ImageKind): string[] {
    const tails = kind === 'avatar'
        ? ['avatar', 'avatar/', 'avatar/small', 'avatar/medium', 'avatar/large']
        : ['cover']
    return tails.map((tail) => `/u/${user}/${tail}`)
}

/**
 * Ban one user's avatar or cover in Varnish: every size, route and hostname.
 * The VCL builds the ban from the two headers, so this cannot ban anything else.
 */
export async function banVarnish(url: string, user: string, kind: ImageKind): Promise<boolean> {
    try {
        const res = await fetch(url, {
            method: 'BAN',
            headers: { 'X-Ban-User': user, 'X-Ban-Kind': kind },
            signal: AbortSignal.timeout(3000),
        })
        if (!res.ok) {
            logger.error({ user, kind, status: res.status }, 'Varnish ban refused')
            return false
        }
        return true
    } catch (err) {
        logger.error({ err, user, kind }, 'Varnish ban failed')
        return false
    }
}

/** Mockable side effects. Tests replace these to observe calls. */
export const invalidators = {
    /** Without `varnish_url` (local development) there is no Varnish to clear. */
    banVarnish: async (user: string, kind: ImageKind): Promise<boolean> => {
        const url = config.has('varnish_url') ? config.get('varnish_url') as string : ''
        return url ? banVarnish(url, user, kind) : true
    },
    /** purgeCache expands each URL to both service hostnames. */
    purgeCdn: (urls: string[]) => purgeCache(urls),
}

/**
 * A render that read the old profile before the change can finish after the
 * first ban and be cached again. Renders are bounded by the fetch deadline, so a
 * second pass after it catches those.
 */
export const timing = { secondPassMs: FETCH_DEADLINE_MS + 15_000 }

/** Clear the given kinds for a user now, and once more after the slowest render. */
export async function invalidateUserImages(user: string, kinds: ImageKind[]): Promise<void> {
    await clearOnce(user, kinds)
    setTimeout(() => {
        clearOnce(user, kinds).catch((err) => logger.error({ err, user }, 'second cache clear failed'))
    }, timing.secondPassMs).unref()
    logger.info({ user, kinds }, 'profile image changed, caches cleared')
}

/** Varnish first, then the CDN, since a CDN miss refills from Varnish. */
async function clearOnce(user: string, kinds: ImageKind[]): Promise<void> {
    const origin = new URL(config.get('service_url') as string).origin
    const urls: string[] = []
    for (const kind of kinds) {
        // A failed ban is logged and the CDN is purged anyway: the Varnish copy
        // may already have expired, and the purge costs nothing if it has not.
        await invalidators.banVarnish(user, kind)
        urls.push(...imagePaths(user, kind).map((path) => `${origin}${path}`))
    }
    invalidators.purgeCdn(urls)
}

/**
 * Called with each freshly fetched profile. Records what it resolves to and
 * clears the caches for whichever image differs from the last record.
 */
export async function noteProfileImages(user: string, profile: HiveProfile): Promise<void> {
    const p = (profile.metadata && profile.metadata.profile) || {}
    const next: ServedImages = { avatar: httpOrEmpty(p.profile_image), cover: httpOrEmpty(p.cover_image) }
    const prev = await imageRecord.get(user)
    await imageRecord.set(user, next)
    if (!prev) {
        return
    }
    const changed: ImageKind[] = []
    if (prev.avatar !== next.avatar) changed.push('avatar')
    if (prev.cover !== next.cover) changed.push('cover')
    if (changed.length > 0) {
        await invalidateUserImages(user, changed)
    }
}

// --- Chain watcher -----------------------------------------------------------

const LOCK_KEY = 'profile-watch:lock'
const CURSOR_KEY = 'profile-watch:block'
const LOCK_TTL = 30
const POLL_MS = 3000
const MAX_BLOCKS_PER_POLL = 50
/** Beyond this lag (3h, the record TTL) the records have expired, so restart at head. */
const MAX_LAG_BLOCKS = 3600
/** hivemind trails the chain by a few blocks. Refresh twice to ride that out. */
export const REFRESH_DELAYS_MS = [20_000, 90_000]

/**
 * Accounts whose profile an op may have changed. bridge reads the profile from
 * `posting_json_metadata`, so any write to it counts, even one without a
 * profile, since that drops the avatar. `json_metadata` is only the legacy
 * fallback and other apps write unrelated keys to it, so there only a
 * `profile` object counts.
 */
export function profileUpdates(block: any): string[] {
    const users = new Set<string>()
    for (const tx of (block && block.transactions) || []) {
        for (const op of tx.operations || []) {
            const type = op && op.type
            if (type !== 'account_update_operation' && type !== 'account_update2_operation') {
                continue
            }
            const value = op.value || {}
            const posting = typeof value.posting_json_metadata === 'string' && value.posting_json_metadata !== ''
            const legacy = typeof value.json_metadata === 'string' && value.json_metadata.includes('"profile"')
            if (typeof value.account === 'string' && (posting || legacy)) {
                users.add(value.account)
            }
        }
    }
    return [...users]
}

const scheduled = new Set<string>()

/** Refresh a recorded user's profile after the chain change reaches hivemind. */
export async function scheduleRefresh(user: string, delays = REFRESH_DELAYS_MS): Promise<void> {
    if (scheduled.has(user) || !(await imageRecord.get(user))) {
        return
    }
    scheduled.add(user)
    delays.forEach((delay, i) => {
        setTimeout(() => {
            // getProfile with the cache off rewrites the profile cache, then calls
            // noteProfileImages, which does the comparison and the clearing.
            getProfile(user, false)
                .catch((err) => logger.error({ err, user }, 'profile refresh failed'))
                .finally(() => { if (i === delays.length - 1) scheduled.delete(user) })
        }, delay).unref()
    })
}

async function holdLock(id: string): Promise<boolean> {
    if (!redisClient || !redisClient.isReady) {
        return false
    }
    if (await redisClient.set(LOCK_KEY, id, { NX: true, EX: LOCK_TTL }) === 'OK') {
        return true
    }
    if (await redisClient.get(LOCK_KEY) === id) {
        await redisClient.expire(LOCK_KEY, LOCK_TTL)
        return true
    }
    return false
}

async function poll(): Promise<void> {
    const props = await rpc.call<any>('condenser_api.get_dynamic_global_properties', [])
    const head = Number(props && props.head_block_number)
    if (!head) {
        return
    }
    let cursor = Number(await redisGet(CURSOR_KEY)) || 0
    if (!cursor || head - cursor > MAX_LAG_BLOCKS) {
        cursor = head
    }
    if (cursor > head) {
        return
    }
    const count = Math.min(MAX_BLOCKS_PER_POLL, head - cursor + 1)
    const res = await rpc.call<any>('block_api.get_block_range', { starting_block_num: cursor, count })
    const blocks: any[] = (res && res.blocks) || []
    for (const block of blocks) {
        for (const user of profileUpdates(block)) {
            await scheduleRefresh(user)
        }
    }
    // An empty range means the node is not there yet: retry the same block.
    if (blocks.length > 0) {
        await redisSet(CURSOR_KEY, cursor + blocks.length, 24 * 60 * 60)
    }
}

/**
 * Start following the chain in this process. Every worker calls this; a Redis
 * lock lets one of them do the work and another take over if it dies.
 * Without Redis there is no record to compare against, so it does nothing.
 */
export function startProfileWatcher(): void {
    if (!redisClient) {
        return
    }
    const id = `${process.pid}-${Math.random().toString(36).slice(2)}`
    let running = false
    const tick = async () => {
        if (running) return
        running = true
        try {
            if (redisReady) await redisReady
            if (await holdLock(id)) {
                await poll()
            }
        } catch (err) {
            logger.warn({ err }, 'profile watcher poll failed')
        } finally {
            running = false
        }
    }
    setInterval(tick, POLL_MS).unref()
}
