/** Uploads file to blob store. */
import {PrivateKey, PublicKey, Signature} from '@ecency/sdk/hive'
import Busboy from 'busboy'
import config from 'config'
import {createHash} from 'crypto'
import * as http from 'http'
import * as multihash from 'multihashes'
import {URL} from 'url'

import {accountBlacklist} from './blacklist'
import {getAccount, getProfile, getRatelimit, HiveAccount, HiveAccountAuthority, KoaContext, redisClient, uploadStore} from './common'
import {APIError} from './error'
import {logger} from './logger'
import {AcceptedContentTypes, mimeMagic, readStream, storeExists, storeWrite} from './utils'

const SERVICE_URL = new URL(config.get('service_url'))
const MAX_IMAGE_SIZE = Number.parseInt(config.get('max_image_size'))
if (!Number.isFinite(MAX_IMAGE_SIZE)) {
    throw new Error('Invalid max image size')
}
const UPLOAD_LIMITS = config.get('upload_limits') as any

/**
 * True when `signature` was produced by a key that satisfies this authority on
 * its own.
 *
 * A key only counts when its own weight reaches the threshold, so a low-weight
 * key meant to be combined with others cannot authorise an upload by itself.
 * This mirrors the direct upload path below.
 */
function authoritySignedBy(
    authority: HiveAccountAuthority | undefined,
    hash: Buffer,
    signature: Signature,
): boolean {
    if (!authority || !Array.isArray(authority.key_auths)) {
        return false
    }
    for (const [key, weight] of authority.key_auths) {
        if (weight < authority.weight_threshold) {
            continue
        }
        try {
            if (PublicKey.fromString(key).verify(hash, signature)) {
                return true
            }
        } catch (cause) {
            // A key we cannot parse is not a reason to abandon the remaining ones.
            continue
        }
    }
    return false
}

/**
 * Public key for the app's configured posting WIF, or undefined when that WIF is
 * unset or unparseable.
 *
 * Derived once, and deliberately non-fatal: `PrivateKey.fromString('')` throws
 * ("Private key network id mismatch"), so deriving it per request meant an unset
 * or rotated-out WIF failed every HiveSigner upload with a 500 before any
 * verification ran. A missing WIF only means this one check is unavailable; the
 * token can still verify against the account's own keys or the delegate's.
 */
const broadcasterPubKey: PublicKey | undefined = (() => {
    const wif = UPLOAD_LIMITS.app_posting_wif
    if (!wif) {
        return undefined
    }
    try {
        return PrivateKey.fromString(wif).createPublic()
    } catch (cause) {
        logger.error({cause}, 'upload_limits.app_posting_wif is set but is not a valid private key')
        return undefined
    }
})()

/** True when `account` has granted `delegate` posting or active authority at full weight. */
function hasDelegatedTo(account: HiveAccount, delegate: string): boolean {
    for (const type of ['posting', 'active']) {
        const authority: HiveAccountAuthority = account[type]
        if (!authority || !Array.isArray(authority.account_auths)) {
            continue
        }
        for (const [name, weight] of authority.account_auths) {
            if (name === delegate && weight >= authority.weight_threshold) {
                return true
            }
        }
    }
    return false
}

if (new URL('http://blä.se').toString() !== 'http://xn--bl-wia.se/') {
    throw new Error('Incompatible node.js version, must be compiled with ICU support')
}

/**
 * Parse multi-part request and return first file found.
 */
async function parseMultipart(request: http.IncomingMessage) {
    return new Promise<{stream: NodeJS.ReadableStream, mime: string, name: string}>((resolve, reject) => {
        const form = Busboy({
            headers: request.headers,
            limits: {
                files: 1,
                fileSize: MAX_IMAGE_SIZE,
            }
        })
        form.on('file', (field, stream, info) => {
            const raw = info.filename || ''
            const name = raw.replace(/[^a-z0-9.]/gi, '_').replace(/_{2,}/g, '_').toLowerCase()
            resolve({stream, mime: info.mimeType, name})
        })
        form.on('error', reject)
        form.on('finish', () => {
            reject(new APIError({code: APIError.Code.FileMissing}))
        })
        request.pipe(form)
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

    const actualMime = await mimeMagic(data)
    APIError.assert(AcceptedContentTypes.includes(actualMime), APIError.Code.InvalidImage)
    APIError.assert(actualMime !== 'image/svg+xml' && actualMime !== 'image/svg', APIError.Code.InvalidImage)

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

        const signature = tokenObj.signatures[0]
        const message = JSON.stringify({
                signed_message: signedMessage,
                authors: tokenObj.authors,
                timestamp: tokenObj.timestamp,
        })
        const hash = createHash('sha256').update(message).digest()
        const username = tokenObj.authors[0].toLowerCase()

        const [account]: HiveAccount[] = await getAccount(username)
        APIError.assert(account, APIError.Code.NoSuchAccount)
        ctx.log.warn('uploading app %s', signedMessage.app)

        APIError.assert(username === account.name, APIError.Code.InvalidSignature)
        let parsedSignature: Signature
        try {
            parsedSignature = Signature.from(signature)
        } catch (cause) {
            throw new APIError({code: APIError.Code.InvalidSignature, cause})
        }

        // 1. Signed by the app's configured posting key, i.e. a token minted by
        // us, including the offline-renew path.
        if (broadcasterPubKey && broadcasterPubKey.verify(hash, parsedSignature)) {
            validSignature = true
        }

        // 2. Signed by one of the account's own keys. Owner is deliberately
        // excluded, matching the direct upload path: using it for routine
        // operations is an anti-pattern.
        if (!validSignature) {
            validSignature = authoritySignedBy(account.posting, hash, parsedSignature)
                || authoritySignedBy(account.active, hash, parsedSignature)
        }

        // 3. Signed by the app account the user has delegated to.
        //
        // Delegation on its own is NOT proof of anything: it establishes who MAY
        // act for this account, not that this request came from them. Previously
        // finding app_account in account_auths set validSignature directly, so
        // any caller naming an account that had ever authorised the app was
        // accepted with an arbitrary signature.
        //
        // Verifying against the delegate's own on-chain keys also survives a
        // rotation of the app key, which trusting app_posting_wif alone does not.
        if (!validSignature && hasDelegatedTo(account, UPLOAD_LIMITS.app_account)) {
            const [appAccount]: HiveAccount[] = await getAccount(UPLOAD_LIMITS.app_account)
            if (appAccount) {
                validSignature = authoritySignedBy(appAccount.posting, hash, parsedSignature)
                    || authoritySignedBy(appAccount.active, hash, parsedSignature)
            } else {
                ctx.log.error({app: UPLOAD_LIMITS.app_account},
                    'could not load app account to verify a delegated token')
            }
        }

        APIError.assert(validSignature, APIError.Code.InvalidSignature)
        APIError.assert(!accountBlacklist.includes(account.name), APIError.Code.Blacklisted)

        if (redisClient) {
            try {
                const limit = await getRatelimit(account.name, UPLOAD_LIMITS.max, UPLOAD_LIMITS.duration)
                APIError.assert(limit.remaining > 0, APIError.Code.QoutaExceeded)
            } catch (error) {
                if (error instanceof APIError) throw error
                ctx.log.error(error, 'unable to enforce upload rate limits')
                throw new APIError({ code: APIError.Code.InternalError, message: 'Rate limiting unavailable' })
            }
        }

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

    const actualMime2 = await mimeMagic(data)
    APIError.assert(AcceptedContentTypes.includes(actualMime2), APIError.Code.InvalidImage)
    APIError.assert(actualMime2 !== 'image/svg+xml' && actualMime2 !== 'image/svg', APIError.Code.InvalidImage)

    const imageHash = createHash('sha256')
        .update('ImageSigningChallenge')
        .update(data)
        .digest()

    const [account]: HiveAccount[] = await getAccount(ctx.params['username'].toLowerCase())
    APIError.assert(account, APIError.Code.NoSuchAccount)

    let validSignature = false
    let publicKey: string | undefined

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

                const hash = createHash('sha256').update(message).digest()

                let parsedSigns: Signature
                try {
                    parsedSigns = Signature.from(signs)
                } catch (cause) {
                    throw new APIError({code: APIError.Code.InvalidSignature, cause})
                }

                if (broadcasterPubKey && broadcasterPubKey.verify(hash, parsedSigns)) {
                    validSignature = true
                }
                // Owner excluded and weight_threshold enforced, matching the
                // key-signature path below and the /hs/ handler.
                if (!validSignature) {
                    validSignature = authoritySignedBy(account.posting, hash, parsedSigns)
                        || authoritySignedBy(account.active, hash, parsedSigns)
                }
                if (!validSignature && hasDelegatedTo(account, UPLOAD_LIMITS.app_account)) {
                    const [appAccount]: HiveAccount[] = await getAccount(UPLOAD_LIMITS.app_account)
                    if (appAccount) {
                        validSignature = authoritySignedBy(appAccount.posting, hash, parsedSigns)
                            || authoritySignedBy(appAccount.active, hash, parsedSigns)
                    }
                }
            }
    } else if (ctx.params['signature'].startsWith('stndt')) {
        // Legacy test mode - removed for security
        // This authentication bypass has been disabled as it poses a critical security risk
        throw new APIError({code: APIError.Code.InvalidSignature, message: 'Legacy test mode no longer supported'})
    } else {
        let signature: Signature
        try {
            signature = Signature.from(ctx.params['signature'])
        } catch (cause) {
            throw new APIError({code: APIError.Code.InvalidSignature, cause})
        }

        try {
            publicKey = signature.getPublicKey(imageHash).toString()
        } catch (cause) {
            throw new APIError({code: APIError.Code.InvalidSignature, cause})
        }

        // Only accept posting and active keys for direct uploads.
        // Owner key is intentionally excluded — using it for routine operations
        // is a security anti-pattern (owner key compromise = full account takeover).
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

    if (redisClient) {
        try {
            const limit = await getRatelimit(account.name, UPLOAD_LIMITS.max, UPLOAD_LIMITS.duration)
            APIError.assert(limit.remaining > 0, APIError.Code.QoutaExceeded)
        } catch (error) {
            if (error instanceof APIError) throw error
            ctx.log.error(error, 'unable to enforce upload rate limits')
            throw new APIError({ code: APIError.Code.InternalError, message: 'Rate limiting unavailable' })
        }
    }

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
