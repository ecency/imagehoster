/** Misc shared instances. */
import {Client, ExtendedAccount} from '@hiveio/dhive'
import {AbstractBlobStore} from 'abstract-blob-store'
import * as config from 'config'
import {IRouterContext} from 'koa-router'
import * as Redis from 'redis'
import {cache} from './cache'
import {APIError} from './error'
import {logger} from './logger'

/** Koa context extension with explicit property types. */
export interface KoaContext extends IRouterContext {
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

/** Steemd (jussi) RPC client. */
export const rpcClient = new Client([config.get('rpc_node'),
    'https://hive-api.arcange.eu',
    'https://api.openhive.network',
    'https://techcoderx.com',
    'https://api.c0ff33a.uk',
    ], {
    timeout: 2000,
    failoverThreshold: 2
})

/** Get account with full authority data (for signature verification) */
export const getAccount = async (user, isCached= true) => {
    let account = isCached ? cache.get(`${user}:account`) : undefined
    if (account === undefined && user.length <= 16) {
      try {
        account = await rpcClient.database.getAccounts([user])
        cache.set(`${user}:account`, account, 30)
      } catch (e) {
        logger.error({ err: e, user }, 'Unable to load account from hived')
      }
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
        cache.set(`${user}:profile`, profile, 30)
      } catch (e) {
        logger.error({ err: e, user }, 'Unable to load account profile from hived')
      }
    }
    return profile
}

/** Redis client. */
export let redisClient: Redis.RedisClient | undefined
if (config.has('redis_url') && config.get('redis_url')) {
    const redisOptions: any = {
        url: config.get('redis_url') as string
    }
    if (config.has('redis_password')) {
        redisOptions.password = config.get('redis_password') as string
    }
    redisClient = Redis.createClient(redisOptions)
} else {
    logger.warn('redis not configured, will not rate-limit uploads')
}

/** Blob storage. */

let S3Client: any
function loadStore(key: string): AbstractBlobStore {
    const conf = config.get(key) as any
    if (conf.type === 'fs') {
        logger.warn('using file store for %s', key)
        return require('fs-blob-store')('/mnt/eproxy-bucket')
    } else if (conf.type === 'memory') {
        logger.warn('using memory store for %s', key)
        return require('abstract-blob-store')()
    } else if (conf.type === 's3') {
        if (!S3Client) {
            const aws = require('aws-sdk')

            // Use new unified credentials, fallback to legacy credentials for backward compatibility
            const accessKeyId = config.get('S3_ACCESS_KEY_ID')
            const secretAccessKey = config.get('S3_SECRET_ACCESS_KEY')
            const endpoint = config.get('S3_ENDPOINT')
            const region = config.get('S3_REGION')

            S3Client = new aws.S3({
                accessKeyId,
                secretAccessKey,
                endpoint,
                region,
                s3ForcePathStyle: true, // needed with minio?
                signatureVersion: 'v4'
            })
        }
        return require('s3-blob-store')({
            client: S3Client,
            bucket: conf.get('s3_bucket'),
        })
    } else {
        throw new Error(`Invalid storage type: ${ conf.type }`)
    }
}

export const uploadStore = loadStore('upload_store')
export const proxyStore = loadStore('proxy_store')
