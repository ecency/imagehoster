/** Misc shared instances. */
import {callRPC, config as hiveTxConfig} from '@ecency/sdk/hive'
import {AbstractBlobStore} from 'abstract-blob-store'
import cluster from 'cluster'
import config from 'config'
import { RouterContext } from '@koa/router'
import { createClient } from 'redis'
import {cache} from './cache'
import {APIError} from './error'
import {logger} from './logger'

const numWorkers = Number.parseInt(config.get('num_workers'))
const isPrimaryOnly = cluster.isPrimary && numWorkers > 1

/** Koa context extension with explicit property types. */
export interface KoaContext extends RouterContext {
    log: typeof logger
    tag: (metadata: any) => void
    req_id: string
    start_time: [number, number]
    imageKey?: string
    normalizedUrl?: string
    fallbackUsed?: boolean
    api_error?: APIError
    referrer?: string // Koa request referrer alias
}

/** Minimal Hive account type for signature verification. */
export interface HiveAccountAuthority {
    weight_threshold: number
    account_auths: Array<[string, number]>
    key_auths: Array<[string, number]>
}

export interface HiveAccount {
    name: string
    posting: HiveAccountAuthority
    active: HiveAccountAuthority
    owner: HiveAccountAuthority
    reputation: number | string
    [k: string]: any
}

/** hived RPC config — @ecency/sdk uses module-level config, not a client instance. */
hiveTxConfig.nodes = [
    config.get('rpc_node') as string,
    'https://api.deathwing.me',
    'https://api.openhive.network',
    'https://rpc.mahdiyari.info',
    'https://api.syncad.com',
    'https://techcoderx.com',
    'https://hiveapi.actifit.io',
    'https://api.c0ff33a.uk',
]
// Per-request timeout. dhive's effective first-try timeout was ~500ms (hardcoded
// in client.js fetchTimeout), which caused frequent spurious failovers on slow
// nodes. @ecency/sdk honors this value directly on the actual fetch.
// Keep this generous enough to tolerate a slow-but-alive node.
hiveTxConfig.timeout = 3000
// Retry budget: default is 8, meaning up to 9 attempts per call. That
// multiplies against `timeout` for a worst-case wall clock of ~27s on total
// RPC outage — unacceptable for request-path operations (avatar/cover/upload
// auth). Cap at 2 retries = 3 attempts = ~9s worst case.
hiveTxConfig.retry = 2

/**
 * Mockable RPC wrapper. Tests monkey-patch `rpc.call` to return fixtures.
 * Must be a plain object property (not a frozen export) so reassignment works.
 */
export const rpc = {
    call: async <T = any>(method: string, params?: any[] | object): Promise<T> => {
        return callRPC<T>(method, params)
    },
}

/** Try to get a value from Redis shared cache. */
export async function redisGet(key: string): Promise<any | undefined> {
    if (!redisClient) return undefined
    if (redisReady) await redisReady
    if (!redisClient.isReady) return undefined
    try {
        const val = await redisClient.get(key)
        return val ? JSON.parse(val) : undefined
    } catch { return undefined }
}

/** Set a value in Redis shared cache with TTL in seconds. */
export async function redisSet(key: string, value: any, ttl: number): Promise<void> {
    if (!redisClient) return
    if (redisReady) await redisReady
    if (!redisClient.isReady) return
    try {
        await redisClient.setEx(key, ttl, JSON.stringify(value))
    } catch { /* best effort */ }
}

/** Get account with full authority data (for signature verification) */
export const getAccount = async (user: string, isCached= true): Promise<HiveAccount[]> => {
    const cacheKey = `profile:account:${user}`
    if (isCached) {
        const cached = await redisGet(cacheKey)
        if (cached !== undefined) {
            return (cached === null ? [] : cached) as HiveAccount[]
        }
    }
    if (user.length > 16) return [] as HiveAccount[]
    try {
        const account = await rpc.call<HiveAccount[]>('condenser_api.get_accounts', [[user]])
        await redisSet(cacheKey, account, 300)
        return account || []
    } catch (e) {
        logger.error({ err: e, user }, 'Unable to load account from hived')
        await redisSet(cacheKey, null, 30)
        return [] as HiveAccount[]
    }
}

export interface HiveProfile {
    name: string
    active: string
    created: string
    id: number
    post_count: number
    reputation: number
    blacklists: string[]
    stats: { followers: number, following: number, rank: number }
    metadata: { profile: {
        name?: string
        about?: string
        profile_image?: string
        cover_image?: string
        website?: string
        location?: string
    }}
}

const isHttpUrl = (v: unknown): v is string =>
    typeof v === 'string' &&
    (v.startsWith('http://') || v.startsWith('https://')) &&
    v.includes('.') // require a host (domain/IP) — rejects pathological 'https://'

/** Parse a `*_json_metadata` string and return its `.profile` object, or undefined. */
function parseProfile(raw: unknown): Record<string, any> | undefined {
    if (typeof raw !== 'string' || raw.length === 0) return undefined
    try {
        const obj = JSON.parse(raw)
        const prof = obj && obj.profile
        return prof && typeof prof === 'object' ? prof : undefined
    } catch { return undefined }
}

/**
 * Field-level legacy image lookup: posting_json_metadata.profile.<field> dominates,
 * else fall back to json_metadata.profile.<field>. Returns the value only when it is
 * an http(s) URL.
 *
 * Needed because `bridge.get_profile` (PostgREST hivemind) reads ONLY
 * posting_json_metadata and no longer falls back to the legacy json_metadata when
 * posting_json_metadata is a non-empty object without a usable `profile` image
 * (older hivemind's get_db_profile did). Avatars/covers stored only in json_metadata
 * therefore come back empty from bridge; we recover them from the raw account here.
 */
function legacyProfileImage(
    account: HiveAccount | undefined,
    field: 'profile_image' | 'cover_image',
): string | undefined {
    if (!account) return undefined
    const posting = parseProfile(account.posting_json_metadata)
    if (posting && isHttpUrl(posting[field])) return posting[field]
    const legacy = parseProfile(account.json_metadata)
    if (legacy && isHttpUrl(legacy[field])) return legacy[field]
    return undefined
}

/** Get account profile (simplified data for avatar/cover, no JSON parsing needed) */
export const getProfile = async (user: string, isCached= true): Promise<HiveProfile | undefined> => {
    const cacheKey = `profile:hive:${user}`
    if (isCached) {
        const cached = await redisGet(cacheKey)
        if (cached !== undefined) {
            // null = negative cache (RPC failed), return undefined to trigger fallback
            return cached === null ? undefined : cached as HiveProfile
        }
    }
    if (user.length > 16) return undefined
    let profile: HiveProfile | undefined
    try {
        profile = await rpc.call<HiveProfile>('bridge.get_profile', {account: user})
        if (profile) {
            let ttl = 300
            const p = profile.metadata && profile.metadata.profile
            // Legacy fallback: when bridge returns no avatar, the image may live only in the
            // account's legacy json_metadata (which the PostgREST hivemind ignores). Do ONE
            // extra (cached) account lookup to recover it. We gate strictly on a MISSING
            // AVATAR — deliberately NOT on a missing cover: most accounts have an avatar but
            // no cover, so triggering on cover would fire this second RPC on the hot avatar
            // path for nearly everyone. The cover is still recovered opportunistically from
            // the same lookup, so the common broken case (posting profile-less, both images
            // only in json_metadata) is fully healed; the rare "working posting avatar +
            // legacy-only cover" case intentionally keeps the default cover.
            if (p && !isHttpUrl(p.profile_image)) {
                const account = (await getAccount(user, isCached))[0]
                if (account) {
                    const avatar = legacyProfileImage(account, 'profile_image')
                    if (avatar) p.profile_image = avatar
                    if (!isHttpUrl(p.cover_image)) {
                        const cover = legacyProfileImage(account, 'cover_image')
                        if (cover) p.cover_image = cover
                    }
                } else {
                    // bridge said the account exists, so an empty getAccount result means a
                    // transient get_accounts failure — cache briefly so we retry the merge soon.
                    ttl = 30
                }
            }
            await redisSet(cacheKey, profile, ttl)
        } else {
            // Null/undefined result — negative cache with short TTL
            await redisSet(cacheKey, null, 30)
        }
    } catch (e: any) {
        logger.error({ err: e, user }, 'Unable to load account profile from hived')
        // Cache the failure for 30s to prevent thundering herd on RPC outages
        await redisSet(cacheKey, null, 30)
    }
    return profile
}

/** Redis client — only created in worker processes. */
export let redisClient: ReturnType<typeof createClient> | undefined
export let redisReady: Promise<void> | undefined
if (!isPrimaryOnly && config.has('redis_url') && config.get('redis_url')) {
    const redisOptions: any = {
        url: config.get('redis_url') as string,
    }
    if (config.has('redis_password')) {
        redisOptions.password = config.get('redis_password') as string
    }
    redisClient = createClient(redisOptions)
    redisClient.on('error', (err) => {
        logger.error({ err }, 'Redis client error')
    })
    redisReady = redisClient.connect().then(() => {
        logger.info('Redis connected')
    }).catch((err) => {
        logger.error({ err }, 'Redis initial connection failed, rate limiting will fail until reconnect')
    })
} else if (!isPrimaryOnly) {
    logger.warn('redis not configured, will not rate-limit uploads')
}

/** Sliding-window rate limiter using Redis sorted sets (no legacy mode needed). */
export interface RateLimit {
    remaining: number
    reset: number
    total: number
}

export async function getRatelimit(account: string, max: number, duration: number): Promise<RateLimit> {
    if (!redisClient) {
        throw new Error('Redis not configured')
    }
    if (redisReady) {
        await redisReady
    }
    if (!redisClient.isReady) {
        throw new Error('Redis not connected')
    }
    const key = `limit:${account}`
    const now = Date.now() * 1000 // microseconds
    const start = now - duration * 1000
    const member = `${now}:${Math.random().toString(36).slice(2, 10)}`

    const results = await redisClient.multi()
        .zRemRangeByScore(key, 0, start)
        .zAdd(key, { score: now, value: member })
        .zCard(key)
        .zRange(key, 0, 0)
        .zRange(key, -max, -max)
        .zRemRangeByRank(key, 0, -(max + 1))
        .pExpire(key, duration)
        .exec()

    const count = results[2] as number
    const oldestArr = results[3] as string[]
    const rangeArr = results[4] as string[]
    const oldest = oldestArr.length > 0 ? parseInt(oldestArr[0], 10) : now
    const oldestInRange = rangeArr.length > 0 ? parseInt(rangeArr[0], 10) : NaN
    const resetMicro = (isNaN(oldestInRange) ? oldest : oldestInRange) + duration * 1000

    return {
        remaining: count < max ? max - count : 0,
        reset: Math.floor(resetMicro / 1000000),
        total: max,
    }
}

/** Blob storage — only initialized in worker processes. */

import { S3Client } from '@aws-sdk/client-s3'
import { S3BlobStore } from './s3-store'
import { ShardedFsStore } from './sharded-fs-store'

let s3Client: S3Client | undefined
function loadStore(key: string): AbstractBlobStore {
    const conf = config.get(key) as any
    if (conf.type === 'fs') {
        const fsPath = conf.get('s3_bucket')
        if (!fsPath) { throw new Error(`${key}.s3_bucket path is required for fs store type`) }
        logger.warn('using sharded file store for %s at %s', key, fsPath)
        return new ShardedFsStore(fsPath) as any
    } else if (conf.type === 'memory') {
        logger.warn('using memory store for %s', key)
        return require('abstract-blob-store')()
    } else if (conf.type === 's3') {
        if (!s3Client) {
            const rawEndpoint = config.get('S3_ENDPOINT') as string
            const endpoint = rawEndpoint.includes('://') ? rawEndpoint : `https://${rawEndpoint}`
            s3Client = new S3Client({
                credentials: {
                    accessKeyId: config.get('S3_ACCESS_KEY_ID') as string,
                    secretAccessKey: config.get('S3_SECRET_ACCESS_KEY') as string,
                },
                endpoint,
                region: config.get('S3_REGION') as string,
                forcePathStyle: true,
            })
        }
        return new S3BlobStore({
            client: s3Client,
            bucket: conf.get('s3_bucket'),
        }) as any
    } else {
        throw new Error(`Invalid storage type: ${ conf.type }`)
    }
}

// Primary process only manages workers — no stores needed
export const uploadStore: AbstractBlobStore = isPrimaryOnly ? undefined! : loadStore('upload_store')
export const proxyStore: AbstractBlobStore = isPrimaryOnly ? undefined! : loadStore('proxy_store')
