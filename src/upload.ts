/** Uploads file to blob store. */
import {cryptoUtils, ExtendedAccount, PrivateKey, PublicKey, Signature} from '@hiveio/dhive'
import * as Busboy from 'busboy'
import * as config from 'config'
import {createHash} from 'crypto'
import * as http from 'http'
import * as multihash from 'multihashes'
import * as RateLimiter from 'ratelimiter'
import {URL} from 'url'

import {accountBlacklist} from './blacklist'
import {getAccount, getProfile, KoaContext, redisClient, rpcClient, uploadStore} from './common'
import {APIError} from './error'
import {AcceptedContentTypes, readStream, storeExists, storeWrite} from './utils'

const SERVICE_URL = new URL(config.get('service_url'))
const MAX_IMAGE_SIZE = Number.parseInt(config.get('max_image_size'))
if (!Number.isFinite(MAX_IMAGE_SIZE)) {
    throw new Error('Invalid max image size')
}
const UPLOAD_LIMITS = config.get('upload_limits') as any

if (new URL('http://blä.se').toString() !== 'http://xn--bl-wia.se/') {
    throw new Error('Incompatible node.js version, must be compiled with ICU support')
}

/**
 * Parse multi-part request and return first file found.
 */
async function parseMultipart(request: http.IncomingMessage) {
    return new Promise<{stream: NodeJS.ReadableStream, mime: string, name: string}>((resolve, reject) => {
        const form = new Busboy({
            headers: request.headers,
            limits: {
                files: 1,
                fileSize: MAX_IMAGE_SIZE,
            }
        })
        form.on('file', (field, stream, name, encoding, mime) => {
            name = name.replace(/[^a-z0-9.]/gi, '_').replace(/_{2,}/g, '_').toLowerCase()
            resolve({stream, mime, name})
        })
        form.on('error', reject)
        form.on('finish', () => {
            reject(new APIError({code: APIError.Code.FileMissing}))
        })
        request.pipe(form)
    })
}

interface RateLimit {
    remaining: number
    reset: number
    total: number
}

/**
 * Get ratelimit info for account name.
 */
async function getRatelimit(account: string) {
    return new Promise<any>((resolve, reject) => {
        if (!redisClient) {
            throw new Error('Redis not configured')
        }
        const limit = new RateLimiter({
            db: redisClient,
            duration: UPLOAD_LIMITS.duration,
            id: account,
            max: UPLOAD_LIMITS.max,
        })
        limit.get((error, result) => {
            if (error) {
                reject(error)
            } else {
                resolve(result)
            }
        })
    })
}
const b64uLookup = {
    '/': '_', _: '/', '+': '-', '-': '+', '=': '.', '.': '=',
}
function b64uToB64 (str: string) {
    const tt = str.replace(/(-|_|\.)/g, function(m) { return b64uLookup[m]})
    return tt
}
export async function uploadHsHandler(ctx: KoaContext) {
    ctx.tag({handler: 'hsupload'})
    let validSignature = false
    ctx.log.warn('uploadHsHandler triggered for %s', ctx.get('Origin'))

    APIError.assert(ctx.method === 'POST', {code: APIError.Code.InvalidMethod})
    APIError.assertParams(ctx.params, ['accesstoken'])
    APIError.assert(ctx.get('content-type').includes('multipart/form-data'),
                    {message: 'Only multipart uploads are supported'})
    const contentLength = Number.parseInt(ctx.get('content-length'))

    APIError.assert(Number.isFinite(contentLength),
                    APIError.Code.LengthRequired)

    APIError.assert(contentLength <= MAX_IMAGE_SIZE,
                    APIError.Code.PayloadTooLarge)

    const file = await parseMultipart(ctx.req)
    if (!file.name || !file.name.includes('.')) {
        const ext = file && file.mime && file.mime.split('/')[1] || 'png'
        file.name = `image-${Date.now()}.${ext}`
    }
    const data = await readStream(file.stream)

    // extra check if client manges to lie about the content-length
    APIError.assert((file.stream as any).truncated !== true,
                    APIError.Code.PayloadTooLarge)

    APIError.assert(AcceptedContentTypes.includes(file.mime), APIError.Code.InvalidImage)

    const imageHash = createHash('sha256')
        .update('ImageSigningChallenge')
        .update(data)
        .digest()

    const token = ctx.params['accesstoken']
    const decoded = Buffer.from(b64uToB64(token), 'base64').toString()
    const tokenObj = JSON.parse(decoded)
    const signedMessage = tokenObj.signed_message
    if (
        tokenObj.authors
        && tokenObj.authors[0]
        && tokenObj.signatures
        && tokenObj.signatures[0]
        && signedMessage
        && signedMessage.type
        && ['login', 'posting', 'offline', 'code', 'refresh']
        .includes(signedMessage.type)
        && signedMessage.app
    ) {

        const signature = tokenObj.signatures[0];
        const message = JSON.stringify({
                signed_message: signedMessage,
                authors: tokenObj.authors,
                timestamp: tokenObj.timestamp,
        })
        const hash = cryptoUtils.sha256(message)
        const username = tokenObj.authors[0]

        const [account]: ExtendedAccount[] = await getAccount(username, false)
        APIError.assert(account, APIError.Code.NoSuchAccount)
        ctx.log.warn('uploading app %s', signedMessage.app)

        APIError.assert(username === account.name, APIError.Code.InvalidSignature)
        // when logged in with posting key but got hivesigner token from offline renew
        const broadcasterPrivKey = PrivateKey.fromString(UPLOAD_LIMITS.app_posting_wif)
        const broadcasterPubKey = broadcasterPrivKey.createPublic()

        if (broadcasterPubKey.verify(hash, Signature.fromString(signature))) {
            validSignature = true
        }
        // when authorized app account or if signed message with own keys
        if (account && account.name) {
            ['posting', 'active', 'owner'].forEach((type) => {
                account[type].account_auths.forEach((key: string[]) => {
                    if (
                    !validSignature
                    && key[0] === UPLOAD_LIMITS.app_account
                    ) {
                    validSignature = true
                    }
                })
                account[type].key_auths.forEach((key: string[]) => {
                    if (
                        !validSignature
                        && PublicKey.fromString(key[0]).verify(hash, Signature.fromString(signature))
                    ) {
                        validSignature = true
                    }
                })
            })
        }

        APIError.assert(validSignature, APIError.Code.InvalidSignature)
        APIError.assert(!accountBlacklist.includes(account.name), APIError.Code.Blacklisted)

        let limit: RateLimit = {total: 0, remaining: Infinity, reset: 0}
        try {
            limit = await getRatelimit(account.name)
        } catch (error) {
            ctx.log.warn(error, 'unable to enforce upload rate limits')
        }

        APIError.assert(limit.remaining > 0, APIError.Code.QoutaExceeded)

        // Use get_profile for accurate reputation (get_accounts returns incorrect data)
        const profile = await getProfile(username, false)
        APIError.assert(profile && profile.reputation >= UPLOAD_LIMITS.reputation, APIError.Code.Deplorable)

        const key = 'D' + multihash.toB58String(multihash.encode(imageHash, 'sha2-256'))
        const url = new URL(`${ key }/${ file.name }`, SERVICE_URL)

        if (!(await storeExists(uploadStore, key))) {
            try {
                await storeWrite(uploadStore, key, data)
            } catch (cause) {
                ctx.log.error({ err: cause, key, uploader: account.name }, 'failed to write uploaded image to storage')
                throw new APIError({ cause, code: APIError.Code.InternalError, message: 'Failed to store uploaded image' })
            }
        } else {
            ctx.log.debug('key %s already exists in store', key)
        }

        ctx.log.info({uploader: account.name, size: data.byteLength}, 'image uploaded')

        ctx.status = 200
        ctx.body = {url}
    }
}

export async function uploadHandler(ctx: KoaContext) {
    ctx.tag({handler: 'upload'})

    APIError.assert(ctx.method === 'POST', {code: APIError.Code.InvalidMethod})
    APIError.assertParams(ctx.params, ['username', 'signature'])

    APIError.assert(ctx.get('content-type').includes('multipart/form-data'),
                    {message: 'Only multipart uploads are supported'})

    const contentLength = Number.parseInt(ctx.get('content-length'))

    APIError.assert(Number.isFinite(contentLength),
                    APIError.Code.LengthRequired)

    APIError.assert(contentLength <= MAX_IMAGE_SIZE,
                    APIError.Code.PayloadTooLarge)

    const file = await parseMultipart(ctx.req)
    if (!file.name || !file.name.includes('.')) {
        const ext = file && file.mime && file.mime.split('/')[1] || 'png'
        file.name = `image-${Date.now()}.${ext}`
    }
    const data = await readStream(file.stream)

    // extra check if client manges to lie about the content-length
    APIError.assert((file.stream as any).truncated !== true,
                    APIError.Code.PayloadTooLarge)

    const imageHash = createHash('sha256')
        .update('ImageSigningChallenge')
        .update(data)
        .digest()

    const [account]: ExtendedAccount[] = await getAccount(ctx.params['username'].toLowerCase(), false)
    APIError.assert(account, APIError.Code.NoSuchAccount)

    let validSignature = false
    let publicKey

    if (ctx.params['signature'].startsWith('hive')) {
        const signature = ctx.params['signature'].replace('hive', '').replace('signer', '')
        const decoded = Buffer.from(signature, 'base64').toString()
        const tokenObj = JSON.parse(decoded)
        const signedMessage = tokenObj.signed_message

        if (
            tokenObj.authors
            && tokenObj.authors[0]
            && tokenObj.signatures
            && tokenObj.signatures[0]
            && signedMessage
            && signedMessage.type
            && ['login', 'posting', 'offline', 'code', 'refresh']
              .includes(signedMessage.type)
            && signedMessage.app
          ) {
                const message = JSON.stringify({
                    signed_message: signedMessage,
                    authors: tokenObj.authors,
                    timestamp: tokenObj.timestamp,
                })
                const signs = tokenObj.signatures[0]

                const hash = cryptoUtils.sha256(message)
                const broadcasterPrivKey = PrivateKey.fromString(UPLOAD_LIMITS.app_posting_wif)
                const broadcasterPubKey = broadcasterPrivKey.createPublic()

                if (broadcasterPubKey.verify(hash, Signature.fromString(signs))) {
                    validSignature = true
                }
                if (account && account.name) {
                    ['posting', 'active', 'owner'].forEach((type) => {
                        account[type].key_auths.forEach((key: string[]) => {
                            if (!validSignature
                                && PublicKey.fromString(key[0]).verify(hash, Signature.fromString(signs))
                            ) {
                                validSignature = true
                            }
                        })
                    })
                }
            }
    } else if (ctx.params['signature'].startsWith('stndt')) {
        // Legacy test mode - removed for security
        // This authentication bypass has been disabled as it poses a critical security risk
        throw new APIError({code: APIError.Code.InvalidSignature, message: 'Legacy test mode no longer supported'})
    } else {
        let signature: Signature
        try {
            signature = Signature.fromString(ctx.params['signature'])
        } catch (cause) {
            throw new APIError({code: APIError.Code.InvalidSignature, cause})
        }

        try {
            publicKey = signature.recover(imageHash).toString()
        } catch (cause) {
            throw new APIError({code: APIError.Code.InvalidSignature, cause})
        }

        const thresholdPosting = account.posting.weight_threshold
        for (const auth of account.posting.key_auths) {
            if (auth[0] === publicKey && auth[1] >= thresholdPosting) {
                validSignature = true
                break
            }
        }

        const thresholdActive = account.active.weight_threshold
        for (const auth of account.active.key_auths) {
            if (auth[0] === publicKey && auth[1] >= thresholdActive) {
                validSignature = true
                break
            }
        }
    }

    APIError.assert(validSignature, APIError.Code.InvalidSignature)
    APIError.assert(!accountBlacklist.includes(account.name), APIError.Code.Blacklisted)

    let limit: RateLimit = {total: 0, remaining: Infinity, reset: 0}
    try {
        limit = await getRatelimit(account.name)
    } catch (error) {
        ctx.log.warn(error, 'unable to enforce upload rate limits')
    }

    APIError.assert(limit.remaining > 0, APIError.Code.QoutaExceeded)

    // Use get_profile for accurate reputation (get_accounts returns incorrect data)
    const profile = await getProfile(ctx.params['username'].toLowerCase(), false)
    APIError.assert(profile && profile.reputation >= UPLOAD_LIMITS.reputation, APIError.Code.Deplorable)

    const key = 'D' + multihash.toB58String(multihash.encode(imageHash, 'sha2-256'))
    const url = new URL(`${ key }/${ file.name }`, SERVICE_URL)

    if (!(await storeExists(uploadStore, key))) {
        try {
            await storeWrite(uploadStore, key, data)
        } catch (cause) {
            ctx.log.error({ err: cause, key, uploader: account.name }, 'failed to write uploaded image to storage')
            throw new APIError({ cause, code: APIError.Code.InternalError, message: 'Failed to store uploaded image' })
        }
    } else {
        ctx.log.debug('key %s already exists in store', key)
    }

    ctx.log.info({uploader: account.name, size: data.byteLength}, 'image uploaded')

    ctx.status = 200
    ctx.body = {url}
}

// NOTE: repLog10() and log10() functions removed - get_profile API now returns
// accurate reputation values directly, no conversion needed
