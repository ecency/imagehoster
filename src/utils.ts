/** Misc utils. */

import { AbstractBlobStore, BlobKey } from 'abstract-blob-store'
import config from 'config'
import { createHash } from 'crypto'
import * as fileType from 'file-type'
import * as fs from 'fs'
import * as http from 'http'
import * as multihash from 'multihashes'
import * as needle from 'needle'
import * as path from 'path'
import Sharp from 'sharp'
import { URL } from 'url'

import { domainBlacklist, imageBlacklist } from './blacklist'
import { DEFAULT_FALLBACK_IMAGE_URL, INTERNAL_SERVICE_ORIGINS, isEmptyImageUrl, MAX_INPUT_PIXELS } from './constants'
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
    'image/heic',
    'image/heif',
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
        stream.on('error', (err) => {
            if ((stream as any).destroy) { (stream as any).destroy() }
            reject(err)
        })
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

interface PutBufferStore {
    putBuffer(key: string, buf: Buffer): Promise<void>
}

function hasPutBuffer(store: any): store is PutBufferStore {
    return typeof store.putBuffer === 'function'
}

export async function storeWrite(store: AbstractBlobStore, key: BlobKey, data: Buffer | string) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data)
    // Use direct buffer upload for S3 stores (avoids stream double-buffering)
    if (hasPutBuffer(store)) {
        const k = typeof key === 'string' ? key : (key as any).key
        await store.putBuffer(k, buf)
        return { key: k }
    }
    return new Promise((resolve, reject) => {
        const stream = store.createWriteStream(key, (error, metadata) => {
            if (error) { reject(error) } else { resolve(metadata) }
        })
        stream.write(buf)
        stream.end()
    })
}

export function base58Enc(value: string): string {
    return multihash.toB58String(Buffer.from(value, 'utf8'))
}

export function base58Dec(value: string): string {
    return multihash.fromB58String(value).toString('utf8')
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
    AVIF,
}

export interface ProxyOptions {
    width?: number
    height?: number
    mode: ScalingMode
    format: OutputFormat
    ignorecache?: number
    invalidate?: number
    blur?: boolean
}

export function getImageKey(origKey: string, options: ProxyOptions): string {
    if (options.mode === ScalingMode.Fit && options.format === OutputFormat.Match) {
        return `${origKey}_${options.width || 0}x${options.height || 0}${options.blur ? '_blur' : ''}`
    }
    const rv = [origKey, ScalingMode[options.mode], OutputFormat[options.format]]
    if (options.width) { rv.push(options.width.toFixed(0)) }
    if (options.height) { rv.push(options.height.toFixed(0)) }
    if (options.blur) { rv.push('blur') }
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
    const image = Sharp(origData, { failOnError: false, limitInputPixels: MAX_INPUT_PIXELS })

    try {
        const metadata = await image.metadata()
        return { buffer: origData, metadata, isFallback: false }
    } catch (err) {
        logger.error({ err, urlString }, 'Sharp metadata() failed, attempting fallback image fetch')

        // Try alternate source once
        let fallback
        try {
            fallback = await fetchImageWithFallbacks(urlString, urlParams, userAgent, fallbackUrl, logger, {
                skipUrls: [urlString], // prevent infinite loop
            })
        } catch (fetchErr) {
            logger.error({
                err: fetchErr,
                urlString,
                fallbackUrl
            }, 'metadata fallback fetch also failed')
            throw err // rethrow original metadata error
        }

        const fallbackImage = Sharp(fallback.res.body, { failOnError: false, limitInputPixels: MAX_INPUT_PIXELS })
        try {
            const metadata = await fallbackImage.metadata()
            return { buffer: fallback.res.body, metadata, isFallback: fallback.isFallback }
        } catch (err2) {
            logger.error({
                err: err2,
                urlString,
                fallbackUrl
            }, 'metadata() failed even after fallback fetch')
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
    const urlStr = customUrl || config.get('default_avatar') as string
    const url = new URL(urlStr)
    const urlParams = base58Enc(url.toString())
    return { url, urlParams }
}

export function isInternalServiceUrl(url: URL): boolean {
    return INTERNAL_SERVICE_ORIGINS.includes(url.origin)
}

export function isInternalUploadUrl(url: URL): boolean {
    return isInternalServiceUrl(url) && url.pathname[1] === 'D'
}

export function isInternalProxyUrl(url: URL): boolean {
    return isInternalServiceUrl(url) && url.pathname.slice(0, 2) === '/p'
}

export function getProxyImageLimits() {
    return {
        maxWidth: safeParseInt(config.get('proxy_store.max_image_width')) || 1280,
        maxHeight: safeParseInt(config.get('proxy_store.max_image_height')) || 1280,
        maxCustomWidth: safeParseInt(config.get('proxy_store.max_custom_image_width')) || 8000,
        maxCustomHeight: safeParseInt(config.get('proxy_store.max_custom_image_height')) || 8000,
    }
}

export function purgeCache(value: string | string[]) {
    if (!config.has('cloudflare_token') || !config.has('cloudflare_zone')) {
        return
    }
    const CF_KEY = config.get('cloudflare_token') as string
    const CF_ZONE = config.get('cloudflare_zone') as string
    const files = Array.isArray(value) ? value : [value]
    if (files.length === 0) {
        return
    }
    fetch(`https://api.cloudflare.com/client/v4/zones/${CF_ZONE}/purge_cache`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${CF_KEY}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ files }),
    }).then(async (res) => {
        const body = await res.json().catch(() => null) as any
        if (!res.ok || (body && !body.success)) {
            logger.error({ status: res.status, body, files }, 'Cloudflare cache purge failed')
        } else {
            logger.info({ files }, 'Cloudflare cache purged')
        }
    }).catch((err) => {
        logger.error({ err, files }, 'Cloudflare cache purge network error')
    })
}

export function stripWebpOrPng(value: string): string {
    return value.replace(/\.(webp|png)$/, '')
}

/**
 * Detect WebP support from Accept header for content negotiation
 */
export function supportsWebP(acceptHeader: string): boolean {
    return namesImageType(acceptHeader, 'image/webp')
}

/**
 * Detect AVIF support from Accept header for content negotiation
 */
export function supportsAvif(acceptHeader: string): boolean {
    return namesImageType(acceptHeader, 'image/avif')
}

/**
 * Accept entries with their q-values, most specific match first.
 *
 * Substring matching is not enough here: `image/png;q=0` contains `image/png`
 * while meaning the exact opposite, and `image/jpeg,image/*;q=0` contains a
 * wildcard while still enumerating.
 */
function parseAccept(acceptHeader: string): Array<{type: string, q: number}> {
    return acceptHeader
        .toLowerCase()
        .split(',')
        .map((part) => {
            const [type, ...params] = part.split(';').map((piece) => piece.trim())
            const qParam = params.find((param) => param.startsWith('q='))
            const q = qParam ? Number.parseFloat(qParam.slice(2)) : 1
            return {type, q: Number.isFinite(q) ? q : 1}
        })
        .filter((entry) => entry.type.length > 0)
}

/**
 * Whether the client named this exact type and did not reject it.
 *
 * Format negotiation asks this rather than `acceptsImageType`: a trailing
 * `*\/*;q=0.8` must not be read as AVIF or WebP support, or every browser would
 * be handed a format it never advertised.
 */
export function namesImageType(acceptHeader: string, type: string): boolean {
    const wanted = type.toLowerCase()
    return parseAccept(acceptHeader).some((entry) => entry.type === wanted && entry.q > 0)
}

/**
 * Whether the client left the door open for any image type.
 *
 * A client that enumerates image types (`image/webp,image/apng,*\/*;q=0.8` —
 * every browser image request looks like this) has told us what it decodes, so
 * a type missing from that list is a type it cannot read. A client that names
 * no image type at all (empty Accept, `*\/*` from curl and most bots, or an
 * `image/*` wildcard) told us nothing, so assume it copes rather than burning
 * CPU transcoding for it.
 */
export function acceptsAnyImageType(acceptHeader: string): boolean {
    // A named subtype enumerates even beside a wildcard, and a q=0 entry names
    // nothing — it rejects
    return !parseAccept(acceptHeader).some(
        (entry) => entry.q > 0 && entry.type.startsWith('image/') && entry.type !== 'image/*'
    )
}

/**
 * Whether the client will take this type, by the usual most-specific-match
 * rule: an exact entry decides on its own (including `;q=0`), otherwise the
 * type wildcard decides, otherwise `*\/*`. An empty Accept accepts anything.
 */
export function acceptsImageType(acceptHeader: string, type: string): boolean {
    const entries = parseAccept(acceptHeader)
    if (entries.length === 0) {
        return true
    }

    const wanted = type.toLowerCase()
    const wildcard = `${wanted.split('/')[0]}/*`
    const match = entries.find((entry) => entry.type === wanted) ||
        entries.find((entry) => entry.type === wildcard) ||
        entries.find((entry) => entry.type === '*/*')

    return match !== undefined && match.q > 0
}

/**
 * Whether a `OutputFormat.Match` response of this type would be undecodable.
 *
 * Match passes the original bytes through, which breaks for sources the
 * requesting client has no decoder for: HEIC/HEIF is renderable in almost no
 * browser, and an AVIF original reaching Match means negotiation already
 * established that this client did not advertise AVIF.
 */
export function needsMatchFallback(contentType: string, acceptHeader: string): boolean {
    const type = contentType.toLowerCase()
    if (type === 'image/heic' || type === 'image/heif') {
        return true
    }
    // AVIF is only undecodable for a client that enumerated its formats without it
    return type === 'image/avif' && !acceptsAnyImageType(acceptHeader)
}

/**
 * Pick an output format for a source the client cannot render. Returns the
 * content type to serve, and stages the conversion on the pipeline when one is
 * needed.
 *
 * PNG keeps transparency, but only for a client that will take PNG — replacing
 * one undecodable type with another would defeat the point. When alpha has to
 * go it is flattened onto white, since JPEG would otherwise composite it black.
 */
export function applyMatchFallbackFormat(
    image: Sharp.Sharp,
    contentType: string,
    acceptHeader: string,
    hasAlpha?: boolean
): string {
    if (!needsMatchFallback(contentType, acceptHeader)) {
        return contentType
    }

    // A trailing `*/*;q=0.8` counts, which is how browsers that name only a few
    // image types still leave PNG on the table
    if (hasAlpha && acceptsImageType(acceptHeader, 'image/png')) {
        image.png({force: true, compressionLevel: 9})
        return 'image/png'
    }

    if (hasAlpha) {
        image.flatten({background: '#ffffff'})
    }
    image.jpeg({quality: 80, force: true})
    return 'image/jpeg'
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
    return imageBlacklist.includes(url) || domainBlacklist.includes(url) || isEmptyImageUrl(url)
}

export function getOrigKeyFromUrl(url: URL, isUpload: boolean): string {
    if (isUpload) {
        return url.pathname.slice(1).split('/')[0]
    }
    const urlHash = createHash('sha1').update(url.toString()).digest()
    return 'U' + multihash.toB58String(multihash.encode(urlHash, 'sha1'))
}
export function buildSharpPipeline(buffer: Buffer, animated: boolean = false) {
    return Sharp(buffer, { failOnError: false, animated, limitInputPixels: MAX_INPUT_PIXELS })
}

function isPrivateIPv4(host: string): boolean {
    return (
        host === 'localhost' ||
        host === '0.0.0.0' ||
        host.startsWith('127.') ||
        host.startsWith('10.') ||
        host.startsWith('192.168.') ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
        host.startsWith('169.254.') ||
        host.endsWith('.local')
    )
}

function mappedIPv6ToDotted(hexTail: string): string | undefined {
    // hexTail is e.g. "7f00:1" (Node normalizes/compresses hex)
    const parts = hexTail.split(':')
    if (parts.length !== 2) { return undefined }
    const hi = parts[0].padStart(4, '0')
    const lo = parts[1].padStart(4, '0')
    if (hi.length !== 4 || lo.length !== 4) { return undefined }
    return [
        parseInt(hi.slice(0, 2), 16),
        parseInt(hi.slice(2, 4), 16),
        parseInt(lo.slice(0, 2), 16),
        parseInt(lo.slice(2, 4), 16),
    ].join('.')
}

export function assertPublicUrl(url: URL): void {
    const err = { code: APIError.Code.InvalidProxyUrl, message: 'Private URLs not allowed' }
    // Only allow http and https
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new APIError(err)
    }
    // Strip brackets (IPv6) and trailing dot (FQDN)
    const lower = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '')

    if (isPrivateIPv4(lower)) {
        throw new APIError(err)
    }

    // IPv6 loopback and unspecified
    if (lower === '::1' || lower === '::') {
        throw new APIError(err)
    }
    // IPv6 link-local fe80::/10 (fe80:: through febf::)
    if (/^fe[89ab][0-9a-f]:/.test(lower)) {
        throw new APIError(err)
    }
    // IPv6 ULA fc00::/7 (fc00:: through fdff::) — only match IPv6 literals (contain :)
    if (/^f[cd][0-9a-f]{2}:/.test(lower)) {
        throw new APIError(err)
    }

    // IPv4-mapped IPv6 (::ffff:a.b.c.d or ::ffff:XXYY:ZZWW)
    const mapped = lower.match(/^::ffff:(.+)$/)
    if (mapped) {
        const tail = mapped[1]
        if (tail.includes('.')) {
            // Dotted form: ::ffff:127.0.0.1
            if (isPrivateIPv4(tail)) { throw new APIError(err) }
        } else {
            // Hex form: ::ffff:7f00:1 (Node normalizes to this)
            const dotted = mappedIPv6ToDotted(tail)
            if (dotted && isPrivateIPv4(dotted)) { throw new APIError(err) }
        }
    }
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

/** Stream directory entries and delete matches in-place — O(1) memory. */
async function removeFsKeysByPrefix(store: AbstractBlobStore, root: string, prefix: string): Promise<number> {
    let dir
    try {
        dir = await fs.promises.opendir(root)
    } catch (err: any) {
        if (err && err.code === 'ENOENT') { return 0 }
        throw err
    }
    let count = 0
    for await (const entry of dir) {
        if (entry.name.startsWith(prefix)) {
            try {
                await storeRemove(store, entry.name)
                count++
            } catch (err) {
                logger.error({ err, key: entry.name }, 'failed to remove key during prefix deletion')
            }
        }
    }
    return count
}

export async function storeRemoveByPrefix(store: AbstractBlobStore, prefix: string): Promise<number> {
    const customRemoveByPrefix = (store as any).removeByPrefix
    if (typeof customRemoveByPrefix === 'function') {
        return await customRemoveByPrefix.call(store, prefix)
    }

    const memoryData = (store as any).data
    if (memoryData && typeof memoryData === 'object') {
        const keys = Object.keys(memoryData).filter((key) => key.startsWith(prefix))
        for (const key of keys) {
            delete memoryData[key]
        }
        return keys.length
    }

    const root = (store as any).path
    if (typeof root === 'string') {
        return await removeFsKeysByPrefix(store, root, prefix)
    }

    logger.warn({ prefix }, 'store does not support prefix invalidation')
    return 0
}
