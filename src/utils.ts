/** Misc utils. */

import { AbstractBlobStore, BlobKey } from 'abstract-blob-store'
import * as cloudflare from 'cloudflare'
import * as config from 'config'
import { createHash } from 'crypto'
import * as http from 'http'
import * as LRU from 'lru-cache'
import * as fileType from 'file-type'
import * as multihash from 'multihashes'
import * as needle from 'needle'
import * as Sharp from 'sharp'
import { URL } from 'url'

import { imageBlacklist } from './blacklist'
import { DEFAULT_FALLBACK_IMAGE_URL, isEmptyImageUrl } from './constants'
import { APIError } from './error'
import {fetchImageWithFallbacks} from './fetch-image'
import { logger } from './logger'


export const AcceptedContentTypes = [
    'image/gif',
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/svg+xml',
    'image/svg',
    'image/bmp',
    'image/apng',
    'image/avif',
]

export function parseBool(input: any): boolean {
    if (typeof input === 'string') {
        input = input.toLowerCase().trim()
    }
    switch (input) {
        case true:
        case 1:
        case '1':
        case 'y':
        case 'yes':
        case 'on':
            return true
        case 0:
        case false:
        case '0':
        case 'n':
        case 'no':
        case 'off':
            return false
        default:
            throw new Error(`Ambiguous boolean: ${input}`)
    }
}

export function camelToSnake(value: string) {
    return value.replace(/([A-Z])/g, (_, m) => `_${m.toLowerCase()}`).replace(/^_/, '')
}

export function readStream(stream: NodeJS.ReadableStream) {
    return new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = []
        stream.on('data', (chunk) => chunks.push(chunk))
        stream.on('error', reject)
        stream.on('end', () => resolve(Buffer.concat(chunks)))
    })
}

export async function mimeMagic(data: Buffer): Promise<string> {
    const result = await fileType.fromBuffer(data)
    if (result) {
        return result.mime
    }
    // file-type can't detect text-based formats — check for SVG
    const head = data.slice(0, 512).toString('utf8').trim()
    if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) {
        return 'image/svg+xml'
    }
    return 'application/octet-stream'
}

export function storeExists(store: AbstractBlobStore, key: BlobKey) {
    return new Promise<boolean>((resolve, reject) => {
        store.exists(key, (error, exists) => {
            if (error) { reject(error) } else { resolve(exists) }
        })
    })
}

export function storeWrite(store: AbstractBlobStore, key: BlobKey, data: Buffer | string) {
    return new Promise((resolve, reject) => {
        const stream = store.createWriteStream(key, (error, metadata) => {
            if (error) { reject(error) } else { resolve(metadata) }
        })
        stream.write(data)
        stream.end()
    })
}

export function base58Enc(value: string): string {
    return multihash.toB58String(Buffer.from(value, 'utf8'))
}

export function base58Dec(value: string): string {
    return multihash.fromB58String(value).toString('utf8')
}

const cache = new LRU({
    max: 500,
    length: (n: string | Buffer, key: string) => n.length,
    maxAge: 1000 * 60 * 60,
})

export function setCacheSize(size: number) {
    cache.max = size
}

export function cacheGet(key: string): any {
    return cache.get(key)
}

export function cacheSet(key: string, val: string | Buffer) {
    return cache.set(key, val)
}

export interface NeedleResponse extends http.IncomingMessage {
    body: any
    raw: Buffer
    bytes: number
    cookies?: { [name: string]: any }
}

export function fetchUrl(url: string, options: needle.NeedleOptions) {
    return new Promise<NeedleResponse>((resolve, reject) => {
        needle.get(url, options, (error, response) => {
            if (error) { reject(error) } else { resolve(response) }
        })
    })
}

export enum ScalingMode {
    Cover,
    Fit,
}

export enum OutputFormat {
    Match,
    JPEG,
    PNG,
    WEBP,
}

export interface ProxyOptions {
    width?: number
    height?: number
    mode: ScalingMode
    format: OutputFormat
    ignorecache?: number
    invalidate?: number
    refetch?: number
}

export function getImageKey(origKey: string, options: ProxyOptions): string {
    if (options.mode === ScalingMode.Fit && options.format === OutputFormat.Match) {
        return `${origKey}_${options.width || 0}x${options.height || 0}`
    }
    const rv = [origKey, ScalingMode[options.mode], OutputFormat[options.format]]
    if (options.width) { rv.push(options.width.toFixed(0)) }
    if (options.height) { rv.push(options.height.toFixed(0)) }
    return rv.join('_')
}
export function getUrlHashKey(input: string): string {
    const hash = createHash('sha1').update(input).digest('hex')
    return 'U' + hash
}
export async function getSharpMetadataWithRetry(
    origData: Buffer,
    urlString: string,
    urlParams: string,
    userAgent: string,
    fallbackUrl: string,
    logger: any
): Promise<{ buffer: Buffer; metadata: Sharp.Metadata; isFallback: boolean }> {
    const image = Sharp(origData, { failOnError: false })

    try {
        const metadata = await image.metadata()
        return { buffer: origData, metadata, isFallback: false }
    } catch (err) {
        logger.error({err, urlString, msg: 'Sharp metadata() failed, attempting fallback image fetch'})

        // Try alternate source once
        let fallback
        try {
            fallback = await fetchImageWithFallbacks(urlString, urlParams, userAgent, fallbackUrl, logger, {
                skipUrls: [urlString], // prevent infinite loop
            })
        } catch (fetchErr) {
            logger.error({
                err: fetchErr,
                msg: 'metadata fallback fetch also failed',
                urlString,
                fallbackUrl
            })
            throw err // rethrow original metadata error
        }

        const fallbackImage = Sharp(fallback.res.body, { failOnError: false })
        try {
            const metadata = await fallbackImage.metadata()
            return { buffer: fallback.res.body, metadata, isFallback: fallback.isFallback }
        } catch (err2) {
            logger.error({
                err: err2,
                msg: 'metadata() failed even after fallback fetch',
                urlString,
                fallbackUrl
            })
            throw err2
        }
    }
}
export function parsePlainUrl(value: string): URL {
    try {
        return new URL(value)
    } catch (cause) {
        throw new APIError({ cause, code: APIError.Code.InvalidProxyUrl })
    }
}

export function safeParseInt(value: any): number | undefined {
    const basicNumber = parseInt(value, 10)
    return isNaN(basicNumber) ? undefined : basicNumber
}

export function parseProxiedUrl(value: string): URL {
    try {
        const decoded = base58Dec(value).replace(/\/+$/, '')
        return new URL(decoded)
    } catch (cause) {
        // Fail fast on decode errors - do not accept raw URLs as this is a security risk
        // Return default fallback image instead
        return new URL(DEFAULT_FALLBACK_IMAGE_URL)
    }
}

export function getDefaultUrlAndParams(customUrl?: string): { url: URL, urlParams: string } {
    const url = new URL(customUrl || config.get('default_avatar') as string)
    const urlParams = 'vM1pGHgNcyCbee5hzZJ19JZfuFzCeUv7mVFKdbzGrntDxJQjefptCVeKGsJnTRuspM7ZCQNsZPYavwqkqhFzqyp8hgu9UfPdQtqjeZ5vtuTMwqp59vtT39W12n1qMu1EXZwzJpN'
    return { url, urlParams }
}


export function getProxyImageLimits() {
    return {
        maxWidth: safeParseInt(config.get('proxy_store.max_image_width')) || 1280,
        maxHeight: safeParseInt(config.get('proxy_store.max_image_height')) || 1280,
        maxCustomWidth: safeParseInt(config.get('proxy_store.max_custom_image_width')) || 8000,
        maxCustomHeight: safeParseInt(config.get('proxy_store.max_custom_image_height')) || 8000,
    }
}

export function purgeCache(value: string) {
    if (!config.has('cloudflare_token') || !config.has('cloudflare_zone')) {
        return
    }
    const CF_KEY = config.get('cloudflare_token') as string
    const CF_ZONE = config.get('cloudflare_zone') as string
    const cf = new cloudflare({ token: CF_KEY })
    cf.zones.purgeCache(CF_ZONE, { files: [value] }).catch((err) => {
        // Log but don't throw - cache purging is not critical
        logger.error({ err }, 'Cloudflare cache purge failed')
    })
}

export function stripWebpOrPng(value: string): string {
    return value.replace(/\.(webp|png)$/, '')
}

/**
 * Detect WebP support from Accept header for content negotiation
 */
export function supportsWebP(acceptHeader: string): boolean {
    return acceptHeader.toLowerCase().includes('image/webp')
}

export function sanitizeIgnoreInvalidateParams(url: URL): URL {
    return new URL(
        url.toString()
            .replace(/[&?]ignorecache=1/, '')
            .replace(/[&?]invalidate=1/, '')
            .replace(/ignorecache|invalidate/, '')
    )
}

export function isBlacklistedUrl(url: string): boolean {
    // Only check for exact matches of the empty 0x0 URL, not URLs that start with it
    return imageBlacklist.includes(url) || isEmptyImageUrl(url)
}

export function getOrigKeyFromUrl(url: URL, isUpload: boolean): string {
    if (isUpload) {
        return url.pathname.slice(1).split('/')[0]
    }
    const urlHash = createHash('sha1').update(url.toString()).digest()
    return 'U' + multihash.toB58String(multihash.encode(urlHash, 'sha1'))
}
export function buildSharpPipeline(buffer: Buffer) {
    return Sharp(buffer, { failOnError: false }).jpeg({
        quality: 80, force: false
    }).png({
        quality: 80, compressionLevel: 9, force: false
    }).heif({
        compression: 'hevc', force: false
    }).webp({
        quality: 80, alphaQuality: 80, force: false
    })
}

export function storeRemove(store: AbstractBlobStore, key: string): Promise<void> {
    return new Promise((resolve, reject) => {
        store.remove({ key }, (err) => {
            if (err) {
                return reject(err)
            }
            resolve()
        })
    })
}
