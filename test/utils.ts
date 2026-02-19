import 'mocha'
import * as assert from 'assert'
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
    stripWebpOrPng,
    getImageKey,
    getUrlHashKey,
    parseProxiedUrl,
    parsePlainUrl,
    getOrigKeyFromUrl,
    sanitizeIgnoreInvalidateParams,
    isBlacklistedUrl,
    ScalingMode,
    OutputFormat,
} from './../src/utils'

import {
    isEmptyImageUrl,
    startsWithEmptyImagePrefix,
    applyUrlReplacements,
    SERVICE_BASE_URL,
    SPECIAL_EMPTY_IMAGE_PATH,
    DEFAULT_FALLBACK_IMAGE_URL,
    DEFAULT_AVATAR_HASH,
    EMPTY_IMAGE_URL_PATTERNS,
} from './../src/constants'

import { APIError } from './../src/error'

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

        it('should return fallback for invalid base58', function() {
            const result = parseProxiedUrl('not-valid-base58!!!')
            assert.equal(result.toString(), DEFAULT_FALLBACK_IMAGE_URL)
        })

        it('should return fallback for non-URL after decoding', function() {
            const encoded = base58Enc('not a url')
            const result = parseProxiedUrl(encoded)
            assert.equal(result.toString(), DEFAULT_FALLBACK_IMAGE_URL)
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
            const url = new URL('https://images.ecency.com/DQmZi174Xz96UrRVBMNRHb6A2FfU3z1HRPwPPQCgSMgdiUT/test.jpg')
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

})

describe('constants', function() {

    describe('isEmptyImageUrl', function() {
        it('should match exact empty image URL patterns', function() {
            assert.equal(isEmptyImageUrl(SERVICE_BASE_URL + '/0x0/'), true)
            assert.equal(isEmptyImageUrl(SERVICE_BASE_URL + '/0x0'), true)
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

    describe('exported constants', function() {
        it('should have valid SERVICE_BASE_URL', function() {
            assert(SERVICE_BASE_URL.startsWith('http'), 'should be a URL')
        })

        it('should have correct SPECIAL_EMPTY_IMAGE_PATH', function() {
            assert.equal(SPECIAL_EMPTY_IMAGE_PATH, '0x0')
        })

        it('should have valid DEFAULT_FALLBACK_IMAGE_URL', function() {
            assert(DEFAULT_FALLBACK_IMAGE_URL.startsWith(SERVICE_BASE_URL))
            assert(DEFAULT_FALLBACK_IMAGE_URL.includes('1x1_000000.png'))
        })

        it('should have valid DEFAULT_AVATAR_HASH', function() {
            assert(DEFAULT_AVATAR_HASH.startsWith('DQm'))
        })

        it('should have two EMPTY_IMAGE_URL_PATTERNS', function() {
            assert.equal(EMPTY_IMAGE_URL_PATTERNS.length, 2)
            assert(EMPTY_IMAGE_URL_PATTERNS[0].includes('0x0/'))
            assert(EMPTY_IMAGE_URL_PATTERNS[1].includes('0x0'))
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
