/**
 * Clear every cache layer when a user's avatar or cover changes.
 *
 * `/u/<user>/avatar` and `/u/<user>/cover` keep their URL when the image behind
 * them changes, so Varnish (1h + 1h grace) and the CDN (max-age=3600) keep the
 * old bytes until they expire. This module:
 *
 * 1. Records which avatar and cover URL each fresh profile lookup resolved to.
 *    When the next fresh lookup resolves to a different URL, it queues a clear:
 *    ban the user's paths in Varnish, then purge them at the CDN. Varnish goes
 *    first, or the CDN would refill from Varnish's stale copy. A clear stays
 *    queued until both layers confirm, then runs once more for in-flight renders.
 * 2. Follows the chain so that a fresh lookup happens soon after an
 *    `account_update`, instead of whenever a request happens to reach the origin.
 *
 * Pending work is a Redis sorted set, so a restart or lock handover loses none.
 *
 * The record lives for longer than every cache layer holds a response. A user
 * with no record has nothing cached in our layers, so their updates are skipped.
 */

import config from 'config'
import { FETCH_DEADLINE_MS } from './constants'
import { HiveProfile, redisClient, redisGet, redisReady, redisSet, refreshProfile, rpc } from './common'
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
        : ['cover', 'cover/']
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
    purgeCdn: (urls: string[]): Promise<boolean> => purgeCache(urls),
}

/**
 * Varnish first, then the CDN, since a CDN miss refills from Varnish. The CDN
 * is purged even after a failed ban, because the Varnish copy may already have
 * expired. `cdnOnly` retries just the purge after a ban that already succeeded.
 */
export async function clearOnce(user: string, kind: ImageKind, cdnOnly = false): Promise<{ banned: boolean, purged: boolean }> {
    const origin = new URL(config.get('service_url') as string).origin
    const banned = cdnOnly ? true : await invalidators.banVarnish(user, kind)
    const purged = await invalidators.purgeCdn(imagePaths(user, kind).map((path) => `${origin}${path}`))
    return { banned, purged }
}

// --- Durable work queue ------------------------------------------------------
//
// Pending refreshes and clears live in one Redis sorted set, scored by when
// they are due, so a worker restart or a lock handover loses nothing. Members:
//   refresh|<user>|<n>                    fresh profile lookup number n
//   clear|<user>|<kind>|<pass>|<since>|<part>
//                                         clear pass 1 or 2 of a change seen at <since>;
//                                         part is `all`, or `cdn` once the ban succeeded
// Adding a member that already exists only moves its due time.
//
// A worker claims a due member by moving its due time to the end of a lease,
// atomically, so two lock holders never run the same one. Finishing removes
// it, but only if nobody moved it since (a newer update re-adding a refresh, or
// a retry). A worker that dies mid-task leaves the member to come due again
// when the lease ends, so claimed work is never lost.

const DUE_KEY = 'profile-watch:due'

const CLAIM_SCRIPT = `
local due = redis.call('ZSCORE', KEYS[1], ARGV[1])
if due and tonumber(due) <= tonumber(ARGV[2]) then
  redis.call('ZADD', KEYS[1], ARGV[3], ARGV[1])
  return 1
end
return 0`

const RETRY_SCRIPT = `
local due = redis.call('ZSCORE', KEYS[1], ARGV[1])
if due and tonumber(due) == tonumber(ARGV[2]) then
  redis.call('ZADD', KEYS[1], ARGV[3], ARGV[1])
end
return 0`

const FINISH_SCRIPT = `
local due = redis.call('ZSCORE', KEYS[1], ARGV[1])
if due and tonumber(due) == tonumber(ARGV[2]) then
  redis.call('ZREM', KEYS[1], ARGV[1])
end
return 0`

/** Mockable queue. Tests replace these with an in-memory version. */
export const queue = {
    add: async (member: string, dueAt: number): Promise<void> => {
        if (!redisClient) return
        if (redisReady) await redisReady
        await redisClient.zAdd(DUE_KEY, { score: dueAt, value: member })
    },
    due: async (now: number, limit: number): Promise<string[]> => {
        if (!redisClient) return []
        if (redisReady) await redisReady
        return redisClient.zRangeByScore(DUE_KEY, 0, now, { LIMIT: { offset: 0, count: limit } })
    },
    /** Lease a due member until `leaseUntil`. True when the work is this caller's. */
    claim: async (member: string, now: number, leaseUntil: number): Promise<boolean> => {
        if (!redisClient) return false
        if (redisReady) await redisReady
        const claimed = await redisClient.eval(CLAIM_SCRIPT, {
            keys: [DUE_KEY], arguments: [member, String(now), String(leaseUntil)],
        })
        return claimed === 1
    },
    /** Move a claimed member to a retry time, unless it was moved since the claim. */
    retry: async (member: string, leaseUntil: number, dueAt: number): Promise<void> => {
        if (!redisClient) return
        if (redisReady) await redisReady
        await redisClient.eval(RETRY_SCRIPT, { keys: [DUE_KEY], arguments: [member, String(leaseUntil), String(dueAt)] })
    },
    /** Remove a finished member, unless it was moved since the claim. */
    finish: async (member: string, leaseUntil: number): Promise<void> => {
        if (!redisClient) return
        if (redisReady) await redisReady
        await redisClient.eval(FINISH_SCRIPT, { keys: [DUE_KEY], arguments: [member, String(leaseUntil)] })
    },
}

/**
 * A render that read the old profile before the change can finish after the
 * first clear and be cached again. Renders are bounded by the fetch deadline, so
 * a second pass after it catches those. A failed pass retries until GIVE_UP,
 * by when every cache layer has expired the old image on its own.
 */
export const timing = {
    secondPassMs: FETCH_DEADLINE_MS + 15_000,
    /** First retry delay. Later ones back off to half the time since the change. */
    retryMs: 30_000,
    maxRetryMs: 15 * 60 * 1000,
    giveUpMs: 2 * 60 * 60 * 1000,
    /** One drain stops starting work after this, well inside the 30s lock lease. */
    runBudgetMs: 15_000,
    /** Longer than any single task (RPC retries, ban and purge timeouts). */
    claimLeaseMs: 2 * 60 * 1000,
}

const retryDelay = (now: number, since: number) =>
    Math.min(timing.maxRetryMs, Math.max(timing.retryMs, (now - since) / 2))

/**
 * Called with each freshly fetched profile. Records what it resolves to and
 * queues a clear for whichever image differs from the last record. The record
 * moves on at once; the queued clear is what stays pending until it succeeds.
 */
export async function noteProfileImages(user: string, profile: HiveProfile, now = Date.now()): Promise<void> {
    const p = (profile.metadata && profile.metadata.profile) || {}
    const next: ServedImages = { avatar: httpOrEmpty(p.profile_image), cover: httpOrEmpty(p.cover_image) }
    const prev = await imageRecord.get(user)
    const changed: ImageKind[] = []
    if (prev && prev.avatar !== next.avatar) changed.push('avatar')
    if (prev && prev.cover !== next.cover) changed.push('cover')
    // Queue before moving the record: if queueing fails, the record still holds
    // the old value and the next fresh lookup sees the change again.
    for (const kind of changed) {
        await queue.add(`clear|${user}|${kind}|1|${now}|all`, now)
    }
    await imageRecord.set(user, next)
    if (changed.length > 0) {
        logger.info({ user, kinds: changed }, 'profile image changed, cache clear queued')
    }
}

/** hivemind trails the chain by a few blocks. Look twice to ride that out. */
export const REFRESH_DELAYS_MS = [20_000, 90_000]

/**
 * Queue fresh lookups for a recorded user after an account update. Another
 * update before they run pushes them back, so the last update always gets
 * the full window.
 */
export async function scheduleRefresh(user: string, now = Date.now()): Promise<void> {
    if (!(await imageRecord.get(user))) {
        return
    }
    for (let i = 0; i < REFRESH_DELAYS_MS.length; i++) {
        await queue.add(`refresh|${user}|${i}`, now + REFRESH_DELAYS_MS[i])
    }
}

/**
 * Run whatever is due. Each member is leased first and removed only once its
 * work is done; a retry re-adds it with a later due time instead. A task that
 * throws keeps its lease and comes due again when it ends. Stops starting new
 * work once the time budget is spent, so a drain stays inside the lock lease.
 */
export async function runDue(now = Date.now(), limit = 50): Promise<void> {
    const stopAt = Date.now() + timing.runBudgetMs
    const leaseUntil = now + timing.claimLeaseMs
    for (const member of await queue.due(now, limit)) {
        if (Date.now() > stopAt) {
            break
        }
        if (!(await queue.claim(member, now, leaseUntil))) {
            continue
        }
        try {
            await runTask(member, now, leaseUntil)
        } catch (err) {
            logger.warn({ err, member }, 'profile watcher task failed, retrying after its lease')
        }
    }
}

async function runTask(member: string, now: number, leaseUntil: number): Promise<void> {
    const [type, user, kind, pass, sinceRaw, part] = member.split('|')
    if (type === 'refresh') {
        // A fresh lookup that records the result, which queues any clear.
        // Retry a failed or incomplete lookup while the user still has a
        // record; the record expires, which bounds the retries. A newer update
        // that re-added this refresh meanwhile keeps its later time.
        if (!(await refreshProfile(user)) && await imageRecord.get(user)) {
            await queue.retry(member, leaseUntil, now + timing.retryMs)
            return
        }
        await queue.finish(member, leaseUntil)
        return
    }
    const since = Number(sinceRaw)
    if (type !== 'clear' || (kind !== 'avatar' && kind !== 'cover') || !Number.isFinite(since)) {
        await queue.finish(member, leaseUntil)
        return
    }
    const { banned, purged } = await clearOnce(user, kind, part === 'cdn')
    if (banned && purged) {
        if (pass === '1') {
            await queue.add(`clear|${user}|${kind}|2|${since}|all`, now + timing.secondPassMs)
        }
    } else if (now - since > timing.giveUpMs) {
        logger.error({ user, kind }, 'cache clear still failing, giving up; caches expire on their own')
    } else {
        // A failed ban retries both, since the purge must follow it. A failed
        // purge after a good ban retries only the purge.
        const retry = `clear|${user}|${kind}|${pass}|${since}|${banned ? 'cdn' : 'all'}`
        await queue.add(retry, now + retryDelay(now, since))
        if (retry === member) {
            return
        }
    }
    await queue.finish(member, leaseUntil)
}

// --- Chain watcher -----------------------------------------------------------

const LOCK_KEY = 'profile-watch:lock'
const CURSOR_KEY = 'profile-watch:block'
const LOCK_TTL = 30
const POLL_MS = 3000
const ERROR_PAUSE_MS = 30_000
const MAX_BLOCKS_PER_POLL = 50
/** Beyond this lag (3h, the record TTL) the records have expired, so restart at head. */
const MAX_LAG_BLOCKS = 3600

/**
 * Accounts whose profile an op may have changed: any write to either metadata
 * field. bridge reads `posting_json_metadata` and falls back to `json_metadata`,
 * and a write without a profile can still remove one. Empty strings mean "leave
 * unchanged" on chain, so those are skipped. Only recorded users are looked up,
 * so the breadth costs little.
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
            const written = (field: any) => typeof field === 'string' && field !== ''
            if (typeof value.account === 'string' && (written(value.posting_json_metadata) || written(value.json_metadata))) {
                users.add(value.account)
            }
        }
    }
    return [...users]
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

/**
 * Read new blocks and queue lookups. The cursor advances only after the queue
 * writes for those blocks succeeded, so a crash replays them (harmless: queueing
 * twice only moves the due time) rather than skipping them.
 */
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
 * lock lets one of them do the work and another take over if it dies. The
 * queue is in Redis, so the new holder picks up whatever was pending.
 * Without Redis there is no record to compare against, so it does nothing.
 */
export function startProfileWatcher(): void {
    if (!redisClient) {
        return
    }
    const id = `${process.pid}-${Math.random().toString(36).slice(2)}`
    let running = false
    let pausedUntil = 0
    const tick = async () => {
        if (running) return
        running = true
        try {
            if (redisReady) await redisReady
            if (!(await holdLock(id))) {
                return
            }
            // Drain first and on its own: queued clears must not wait on a
            // failing chain node.
            try {
                await runDue()
            } catch (err) {
                logger.warn({ err }, 'profile watcher drain failed')
            }
            if (Date.now() >= pausedUntil) {
                try {
                    await poll()
                } catch (err) {
                    // Back off instead of retrying a failing node every 3 seconds.
                    pausedUntil = Date.now() + ERROR_PAUSE_MS
                    logger.warn({ err }, 'profile watcher poll failed, pausing')
                }
            }
        } catch (err) {
            logger.warn({ err }, 'profile watcher tick failed')
        } finally {
            running = false
        }
    }
    setInterval(tick, POLL_MS).unref()
}
