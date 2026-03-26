/** Misc shared instances. */
import {Client, ExtendedAccount} from '@hiveio/dhive'
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

/** hived (jussi) RPC client. */
export const rpcClient = new Client([config.get('rpc_node'),
      'https://api.deathwing.me',
      'https://rpc.mahdiyari.info',
      'https://api.openhive.network',
      'https://techcoderx.com',
      'https://api.syncad.com'
    ], {
    timeout: 2000,
    failoverThreshold: 2
})

/** Get account with full authority data (for signature verification) */
export const getAccount = async (user, isCached= true) => {
    let account = isCached ? cache.get(`${user}:account`) : undefined
    if (account === undefined && user.length <= 16) {
      account = await rpcClient.database.getAccounts([user])
      cache.set(`${user}:account`, account, 300)
    }
    return account as ExtendedAccount[]
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

/** Get account profile (simplified data for avatar/cover, no JSON parsing needed) */
export const getProfile = async (user, isCached= true) => {
    let profile = isCached ? cache.get(`${user}:profile`) as HiveProfile : undefined
    if (profile === undefined && user.length <= 16) {
      try {
        profile = await rpcClient.call('bridge', 'get_profile', {account: user}) as HiveProfile
        cache.set(`${user}:profile`, profile, 300)
      } catch (e: any) {
        // "account does not exist" errors should propagate so callers can return 404
        if (e.info && JSON.stringify(e.info).includes('does not exist')) {
          throw e
        }
        logger.error({ err: e, user }, 'Unable to load account profile from hived')
      }
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

let s3Client: S3Client | undefined
function loadStore(key: string): AbstractBlobStore {
    const conf = config.get(key) as any
    if (conf.type === 'fs') {
        const fsPath = conf.get('s3_bucket') || '/mnt/eproxy-bucket'
        logger.warn('using file store for %s at %s', key, fsPath)
        return require('fs-blob-store')(fsPath)
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
