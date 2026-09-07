import 'mocha'
import blobStore from 'abstract-blob-store'
import assert from 'assert'
import * as path from 'path'
import * as fs from 'fs'
import { createHash } from 'crypto'
import { URL } from 'url'

import {
    parseBool,
    camelToSnake,
    base58Enc,
    base58Dec,
    safeParseInt,
    supportsWebP,
    supportsAvif,
    acceptsAnyImageType,
    acceptsImageType,
    needsMatchFallback,
    stripWebpOrPng,
    getImageKey,
    getUrlHashKey,
    buildSharpPipeline,
    isAnimatedSource,
    parseProxiedUrl,
    primaryPageOf,
    readStream,
    storeExists,
    storeExistsBounded,
    parsePlainUrl,
    getOrigKeyFromUrl,
    sanitizeIgnoreInvalidateParams,
    isBlacklistedUrl,
    isInternalProxyUrl,
    isInternalServiceUrl,
    isInternalUploadUrl,
    ScalingMode,
    OutputFormat,
    redactUrlForLog,
    storeRemoveByPrefix,
    storeWrite,
    expandPurgeUrls,
} from './../src/utils'

import {PassThrough} from 'stream'

import {AVIF_EFFORT, budgetSignal, DEFAULT_AVATAR_HASH, DEFAULT_FALLBACK_IMAGE_URL, EDGE_FIRST_BYTE_TIMEOUT_MS, EMPTY_IMAGE_URL_PATTERNS, FETCH_CANDIDATE_WALL_MS, FETCH_DEADLINE_DEFAULT_MS, FETCH_DEADLINE_MS, FETCH_DEFAULT_WALL_MS, FETCH_MIN_REMAINING_MS, FETCH_RENDER_SLACK_MS, INTERNAL_SERVICE_ORIGINS, LEGACY_SERVICE_BASE_URL, SERVE_READ_TIMEOUT_MS, SERVICE_BASE_URL, SPECIAL_EMPTY_IMAGE_PATH, STORE_OP_TIMEOUT_MS, applyUrlReplacements, isEmptyImageUrl, startsWithEmptyImagePrefix} from './../src/constants'

import { APIError } from './../src/error'

import { initBlacklistService } from './../src/blacklist-service'

describe('utils', function() {

    describe('parseBool', function() {
        it('should return false for falsy values', function() {
            assert.equal(parseBool('n'), false)
            assert.equal(parseBool(' No'), false)
            assert.equal(parseBool('oFF'), false)
            assert.equal(parseBool(false), false)
            assert.equal(parseBool(0), false)
            assert.equal(parseBool('0'), false)
        })

        it('should return true for truthy values', function() {
            assert.equal(parseBool('Y'), true)
            assert.equal(parseBool('yes  '), true)
            assert.equal(parseBool('on'), true)
            assert.equal(parseBool(true), true)
            assert.equal(parseBool(1), true)
            assert.equal(parseBool('1'), true)
        })

        it('should throw on ambiguous input', function() {
            assert.throws(() => { parseBool('banana') })
            assert.throws(() => { parseBool('maybe') })
            assert.throws(() => { parseBool(2) })
        })
    })

    describe('camelToSnake', function() {
        it('should convert camelCase to snake_case', function() {
            assert.equal(camelToSnake('BadRequest'), 'bad_request')
            assert.equal(camelToSnake('InvalidSignature'), 'invalid_signature')
            assert.equal(camelToSnake('NoSuchAccount'), 'no_such_account')
            assert.equal(camelToSnake('QoutaExceeded'), 'qouta_exceeded')
        })

        it('should handle single word', function() {
            assert.equal(camelToSnake('error'), 'error')
            assert.equal(camelToSnake('Error'), 'error')
        })

        it('should handle empty string', function() {
            assert.equal(camelToSnake(''), '')
        })

        it('should handle already snake_case', function() {
            assert.equal(camelToSnake('already_snake'), 'already_snake')
        })
    })

    describe('base58Enc / base58Dec', function() {
        it('should encode and decode URL roundtrip', function() {
            const url = 'https://example.com/image.jpg'
            const encoded = base58Enc(url)
            const decoded = base58Dec(encoded)
            assert.equal(decoded, url)
        })

        it('should encode and decode complex URLs', function() {
            const url = 'https://cdn.example.com/path/to/image.png?width=100&height=200'
            const encoded = base58Enc(url)
            const decoded = base58Dec(encoded)
            assert.equal(decoded, url)
        })

        it('should encode and decode URLs with unicode', function() {
            const url = 'https://example.com/image-日本語.jpg'
            const encoded = base58Enc(url)
            const decoded = base58Dec(encoded)
            assert.equal(decoded, url)
        })

        it('should produce different outputs for different inputs', function() {
            const enc1 = base58Enc('https://a.com/1.jpg')
            const enc2 = base58Enc('https://a.com/2.jpg')
            assert.notEqual(enc1, enc2)
        })
    })

    describe('safeParseInt', function() {
        it('should parse valid integers', function() {
            assert.equal(safeParseInt('100'), 100)
            assert.equal(safeParseInt('0'), 0)
            assert.equal(safeParseInt('1280'), 1280)
            assert.equal(safeParseInt(42), 42)
        })

        it('should return undefined for non-numeric values', function() {
            assert.equal(safeParseInt('abc'), undefined)
            assert.equal(safeParseInt(''), undefined)
            assert.equal(safeParseInt(undefined), undefined)
            assert.equal(safeParseInt(null), undefined)
            assert.equal(safeParseInt(NaN), undefined)
        })

        it('should parse integers with trailing text', function() {
            assert.equal(safeParseInt('100px'), 100)
            assert.equal(safeParseInt('42.5'), 42)
        })

        it('should handle negative numbers', function() {
            assert.equal(safeParseInt('-5'), -5)
        })
    })

    describe('supportsWebP', function() {
        it('should detect WebP support in Accept header', function() {
            assert.equal(supportsWebP('image/webp,image/png,*/*'), true)
            assert.equal(supportsWebP('image/avif,image/webp,*/*'), true)
            assert.equal(supportsWebP('text/html,image/webp'), true)
        })

        it('should detect WebP case-insensitively', function() {
            assert.equal(supportsWebP('image/WEBP,*/*'), true)
            assert.equal(supportsWebP('Image/WebP'), true)
        })

        it('should return false when WebP not present', function() {
            assert.equal(supportsWebP('image/png,image/jpeg,*/*'), false)
            assert.equal(supportsWebP('*/*'), false)
            assert.equal(supportsWebP(''), false)
        })
    })

    describe('supportsAvif', function() {
        it('should detect AVIF support in Accept header', function() {
            assert.equal(supportsAvif('image/avif,image/webp,*/*'), true)
            assert.equal(supportsAvif('text/html,image/avif'), true)
        })

        it('should detect AVIF case-insensitively', function() {
            assert.equal(supportsAvif('image/AVIF,*/*'), true)
            assert.equal(supportsAvif('Image/Avif'), true)
        })

        it('should return false when AVIF not present', function() {
            assert.equal(supportsAvif('image/webp,image/png,*/*'), false)
            assert.equal(supportsAvif('*/*'), false)
            assert.equal(supportsAvif(''), false)
        })
    })

    describe('stripWebpOrPng', function() {
        it('should strip .webp extension', function() {
            assert.equal(stripWebpOrPng('image.webp'), 'image')
            assert.equal(stripWebpOrPng('/path/to/file.webp'), '/path/to/file')
        })

        it('should strip .png extension', function() {
            assert.equal(stripWebpOrPng('image.png'), 'image')
            assert.equal(stripWebpOrPng('/path/to/file.png'), '/path/to/file')
        })

        it('should not strip other extensions', function() {
            assert.equal(stripWebpOrPng('image.jpg'), 'image.jpg')
            assert.equal(stripWebpOrPng('image.gif'), 'image.gif')
            assert.equal(stripWebpOrPng('image.jpeg'), 'image.jpeg')
        })

        it('should handle no extension', function() {
            assert.equal(stripWebpOrPng('image'), 'image')
            assert.equal(stripWebpOrPng(''), '')
        })

        it('should only strip at the end', function() {
            assert.equal(stripWebpOrPng('webp.file.jpg'), 'webp.file.jpg')
            assert.equal(stripWebpOrPng('my.png.file'), 'my.png.file')
        })
    })

    describe('getImageKey', function() {
        it('should generate key for fit+match (legacy format)', function() {
            const key = getImageKey('Uabc123', {
                width: 100, height: 200,
                mode: ScalingMode.Fit, format: OutputFormat.Match,
            })
            assert.equal(key, 'Uabc123_100x200')
        })

        it('should generate key for fit+match with zero dimensions', function() {
            const key = getImageKey('Uabc123', {
                width: 0, height: 0,
                mode: ScalingMode.Fit, format: OutputFormat.Match,
            })
            assert.equal(key, 'Uabc123_0x0')
        })

        it('should generate key for cover mode', function() {
            const key = getImageKey('Uabc123', {
                width: 512, height: 512,
                mode: ScalingMode.Cover, format: OutputFormat.WEBP,
            })
            assert.equal(key, 'Uabc123_Cover_WEBP_512_512')
        })

        it('should generate key for fit+webp', function() {
            const key = getImageKey('Uabc123', {
                width: 100,
                mode: ScalingMode.Fit, format: OutputFormat.WEBP,
            })
            assert.equal(key, 'Uabc123_Fit_WEBP_100')
        })

        it('should handle undefined dimensions', function() {
            const key = getImageKey('Uabc123', {
                mode: ScalingMode.Cover, format: OutputFormat.JPEG,
            })
            assert.equal(key, 'Uabc123_Cover_JPEG')
        })

        it('should generate key for AVIF format', function() {
            const key = getImageKey('Uabc123', {
                width: 512, height: 512,
                mode: ScalingMode.Cover, format: OutputFormat.AVIF,
            })
            assert.equal(key, 'Uabc123_Cover_AVIF_512_512')
        })
    })

    describe('getUrlHashKey', function() {
        it('should generate deterministic hash keys', function() {
            const key1 = getUrlHashKey('https://example.com/image.jpg')
            const key2 = getUrlHashKey('https://example.com/image.jpg')
            assert.equal(key1, key2)
        })

        it('should start with U prefix', function() {
            const key = getUrlHashKey('https://example.com/image.jpg')
            assert(key.startsWith('U'), 'key should start with U')
        })

        it('should generate different keys for different URLs', function() {
            const key1 = getUrlHashKey('https://example.com/1.jpg')
            const key2 = getUrlHashKey('https://example.com/2.jpg')
            assert.notEqual(key1, key2)
        })

        it('should use SHA1', function() {
            const url = 'https://example.com/test.jpg'
            const expected = 'U' + createHash('sha1').update(url).digest('hex')
            assert.equal(getUrlHashKey(url), expected)
        })
    })

    describe('isAnimatedSource', function() {
        it('treats a multi-page GIF, WebP or APNG as animated', function() {
            assert.equal(isAnimatedSource({format: 'gif', pages: 12}, 'image/gif'), true)
            assert.equal(isAnimatedSource({format: 'webp', pages: 3}, 'image/webp'), true)
            assert.equal(isAnimatedSource({format: 'png', pages: 4}, 'image/apng'), true)
        })

        it('treats a single-page animatable format as a still', function() {
            assert.equal(isAnimatedSource({format: 'gif', pages: 1}, 'image/gif'), false)
            assert.equal(isAnimatedSource({format: 'webp', pages: 1}, 'image/webp'), false)
        })

        it('never treats a HEIF or any non-animating container as animated by its page count', function() {
            // libvips counts top-level images: an iPhone photo with a gain map or
            // depth image reports two, and passing it through unrendered served the
            // raw container to browsers that cannot display it (#43)
            assert.equal(isAnimatedSource({format: 'heif', pages: 2}, 'image/heic'), false)
            assert.equal(isAnimatedSource({format: 'heif', pages: 5}, 'image/heif'), false)
            assert.equal(isAnimatedSource({format: 'tiff', pages: 3}, 'image/tiff'), false)
            assert.equal(isAnimatedSource({format: 'pdf', pages: 9}, 'application/pdf'), false)
            assert.equal(isAnimatedSource({format: 'jpeg', pages: 2}, 'image/jpeg'), false)
        })

        it('falls back to the content type only when the page count is unknown', function() {
            assert.equal(isAnimatedSource({format: 'gif'}, 'image/gif'), true)
            assert.equal(isAnimatedSource({format: 'png'}, 'image/apng'), true)
            assert.equal(isAnimatedSource({format: 'heif'}, 'image/heic'), false)
            assert.equal(isAnimatedSource({format: 'jpeg'}, 'image/jpeg'), false)
        })
    })

    describe('primaryPageOf and buildSharpPipeline', function() {
        it('selects the HEIF primary image when it is not the first top-level image', function() {
            assert.equal(primaryPageOf({format: 'heif', pagePrimary: 1}), 1)
            assert.equal(primaryPageOf({format: 'heif', pagePrimary: 0}), undefined, 'first image is Sharp default')
            assert.equal(primaryPageOf({format: 'heif'}), undefined)
            assert.equal(primaryPageOf({format: 'gif', pagePrimary: 1}), undefined, 'only HEIF has a primary image')
        })

        it('pins the requested page on the Sharp input and leaves it alone otherwise', function() {
            const buf = fs.readFileSync(path.resolve(__dirname, 'test.heic'))
            assert.equal((buildSharpPipeline(buf, false, 1) as any).options.input.page, 1)
            assert.equal((buildSharpPipeline(buf, false) as any).options.input.page, undefined)
        })
    })

    describe('bounded store operations', function() {
        const hangingStore: any = {
            exists: () => undefined,           // never calls back
            createReadStream: () => new PassThrough(), // never ends
        }
        const quiet = {warn: () => undefined, debug: () => undefined, info: () => undefined, error: () => undefined}

        it('storeExists rejects with AbortError when the store never answers and the signal fires', async function() {
            const t0 = Date.now()
            await assert.rejects(storeExists(hangingStore, 'k', AbortSignal.timeout(50)), (err: any) => err.name === 'AbortError')
            assert(Date.now() - t0 < 1000, 'must not wait for the store')
        })

        it('storeExists rejects at once on an already-aborted signal', async function() {
            const c = new AbortController(); c.abort()
            await assert.rejects(storeExists(hangingStore, 'k', c.signal), (err: any) => err.name === 'AbortError')
        })

        it('storeExists hands the key and the signal to the store', async function() {
            let seen: any
            const store: any = { exists: (opts: any, done: any) => { seen = opts; done(null, true) } }
            const signal = AbortSignal.timeout(1000)
            assert.equal(await storeExists(store, 'thekey', signal), true)
            assert.equal(seen.key, 'thekey')
            assert.equal(seen.signal, signal)
            // and a plain string key when there is no signal, as every store already accepts
            assert.equal(await storeExists(store, 'plain'), true)
            assert.equal(seen, 'plain')
        })

        it('readStream rejects and destroys the stream when the signal fires', async function() {
            const stream = new PassThrough()
            let destroyed = false
            stream.on('close', () => { destroyed = true })
            await assert.rejects(readStream(stream, AbortSignal.timeout(50)), (err: any) => err.name === 'AbortError')
            await new Promise((r) => setTimeout(r, 20))
            assert.equal(destroyed, true, 'the stalled stream must be destroyed, not leaked')
        })

        it('readStream still resolves normally with a signal that never fires', async function() {
            const stream = new PassThrough()
            const p = readStream(stream, AbortSignal.timeout(5000))
            stream.end(Buffer.from('bytes'))
            assert.equal((await p).toString(), 'bytes')
        })

        it('storeExistsBounded treats a timeout and an error as absent', async function() {
            assert.equal(await storeExistsBounded(hangingStore, 'k', AbortSignal.timeout(50), quiet, 'test'), false)
            const failing: any = { exists: (_o: any, done: any) => done(new Error('boom')) }
            assert.equal(await storeExistsBounded(failing, 'k', AbortSignal.timeout(1000), quiet, 'test'), false)
            const present: any = { exists: (_o: any, done: any) => done(null, true) }
            assert.equal(await storeExistsBounded(present, 'k', AbortSignal.timeout(1000), quiet, 'test'), true)
        })

        it('budgetSignal clamps to the remaining deadline, and to the cap, and never disables the timer', async function() {
            const fired = (sig: AbortSignal) => new Promise<number>((resolve) => {
                const t0 = Date.now(); sig.addEventListener('abort', () => resolve(Date.now() - t0), {once: true})
            })
            // deadline sooner than the cap
            const a = await fired(budgetSignal(Date.now() + 80, 5000))
            assert(a >= 60 && a < 600, `expected ~80ms, got ${ a }`)
            // deadline already gone: aborts immediately rather than never
            const b = await fired(budgetSignal(Date.now() - 1000, 5000))
            assert(b < 200, `expected immediate abort, got ${ b }`)
            // no deadline: the cap rules
            const c = await fired(budgetSignal(undefined, 60))
            assert(c >= 40 && c < 600, `expected ~60ms, got ${ c }`)
            assert.equal(STORE_OP_TIMEOUT_MS, 300, 'test config sets the knob low')
            assert.equal(SERVE_READ_TIMEOUT_MS, 900)
        })
    })

    describe('parseProxiedUrl', function() {
        it('should decode base58 encoded URLs', function() {
            const url = 'https://example.com/image.jpg'
            const encoded = base58Enc(url)
            const result = parseProxiedUrl(encoded)
            assert.equal(result.toString(), url)
        })

        it('should strip trailing slashes', function() {
            const url = 'https://example.com/image.jpg///'
            const encoded = base58Enc(url)
            const result = parseProxiedUrl(encoded)
            assert.equal(result.toString(), 'https://example.com/image.jpg')
        })

        const rejectsAsInvalidProxyUrl = (err: any) =>
            err instanceof APIError && err.code === APIError.Code.InvalidProxyUrl

        it('rejects a key that is not base58 as a client error', function() {
            // Used to substitute the 1x1 placeholder upload silently, which then
            // travelled the normal pipeline as a real image (stored, immutable)
            assert.throws(() => parseProxiedUrl('not-valid-base58!!!'), rejectsAsInvalidProxyUrl)
        })

        it('rejects a key that decodes to something other than a URL', function() {
            assert.throws(() => parseProxiedUrl(base58Enc('not a url')), rejectsAsInvalidProxyUrl)
            // valid base58 whose bytes are binary noise, the shape seen in production
            assert.throws(() => parseProxiedUrl(
                '3W72119s5BjW3w55E9m2dpuZgVrNq2aY9kcSn9SY4wgjN3KWKyHprjyV9f7rjvBoQnFKrVP9XPjYGE3jRJcJqyq'),
                rejectsAsInvalidProxyUrl)
        })

        it('never resolves an undecodable key to the placeholder upload', function() {
            for (const bad of ['not-valid-base58!!!', base58Enc('not a url')]) {
                let resolved: URL | undefined
                try { resolved = parseProxiedUrl(bad) } catch (_e) { /* expected */ }
                assert.equal(resolved, undefined, `${ bad } resolved to ${ resolved }`)
            }
        })
    })

    describe('parsePlainUrl', function() {
        it('should parse valid URLs', function() {
            const result = parsePlainUrl('https://example.com/image.jpg')
            assert.equal(result.hostname, 'example.com')
            assert.equal(result.pathname, '/image.jpg')
        })

        it('should throw APIError for invalid URLs', function() {
            assert.throws(() => {
                parsePlainUrl('not a url')
            }, (err: any) => {
                return err instanceof APIError && err.code === APIError.Code.InvalidProxyUrl
            })
        })
    })

    describe('getOrigKeyFromUrl', function() {
        it('should extract upload key from path', function() {
            const url = new URL('https://i.ecency.com/DQmZi174Xz96UrRVBMNRHb6A2FfU3z1HRPwPPQCgSMgdiUT/test.jpg')
            const key = getOrigKeyFromUrl(url, true)
            assert.equal(key, 'DQmZi174Xz96UrRVBMNRHb6A2FfU3z1HRPwPPQCgSMgdiUT')
        })

        it('should generate hash key for proxy URLs', function() {
            const url = new URL('https://external.com/image.jpg')
            const key = getOrigKeyFromUrl(url, false)
            assert(key.startsWith('U'), 'proxy key should start with U')
        })

        it('should generate deterministic proxy keys', function() {
            const url = new URL('https://external.com/image.jpg')
            const key1 = getOrigKeyFromUrl(url, false)
            const key2 = getOrigKeyFromUrl(url, false)
            assert.equal(key1, key2)
        })
    })

    describe('sanitizeIgnoreInvalidateParams', function() {
        it('should remove ignorecache param', function() {
            const url = new URL('https://example.com/image.jpg?ignorecache=1')
            const result = sanitizeIgnoreInvalidateParams(url)
            assert(!result.toString().includes('ignorecache'))
        })

        it('should remove invalidate param', function() {
            const url = new URL('https://example.com/image.jpg?invalidate=1')
            const result = sanitizeIgnoreInvalidateParams(url)
            assert(!result.toString().includes('invalidate'))
        })

        it('should preserve other params', function() {
            const url = new URL('https://example.com/image.jpg?width=100&ignorecache=1')
            const result = sanitizeIgnoreInvalidateParams(url)
            assert(result.toString().includes('width=100'))
        })
    })

    describe('storeRemoveByPrefix', function() {
        it('should remove all matching cached variants from memory store', async function() {
            const store = new (blobStore as any)()
            await storeWrite(store as any, 'Uabc_100x100', Buffer.from('a'))
            await storeWrite(store as any, 'Uabc_Fit_WEBP_100', Buffer.from('b'))
            await storeWrite(store as any, 'Uabc_Cover_AVIF_256', Buffer.from('c'))
            await storeWrite(store as any, 'Uxyz_100x100', Buffer.from('d'))

            const removed = await storeRemoveByPrefix(store as any, 'Uabc_')

            assert.equal(removed, 3)
            assert.equal((store as any).data['Uabc_100x100'], undefined)
            assert.equal((store as any).data['Uabc_Fit_WEBP_100'], undefined)
            assert.equal((store as any).data['Uabc_Cover_AVIF_256'], undefined)
            assert(Buffer.isBuffer((store as any).data['Uxyz_100x100']))
        })
    })

})

describe('constants', function() {

    describe('isEmptyImageUrl', function() {
        it('should match exact empty image URL patterns', function() {
            assert.equal(isEmptyImageUrl(SERVICE_BASE_URL + '/0x0/'), true)
            assert.equal(isEmptyImageUrl(SERVICE_BASE_URL + '/0x0'), true)
            assert.equal(isEmptyImageUrl(LEGACY_SERVICE_BASE_URL + '/0x0/'), true)
            assert.equal(isEmptyImageUrl(LEGACY_SERVICE_BASE_URL + '/0x0'), true)
        })

        it('should not match partial or different URLs', function() {
            assert.equal(isEmptyImageUrl(SERVICE_BASE_URL + '/0x0/http://example.com'), false)
            assert.equal(isEmptyImageUrl('https://other.com/0x0/'), false)
            assert.equal(isEmptyImageUrl(''), false)
            assert.equal(isEmptyImageUrl('0x0'), false)
        })
    })

    describe('startsWithEmptyImagePrefix', function() {
        it('should match URLs starting with empty image pattern', function() {
            assert.equal(startsWithEmptyImagePrefix(SERVICE_BASE_URL + '/0x0/http://example.com'), true)
            assert.equal(startsWithEmptyImagePrefix(SERVICE_BASE_URL + '/0x0/'), true)
            assert.equal(startsWithEmptyImagePrefix(LEGACY_SERVICE_BASE_URL + '/0x0/http://example.com'), true)
        })

        it('should not match other URLs', function() {
            assert.equal(startsWithEmptyImagePrefix('https://other.com/0x0/'), false)
            assert.equal(startsWithEmptyImagePrefix(SERVICE_BASE_URL + '/p/abc'), false)
        })
    })

    describe('applyUrlReplacements', function() {
        it('should replace 3speak CDN domain', function() {
            const result = applyUrlReplacements('https://img.3speakcontent.online/foo.jpg')
            assert.equal(result, 'https://img.3speakcontent.co/foo.jpg')
        })

        it('should replace InLeo CDN domain', function() {
            const result = applyUrlReplacements('https://img.inleo.io/DQmABC123')
            assert.equal(result, 'https://img.leopedia.io/DQmABC123')
        })

        it('should apply 3speak path replacement', function() {
            const result = applyUrlReplacements('https://img.3speakcontent.co/post.png')
            assert.equal(result, 'https://img.3speakcontent.co/thumbnails/default.png')
        })

        it('should not modify unrelated URLs', function() {
            const url = 'https://example.com/image.jpg'
            assert.equal(applyUrlReplacements(url), url)
        })

        it('should handle empty string', function() {
            assert.equal(applyUrlReplacements(''), '')
        })

        it('should apply domain replacement before path replacement', function() {
            // First replaces online->co, then replaces /post.png->/thumbnails/default.png
            const result = applyUrlReplacements('https://img.3speakcontent.online/post.png')
            assert.equal(result, 'https://img.3speakcontent.co/thumbnails/default.png')
        })
    })

    describe('internal service URL helpers', function() {
        it('should treat both public hosts as internal origins', function() {
            assert(INTERNAL_SERVICE_ORIGINS.includes(new URL(SERVICE_BASE_URL).origin))
            assert(INTERNAL_SERVICE_ORIGINS.includes(new URL(LEGACY_SERVICE_BASE_URL).origin))
            assert.equal(isInternalServiceUrl(new URL('https://i.ecency.com/foo')), true)
            assert.equal(isInternalServiceUrl(new URL('https://images.ecency.com/foo')), true)
            assert.equal(isInternalServiceUrl(new URL('https://example.com/foo')), false)
        })

        it('should detect upload URLs on both public hosts', function() {
            assert.equal(isInternalUploadUrl(new URL('https://i.ecency.com/DQmHash/test.jpg')), true)
            assert.equal(isInternalUploadUrl(new URL('https://images.ecency.com/DQmHash/test.jpg')), true)
            assert.equal(isInternalUploadUrl(new URL('https://example.com/DQmHash/test.jpg')), false)
        })

        it('should detect proxy URLs on both public hosts', function() {
            assert.equal(isInternalProxyUrl(new URL('https://i.ecency.com/p/abc')), true)
            assert.equal(isInternalProxyUrl(new URL('https://images.ecency.com/p/abc')), true)
            assert.equal(isInternalProxyUrl(new URL('https://example.com/p/abc')), false)
        })
    })

    describe('exported constants', function() {
        it('should have valid SERVICE_BASE_URL', function() {
            assert(SERVICE_BASE_URL.startsWith('http'), 'should be a URL')
        })

        it('should have correct SPECIAL_EMPTY_IMAGE_PATH', function() {
            assert.equal(SPECIAL_EMPTY_IMAGE_PATH, '0x0')
        })

        it('should keep AVIF_EFFORT in the measured-safe range', function() {
            // 2 is the measured sweet spot: 1.6-2.3x faster than 3 at the same
            // size or smaller. Guard the range rather than the exact value so
            // retuning stays possible, but a drift to 0 (~8% larger files) or
            // back to 4 (~6x slower for <1% gain) fails here.
            assert.equal(typeof AVIF_EFFORT, 'number')
            assert(AVIF_EFFORT >= 1 && AVIF_EFFORT <= 3, `AVIF_EFFORT ${ AVIF_EFFORT } outside measured-safe 1-3`)
        })

        it('should have valid DEFAULT_FALLBACK_IMAGE_URL', function() {
            assert(DEFAULT_FALLBACK_IMAGE_URL.startsWith(SERVICE_BASE_URL))
            assert(DEFAULT_FALLBACK_IMAGE_URL.includes('1x1_000000.png'))
        })

        it('fits the fetch deadline, the default-image fetch and the render inside the edge budget', function() {
            // Varnish's .first_byte_timeout for the image backend. A walk that has
            // not answered by then is a 503 at the edge regardless of what the
            // origin does next, so the placeholder path only exists if the whole
            // worst case ends before it. Change the VCL and this value together.
            assert.equal(EDGE_FIRST_BYTE_TIMEOUT_MS, 20000)
            assert(FETCH_DEADLINE_DEFAULT_MS + FETCH_DEFAULT_WALL_MS + FETCH_RENDER_SLACK_MS <= EDGE_FIRST_BYTE_TIMEOUT_MS,
                `deadline ${ FETCH_DEADLINE_DEFAULT_MS } + default fetch ${ FETCH_DEFAULT_WALL_MS } + render ${ FETCH_RENDER_SLACK_MS } exceeds ${ EDGE_FIRST_BYTE_TIMEOUT_MS }`)
            // and it still lets one slow candidate run to its own wall, so a
            // slow-but-alive origin is not cut off by the budget before its
            // per-candidate timeout has had its say
            assert(FETCH_DEADLINE_DEFAULT_MS >= FETCH_CANDIDATE_WALL_MS,
                `deadline ${ FETCH_DEADLINE_DEFAULT_MS } is shorter than one candidate wall ${ FETCH_CANDIDATE_WALL_MS }`)
            assert(FETCH_MIN_REMAINING_MS > 0)
            // the test config sets no override, so the live value is the default
            assert.equal(FETCH_DEADLINE_MS, FETCH_DEADLINE_DEFAULT_MS)
        })

        it('should have valid DEFAULT_AVATAR_HASH', function() {
            assert(DEFAULT_AVATAR_HASH.startsWith('DQm'))
        })

        it('should include current and legacy 0x0 URL patterns', function() {
            assert.equal(EMPTY_IMAGE_URL_PATTERNS.length, 4)
            assert(EMPTY_IMAGE_URL_PATTERNS.includes(SERVICE_BASE_URL + '/0x0/'))
            assert(EMPTY_IMAGE_URL_PATTERNS.includes(SERVICE_BASE_URL + '/0x0'))
            assert(EMPTY_IMAGE_URL_PATTERNS.includes(LEGACY_SERVICE_BASE_URL + '/0x0/'))
            assert(EMPTY_IMAGE_URL_PATTERNS.includes(LEGACY_SERVICE_BASE_URL + '/0x0'))
        })
    })
})

describe('APIError', function() {

    describe('constructor', function() {
        it('should create error with code', function() {
            const err = new APIError({ code: APIError.Code.BadRequest })
            assert.equal(err.code, APIError.Code.BadRequest)
            assert.equal(err.name, 'APIError')
            assert.equal(err.message, 'BadRequest')
        })

        it('should create error with custom message', function() {
            const err = new APIError({
                code: APIError.Code.InvalidSignature,
                message: 'custom message'
            })
            assert.equal(err.message, 'custom message')
        })

        it('should default to InternalError when no code', function() {
            const err = new APIError({})
            assert.equal(err.code, APIError.Code.InternalError)
        })

        it('should preserve cause', function() {
            const cause = new Error('original')
            const err = new APIError({ code: APIError.Code.BadRequest, cause })
            assert.equal(err.cause, cause)
        })

        it('should preserve info', function() {
            const info = { param: 'username' }
            const err = new APIError({ code: APIError.Code.MissingParam, info })
            assert.deepEqual(err.info, info)
        })
    })

    describe('statusCode', function() {
        it('should map BadRequest to 400', function() {
            assert.equal(new APIError({ code: APIError.Code.BadRequest }).statusCode, 400)
        })

        it('should map Blacklisted to 451', function() {
            assert.equal(new APIError({ code: APIError.Code.Blacklisted }).statusCode, 451)
        })

        it('should map Deplorable to 403', function() {
            assert.equal(new APIError({ code: APIError.Code.Deplorable }).statusCode, 403)
        })

        it('should map InvalidMethod to 405', function() {
            assert.equal(new APIError({ code: APIError.Code.InvalidMethod }).statusCode, 405)
        })

        it('should map NoSuchAccount to 404', function() {
            assert.equal(new APIError({ code: APIError.Code.NoSuchAccount }).statusCode, 404)
        })

        it('should map NotFound to 404', function() {
            assert.equal(new APIError({ code: APIError.Code.NotFound }).statusCode, 404)
        })

        it('should map PayloadTooLarge to 413', function() {
            assert.equal(new APIError({ code: APIError.Code.PayloadTooLarge }).statusCode, 413)
        })

        it('should map QoutaExceeded to 429', function() {
            assert.equal(new APIError({ code: APIError.Code.QoutaExceeded }).statusCode, 429)
        })

        it('should map LengthRequired to 411', function() {
            assert.equal(new APIError({ code: APIError.Code.LengthRequired }).statusCode, 411)
        })

        it('should map InternalError to 500', function() {
            assert.equal(new APIError({ code: APIError.Code.InternalError }).statusCode, 500)
        })

        it('should map InvalidSignature to 400', function() {
            assert.equal(new APIError({ code: APIError.Code.InvalidSignature }).statusCode, 400)
        })

        it('should map InvalidImage to 400', function() {
            assert.equal(new APIError({ code: APIError.Code.InvalidImage }).statusCode, 400)
        })

        it('should map InvalidProxyUrl to 400', function() {
            assert.equal(new APIError({ code: APIError.Code.InvalidProxyUrl }).statusCode, 400)
        })

        it('should map UpstreamError to 400', function() {
            assert.equal(new APIError({ code: APIError.Code.UpstreamError }).statusCode, 400)
        })

        it('should map FileMissing to 400', function() {
            assert.equal(new APIError({ code: APIError.Code.FileMissing }).statusCode, 400)
        })

        it('should map InvalidParam to 400', function() {
            assert.equal(new APIError({ code: APIError.Code.InvalidParam }).statusCode, 400)
        })

        it('should map MissingParam to 400', function() {
            assert.equal(new APIError({ code: APIError.Code.MissingParam }).statusCode, 400)
        })
    })

    describe('toJSON', function() {
        it('should serialize to snake_case name', function() {
            const json = new APIError({ code: APIError.Code.BadRequest }).toJSON()
            assert.equal(json.name, 'bad_request')
        })

        it('should serialize NoSuchAccount', function() {
            const json = new APIError({ code: APIError.Code.NoSuchAccount }).toJSON()
            assert.equal(json.name, 'no_such_account')
        })

        it('should serialize InvalidSignature', function() {
            const json = new APIError({ code: APIError.Code.InvalidSignature }).toJSON()
            assert.equal(json.name, 'invalid_signature')
        })

        it('should include info in JSON', function() {
            const json = new APIError({
                code: APIError.Code.MissingParam,
                info: { param: 'username' }
            }).toJSON()
            assert.equal(json.name, 'missing_param')
            assert.deepEqual(json.info, { param: 'username' })
        })
    })

    describe('assert', function() {
        it('should not throw on truthy condition', function() {
            APIError.assert(true, APIError.Code.BadRequest)
            APIError.assert(1, APIError.Code.BadRequest)
            APIError.assert('yes', APIError.Code.BadRequest)
        })

        it('should throw on falsy condition with error code', function() {
            assert.throws(() => {
                APIError.assert(false, APIError.Code.InvalidSignature)
            }, (err: any) => {
                return err instanceof APIError && err.code === APIError.Code.InvalidSignature
            })
        })

        it('should throw on null/undefined/0', function() {
            assert.throws(() => { APIError.assert(null, APIError.Code.BadRequest) })
            assert.throws(() => { APIError.assert(undefined, APIError.Code.BadRequest) })
            assert.throws(() => { APIError.assert(0, APIError.Code.BadRequest) })
            assert.throws(() => { APIError.assert('', APIError.Code.BadRequest) })
        })

        it('should accept string arg as info message', function() {
            assert.throws(() => {
                APIError.assert(false, 'custom message')
            }, (err: any) => {
                return err instanceof APIError &&
                    err.code === APIError.Code.BadRequest &&
                    err.info && err.info.msg === 'custom message'
            })
        })

        it('should accept options object', function() {
            assert.throws(() => {
                APIError.assert(false, {
                    code: APIError.Code.Deplorable,
                    message: 'low rep'
                })
            }, (err: any) => {
                return err instanceof APIError &&
                    err.code === APIError.Code.Deplorable &&
                    err.message === 'low rep'
            })
        })

        it('should default to BadRequest code', function() {
            assert.throws(() => {
                APIError.assert(false)
            }, (err: any) => {
                return err instanceof APIError && err.code === APIError.Code.BadRequest
            })
        })
    })

    describe('assertParams', function() {
        it('should not throw when all params present', function() {
            APIError.assertParams(
                { username: 'foo', signature: 'abc' },
                ['username', 'signature']
            )
        })

        it('should throw for missing param', function() {
            assert.throws(() => {
                APIError.assertParams({ username: 'foo' }, ['username', 'signature'])
            }, (err: any) => {
                return err instanceof APIError &&
                    err.code === APIError.Code.MissingParam &&
                    err.info && err.info.param === 'signature'
            })
        })

        it('should throw for empty string param', function() {
            assert.throws(() => {
                APIError.assertParams({ username: '' }, ['username'])
            }, (err: any) => {
                return err instanceof APIError && err.code === APIError.Code.MissingParam
            })
        })

        it('should throw for null param', function() {
            assert.throws(() => {
                APIError.assertParams({ username: null }, ['username'])
            }, (err: any) => {
                return err instanceof APIError && err.code === APIError.Code.MissingParam
            })
        })
    })
})

describe('accept header negotiation', function() {
    describe('acceptsAnyImageType', function() {
        it('treats a named subtype as enumeration, even beside a wildcard', function() {
            assert.equal(acceptsAnyImageType('image/webp,image/apng,*/*;q=0.8'), false)
            assert.equal(acceptsAnyImageType('image/jpeg,image/*;q=0'), false)
        })

        it('treats a client that names no image type as unknown', function() {
            assert.equal(acceptsAnyImageType('*/*'), true)
            assert.equal(acceptsAnyImageType(''), true)
            assert.equal(acceptsAnyImageType('image/*'), true)
            assert.equal(acceptsAnyImageType('text/html,application/xhtml+xml'), true)
        })

        it('ignores types the client rejected outright', function() {
            assert.equal(acceptsAnyImageType('image/avif;q=0'), true)
        })
    })

    describe('acceptsImageType', function() {
        it('honours an exact entry over any wildcard', function() {
            assert.equal(acceptsImageType('image/jpeg,image/png;q=0', 'image/png'), false)
            assert.equal(acceptsImageType('image/png;q=0,*/*;q=0.8', 'image/png'), false)
            assert.equal(acceptsImageType('image/jpeg,image/png', 'image/png'), true)
        })

        it('falls back to the type wildcard, then to */*', function() {
            assert.equal(acceptsImageType('image/*', 'image/png'), true)
            assert.equal(acceptsImageType('image/webp,*/*;q=0.8', 'image/png'), true)
            assert.equal(acceptsImageType('image/jpeg', 'image/png'), false)
        })

        it('accepts anything when the client sent no Accept', function() {
            assert.equal(acceptsImageType('', 'image/avif'), true)
        })
    })

    describe('supportsAvif / supportsWebP', function() {
        it('requires the type to be named, not implied by a wildcard', function() {
            assert.equal(supportsAvif('image/avif,image/webp,*/*;q=0.8'), true)
            assert.equal(supportsAvif('image/webp,*/*;q=0.8'), false)
            assert.equal(supportsWebP('image/webp,*/*;q=0.8'), true)
            assert.equal(supportsWebP('*/*'), false)
        })

        it('honours a rejected type so negotiation cannot pick it', function() {
            assert.equal(supportsAvif('image/avif;q=0,image/webp,*/*;q=0.8'), false)
            assert.equal(supportsWebP('image/webp;q=0,*/*;q=0.8'), false)
        })
    })

    describe('needsMatchFallback', function() {
        it('always converts HEIC/HEIF', function() {
            assert.equal(needsMatchFallback('image/heic', '*/*'), true)
            assert.equal(needsMatchFallback('image/heif', 'image/webp,*/*;q=0.8'), true)
        })

        it('converts AVIF only for a client that enumerated without it', function() {
            assert.equal(needsMatchFallback('image/avif', 'image/png,image/jpeg,*/*;q=0.8'), true)
            assert.equal(needsMatchFallback('image/avif', '*/*'), false)
            assert.equal(needsMatchFallback('image/avif', ''), false)
        })

        it('leaves formats every client can read alone', function() {
            assert.equal(needsMatchFallback('image/jpeg', 'image/png,*/*;q=0.8'), false)
            assert.equal(needsMatchFallback('image/webp', 'image/png,*/*;q=0.8'), false)
        })
    })

    describe('isBlacklistedUrl', function() {
        const initFixture = () => initBlacklistService(
            ['https://example.com/exact/listed.jpg'],
            [],
            ['bad-host.example', '*.sloppy.example', 'https://from-url.example/some/path'],
        )

        before(initFixture)

        after(function() {
            // Restore the module-load state so other suites see the real static
            // lists (the repo's static blacklist files all hold empty lists, so
            // empty lists ARE the module-load state)
            initBlacklistService([], [], [])
        })

        it('matches exact listed URLs', function() {
            assert.equal(isBlacklistedUrl('https://example.com/exact/listed.jpg'), true)
            assert.equal(isBlacklistedUrl('https://example.com/exact/other.jpg'), false)
        })

        it('matches any URL on a listed domain', function() {
            assert.equal(isBlacklistedUrl('https://bad-host.example/uploads/a.jpg'), true)
            assert.equal(isBlacklistedUrl('http://bad-host.example/other/path.png?x=1'), true)
        })

        it('matches subdomains of a listed domain', function() {
            assert.equal(isBlacklistedUrl('https://cdn.bad-host.example/a.jpg'), true)
            assert.equal(isBlacklistedUrl('https://a.b.bad-host.example/a.jpg'), true)
        })

        it('does not match lookalike or suffix-sharing hosts', function() {
            assert.equal(isBlacklistedUrl('https://notbad-host.example/a.jpg'), false)
            assert.equal(isBlacklistedUrl('https://bad-host.example.evil.tld/a.jpg'), false)
            assert.equal(isBlacklistedUrl('https://unrelated.example/a.jpg'), false)
        })

        it('is case-insensitive on the host only', function() {
            assert.equal(isBlacklistedUrl('https://CDN.Bad-Host.Example/a.jpg'), true)
        })

        it('normalizes sloppy domain-list entries', function() {
            assert.equal(isBlacklistedUrl('https://sub.sloppy.example/a.jpg'), true)
            assert.equal(isBlacklistedUrl('https://sloppy.example/a.jpg'), true)
            assert.equal(isBlacklistedUrl('https://from-url.example/anything.jpg'), true)
        })

        it('keeps matching the empty 0x0 URL', function() {
            assert.equal(isBlacklistedUrl(EMPTY_IMAGE_URL_PATTERNS[0]), true)
        })

        it('matches FQDN hosts with a trailing root dot', function() {
            assert.equal(isBlacklistedUrl('https://bad-host.example./a.jpg'), true)
            assert.equal(isBlacklistedUrl('https://cdn.bad-host.example./a.jpg'), true)
        })

        it('matches unicode (IDN) entries against their punycode host form', function() {
            initBlacklistService([], [], ['bücher.example'])
            try {
                assert.equal(isBlacklistedUrl('https://xn--bcher-kva.example/a.jpg'), true)
                assert.equal(isBlacklistedUrl('https://bücher.example/a.jpg'), true)
                assert.equal(isBlacklistedUrl('https://sub.xn--bcher-kva.example/a.jpg'), true)
                assert.equal(isBlacklistedUrl('https://buecher.example/a.jpg'), false)
            } finally {
                initFixture()
            }
        })

        it('matches blocked sources nested inside public proxy wrappers', function() {
            // path-embedded wrappers, any outer host and any size segment
            assert.equal(isBlacklistedUrl('https://steemitimages.com/500x0/https://bad-host.example/uploads/a.jpg'), true)
            assert.equal(isBlacklistedUrl('https://images.hive.blog/0x0/https://cdn.bad-host.example/a.jpg'), true)
            // doubly wrapped
            assert.equal(isBlacklistedUrl('https://images.hive.blog/0x0/https://steemitimages.com/0x0/https://bad-host.example/a.jpg'), true)
            // %-encoded wrapper form
            assert.equal(isBlacklistedUrl('https://wsrv.nl/?url=' + encodeURIComponent('https://bad-host.example/a.jpg')), true)
            // base58 proxy-token wrapper form
            assert.equal(isBlacklistedUrl('https://images.hive.blog/p/' + base58Enc('https://bad-host.example/a.jpg')), true)
            // wrappers around unlisted sources stay allowed
            assert.equal(isBlacklistedUrl('https://steemitimages.com/500x0/https://unrelated.example/a.jpg'), false)
            assert.equal(isBlacklistedUrl('https://images.hive.blog/p/' + base58Enc('https://unrelated.example/a.jpg')), false)
        })

        it('matches exact listed URLs nested inside wrappers', function() {
            assert.equal(isBlacklistedUrl('https://steemitimages.com/0x0/https://example.com/exact/listed.jpg'), true)
        })

        it('resolves deeply nested base58 wrappers around a blocked source', function() {
            let wrapped = 'https://bad-host.example/uploads/a.jpg'
            for (let i = 0; i < 4; i++) {
                wrapped = `https://images.hive.blog/p/${ base58Enc(wrapped) }`
            }
            assert.equal(isBlacklistedUrl(wrapped), true)
        })

        it('fails closed when wrappers outrun the inspection budget', function() {
            // 30 plain-embedded wrapper layers around an ALLOWED source: the
            // scan budget runs out before every layer is inspected, and an
            // uninspectable URL must be rejected, not allowed
            let wrapped = 'https://unrelated.example/a.jpg'
            for (let i = 0; i < 30; i++) {
                wrapped = `https://layer${ i }.example/0x0/${ wrapped }`
            }
            assert.equal(isBlacklistedUrl(wrapped), true)
            // while a shallow wrap of the same allowed source resolves and passes
            assert.equal(isBlacklistedUrl(
                `https://images.hive.blog/p/${ base58Enc(`https://steemitimages.com/p/${ base58Enc('https://unrelated.example/a.jpg') }`) }`
            ), false)
        })

        it('fails closed on base58 tokens padded beyond the decode cap', function() {
            assert.equal(isBlacklistedUrl(`https://images.hive.blog/p/${ '1'.repeat(5000) }`), true)
        })

        it('is not blinded by a malformed escape elsewhere in the wrapper', function() {
            const encodedBlocked = encodeURIComponent('https://bad-host.example/a.jpg')
            // malformed fragment: upstream never sees it, the encoded source is
            // still resolved (from the defragmented decode) and blocked
            assert.equal(isBlacklistedUrl(`https://wsrv.nl/?url=${ encodedBlocked }#%ZZ`), true)
            // malformed escape in an unrelated query param: the source-relevant
            // part cannot be decoded, so the URL fails closed
            assert.equal(isBlacklistedUrl(`https://wsrv.nl/?url=${ encodedBlocked }&junk=%ZZ`), true)
            // a plain allowed URL with a junk fragment still resolves and passes
            assert.equal(isBlacklistedUrl('https://unrelated.example/a.jpg#%ZZ'), false)
            // an undecodable URL with no inspectable encoding also fails closed
            assert.equal(isBlacklistedUrl('https://unrelated.example/a.jpg?q=100%'), true)
        })

        it('resolves benign URLs with several embedded fragments within budget', function() {
            // Overlapping suffix extraction must dedupe: without the seen-set
            // these eight fragments would multiply past the budget and get
            // rejected despite every host being allowed
            const refs = Array.from({ length: 8 }, (_, i) => `x${ i }=http://frag${ i }.example/p${ i }`).join('&')
            assert.equal(isBlacklistedUrl(`https://ok.example/a.jpg?${ refs }`), false)
        })

        it('rejects fragment-flood URLs quickly instead of scanning combinatorially', function() {
            const refs = Array.from({ length: 150 }, (_, i) => `y${ i }=http://flood${ i }.example/q${ i }`).join('&')
            const flood = `https://ok.example/a.jpg?${ refs }`
            const start = Date.now()
            const verdict = isBlacklistedUrl(flood)
            const elapsed = Date.now() - start
            assert.equal(verdict, true, 'budget exhaustion must reject, not allow')
            assert(elapsed < 1000, `scan must stay cheap, took ${ elapsed }ms`)
        })

        it('ignores non-string domain entries without throwing', function() {
            initBlacklistService([], [], [42, null, {}, undefined, 'ok.example'] as any)
            try {
                assert.equal(isBlacklistedUrl('https://ok.example/a.jpg'), true)
                assert.equal(isBlacklistedUrl('https://42/a.jpg'), false)
                assert.equal(isBlacklistedUrl('https://null.example/a.jpg'), false)
            } finally {
                initFixture()
            }
        })
    })
})

describe('expandPurgeUrls', function() {
    // Cloudflare keys cache objects per hostname, so a purge that names only one
    // of the origins fronting this service leaves the other serving stale bytes.
    // In the test config INTERNAL_SERVICE_ORIGINS is the service_url origin plus
    // the legacy images.ecency.com origin.
    const [primary, legacy] = INTERNAL_SERVICE_ORIGINS

    it('fans a service URL out across every service origin', function() {
        const out = expandPurgeUrls(`${primary}/p/sometoken`)
        assert.equal(out.length, INTERNAL_SERVICE_ORIGINS.length)
        assert.ok(out.includes(`${primary}/p/sometoken`))
        assert.ok(out.includes(`${legacy}/p/sometoken`))
    })

    it('fans out a URL given on the legacy origin too, not just the primary', function() {
        const out = expandPurgeUrls(`${legacy}/u/alice/avatar/small`)
        assert.ok(out.includes(`${primary}/u/alice/avatar/small`))
        assert.ok(out.includes(`${legacy}/u/alice/avatar/small`))
    })

    it('preserves the query string on every origin', function() {
        const out = expandPurgeUrls(`${primary}/p/tok?format=match&mode=fit`)
        assert.ok(out.includes(`${primary}/p/tok?format=match&mode=fit`))
        assert.ok(out.includes(`${legacy}/p/tok?format=match&mode=fit`))
    })

    it('accepts an array and deduplicates the result', function() {
        const out = expandPurgeUrls([`${primary}/p/tok`, `${legacy}/p/tok`, `${primary}/p/tok`])
        assert.equal(out.length, INTERNAL_SERVICE_ORIGINS.length)
    })

    it('never rewrites a URL belonging to some other host onto ours', function() {
        const foreign = 'https://images.hive.blog/p/sometoken'
        assert.deepEqual(expandPurgeUrls(foreign), [foreign])
    })

    it('passes a non-URL string through untouched rather than throwing', function() {
        assert.deepEqual(expandPurgeUrls('not a url'), ['not a url'])
    })

    it('returns an empty list for empty input', function() {
        assert.deepEqual(expandPurgeUrls([]), [])
    })
})

describe('redactUrlForLog', function() {
    // Source URLs come from post bodies, so their query strings are attacker-chosen.
    // Sampling 2,000 live /p/ tokens found 2% carrying a query string and two
    // carrying real credentials, so these must never reach the log stream verbatim.

    it('strips a Firebase Storage download token', function() {
        const out = redactUrlForLog(
            'https://firebasestorage.googleapis.com/v0/b/x.appspot.com/o/i.jpg?alt=media&token=8f3a-secret')
        assert(!out.includes('8f3a-secret'), 'token must not survive')
        assert(!out.includes('token='), 'param names must not survive either')
        assert(out.startsWith('https://firebasestorage.googleapis.com/v0/b/x.appspot.com/o/i.jpg'))
    })

    it('keeps origin and path, which is what identifies the image', function() {
        assert.equal(
            redactUrlForLog('https://images.hive.blog/p/2bP4pJr4wVimqCWjYimXJe2cnCgn7xgWFC3wnAKkdCa'),
            'https://images.hive.blog/p/2bP4pJr4wVimqCWjYimXJe2cnCgn7xgWFC3wnAKkdCa')
    })

    it('records that a query existed, and how many params, without their values', function() {
        const out = redactUrlForLog('https://example.com/a.jpg?w=100&t=abc&key=secret')
        assert.equal(out, 'https://example.com/a.jpg?<3 param(s) redacted>')
    })

    it('redacts the wrapped URL in a mirror candidate too', function() {
        const out = redactUrlForLog('https://wsrv.nl/?url=https%3A%2F%2Fexample.com%2Fa.jpg%3Ftoken%3Dsecret')
        assert(!out.includes('secret'), 'a token wrapped inside a mirror URL must not survive')
        assert(out.startsWith('https://wsrv.nl/'))
    })

    it('truncates rather than passing through something that is not a URL', function() {
        const long = 'x'.repeat(500)
        const out = redactUrlForLog(long)
        assert(out.length <= 120, `expected truncation, got ${ out.length }`)
    })

    it('handles empty and missing input without throwing', function() {
        assert.equal(redactUrlForLog(''), '')
        assert.equal(redactUrlForLog(undefined), '')
        assert.equal(redactUrlForLog(null), '')
    })
})
