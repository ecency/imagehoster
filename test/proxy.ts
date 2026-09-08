import 'mocha'
import assert from 'assert'
import config from 'config'
import {createHash} from 'crypto'
import * as http from 'http'
import needle from 'needle'
import * as multihash from 'multihashes'
import * as path from 'path'
import * as fs from 'fs'
import sharp from 'sharp'
import etag from 'etag'
import Koa from 'koa'

import {app} from './../src/app'
import {APIError, errorMiddleware} from './../src/error'
import {clearDeadUrl, fetchImageWithFallbacks, markDeadUrl} from './../src/fetch-image'
import {initBlacklistService} from './../src/blacklist-service'
import {proxyStore, uploadStore} from './../src/common'
import {DEFAULT_FALLBACK_IMAGE_URL, MAX_CACHED_ORIGINAL_SIZE, SERVICE_BASE_URL} from './../src/constants'
import {shouldCacheOriginal} from './../src/proxy'
import {fallbackEtag, fallbackImage, passthroughEtag, realEtag, realImage} from './../src/served-image'
import {
    base58Enc, getDefaultUrlAndParams, getImageKey, OutputFormat, readStream, ScalingMode, storeExists, storeRemove, storeWrite,
} from './../src/utils'

import {uploadImage} from './upload'

describe('proxy', function() {
    const port = 63205
    const server = http.createServer(app.callback())

    before((done) => { server.listen(port, 'localhost', done) })
    after((done) => { server.close(done) })

    needle.defaults({follow_max: 1})

    let serveImage = true
    const imageServer = http.createServer((req, res) => {
        if (serveImage) {
            fs.createReadStream(path.resolve(__dirname, 'test.jpg')).pipe(res)
        } else {
            res.writeHead(404)
            res.end()
        }
    })

    before((done) => { imageServer.listen(port+1, 'localhost', done) })
    after((done) => { imageServer.close(done) })

    it('should proxy', async function() {
        this.slow(1000)
        const res = await needle('get', `http://localhost:${ port }/0x0/http://localhost:${ port+1 }/test.jpg`)
        const image = sharp(res.body)
        const meta = await image.metadata()
        assert.equal(meta.width, 1280)
        assert.equal(meta.height, 853)
        assert.equal(meta.format, 'jpeg')
        assert.equal(meta.space, 'srgb')
    })

    it('should proxy and resize', async function() {
        this.slow(1000)
        const res = await needle('get', `http://localhost:${ port }/100x0/http://localhost:${ port+1 }/test.jpg`)
        const image = sharp(res.body)
        const meta = await image.metadata()
        assert.equal(meta.width, 100)
        assert.equal(meta.height, 67)
        assert.equal(meta.format, 'jpeg')
        assert.equal(meta.space, 'srgb')
    })

    describe('error and placeholder responses stay out of the caches', function() {
        // The 1x1 placeholder upload and the default avatar are fetched from the
        // configured hosts when the substituted paths run; nothing below depends on
        // that fetch succeeding except the placeholder tests, which say so.

        it('answers a malformed proxy key with a 400 and nothing a cache could keep', async function() {
            this.slow(1000)
            for (const bad of ['not-valid-base58!!!', base58Enc('not a url'),
                '3W72119s5BjW3w55E9m2dpuZgVrNq2aY9kcSn9SY4wgjN3KWKyHprjyV9f7rjvBoQnFKrVP9XPjYGE3jRJcJqyq']) {
                const res = await needle('get', `http://localhost:${ port }/p/${ bad }?format=match&height=500&mode=fit&width=600`)
                assert.equal(res.statusCode, 400, `${ bad }: status`)
                assert.equal(res.body.error.name, 'invalid_proxy_url', `${ bad }: body ${ JSON.stringify(res.body) }`)
                assert.equal(res.headers['etag'], undefined, `${ bad }: error response must carry no ETag`)
                assert.equal(res.headers['last-modified'], undefined, `${ bad }: error response must carry no Last-Modified`)
                assert.equal(res.headers['cache-control'], 'no-store, no-cache', `${ bad }: cache-control`)
            }
        })

        it('answers an error with no-store even on a path that had already set headers', async function() {
            this.slow(1000)
            serveImage = true
            const source = `http://localhost:${ port+1 }/test.jpg`
            const res = await needle('get', `http://localhost:${ port }/p/${ base58Enc(source) }?width=100&mode=fit&invalidate=1`)
            assert.equal(res.statusCode, 403)
            assert.equal(res.headers['etag'], undefined)
            assert.equal(res.headers['cache-control'], 'no-store, no-cache')
        })

        it('strips validators the handler set before it failed', async function() {
            // The handlers set ETag(imageKey) before doing any work, so an error
            // raised later would otherwise go out wearing the image's validator and
            // a cache could revalidate the error body against the real image
            const failing = new Koa()
            failing.on('error', () => undefined) // the thrown APIError is the point of the test
            failing.use(errorMiddleware as any)
            failing.use(async (ctx) => {
                ctx.set('ETag', '"the-image-etag"')
                ctx.set('Last-Modified', new Date().toUTCString())
                ctx.set('Cache-Control', 'public,max-age=31536000,immutable')
                throw new APIError({code: APIError.Code.InvalidImage})
            })
            const failingServer = http.createServer(failing.callback())
            await new Promise<void>((resolve) => failingServer.listen(0, 'localhost', () => resolve()))
            try {
                const failingPort = (failingServer.address() as any).port
                const res = await needle('get', `http://localhost:${ failingPort }/anything`)
                assert.equal(res.statusCode, 400)
                assert.equal(res.headers['etag'], undefined, 'ETag set before the failure must not survive it')
                assert.equal(res.headers['last-modified'], undefined, 'Last-Modified set before the failure must not survive it')
                assert.equal(res.headers['cache-control'], 'no-store, no-cache')
            } finally {
                await new Promise<void>((resolve) => failingServer.close(() => resolve()))
            }
        })

        it('gives a placeholder for a dead source its own ETag and the 120s contract', async function() {
            this.slow(5000)
            this.timeout(15000)
            const source = `http://localhost:${ port+1 }/etag-placeholder-${ Date.now() }.jpg`
            const url = `http://localhost:${ port }/p/${ base58Enc(source) }?width=100&mode=fit`
            // A negatively cached URL skips the mirror walk and goes straight to the
            // default image, which is the fetch-fallback path with the source's key
            await markDeadUrl(source)
            try {
                const placeholder = await needle('get', url)
                assert.equal(placeholder.statusCode, 200)
                assert.equal(placeholder.headers['cache-control'], 'public,max-age=120')
                assert(placeholder.headers['etag'], 'placeholder carries an ETag so a placeholder still revalidates as one')
                const again = await needle('get', url)
                assert.equal(again.headers['etag'], placeholder.headers['etag'], 'placeholder ETag is deterministic')

                // Now the source is alive: the real image must not share the placeholder's ETag,
                // or a cache holding the placeholder would be told it is still current
                await clearDeadUrl(source)
                serveImage = true
                const real = await needle('get', url)
                assert.equal(real.statusCode, 200)
                assert.equal(real.headers['cache-control'], 'public,max-age=31536000,immutable')
                assert.equal((await sharp(real.body).metadata()).width, 100)
                assert.notEqual(real.headers['etag'], placeholder.headers['etag'],
                    'real image and its placeholder must never validate each other')
            } finally {
                await clearDeadUrl(source)
            }
        })

        it('serves the built placeholder for an unsupported source type under the 120s contract', async function() {
            this.slow(5000)
            this.timeout(15000)
            // A binary body needle keeps as a Buffer (a text body comes back as a
            // string and the fetch chain rejects it before this path is reached),
            // with magic bytes that match no image type
            const textServer = http.createServer((_req, res) => {
                res.writeHead(200, {'content-type': 'application/octet-stream'})
                res.end(Buffer.from([0x00, 0x01, 0x02, 0x03, 0x7f, 0x45, 0x4c, 0x46, 0xde, 0xad, 0xbe, 0xef]))
            })
            await new Promise<void>((resolve) => textServer.listen(0, 'localhost', () => resolve()))
            const textPort = (textServer.address() as any).port
            try {
                const source = `http://localhost:${ textPort }/notes.txt`
                const res = await needle('get', `http://localhost:${ port }/p/${ base58Enc(source) }?width=100&mode=fit`)
                assert.equal(res.statusCode, 200)
                // the builder always renders the default as JPEG for format=match,
                // which is how this path is told apart from the fetch-fallback one
                assert.equal(res.headers['content-type'], 'image/jpeg')
                assert.equal(res.headers['cache-control'], 'public,max-age=120')
                const key = getImageKey('U' + multihash.toB58String(multihash.encode(
                    createHash('sha1').update(source).digest(), 'sha1')), {width: 100, mode: ScalingMode.Fit, format: OutputFormat.Match} as any)
                assert.equal(res.headers.etag, fallbackEtag(key), 'built placeholder carries the placeholder ETag for the requested key')
            } finally {
                await new Promise<void>((resolve) => textServer.close(() => resolve()))
            }
        })
    })

    describe('conditional requests', function() {
        it('answers 304 for a client holding the real variant, and 200 for one holding a placeholder', async function() {
            this.slow(3000)
            serveImage = true
            const source = `http://localhost:${ port+1 }/test.jpg`
            const url = `http://localhost:${ port }/p/${ base58Enc(source) }?width=120&mode=fit`
            const warm = await needle('get', url)
            assert.equal(warm.statusCode, 200)
            assert.equal(warm.headers['cache-control'], 'public,max-age=31536000,immutable')

            // Koa's default status is 404 until a body is set and ctx.fresh only looks
            // at conditional headers on a 2xx, so this branch never fired before
            const inm = await needle('get', url, null, { headers: { 'if-none-match': warm.headers.etag as string } })
            assert.equal(inm.statusCode, 304)

            // the placeholder ETag for the same key is not the real one, so a client
            // that cached a placeholder is handed the real image, never a 304
            const opts = {width: 120, mode: ScalingMode.Fit, format: OutputFormat.Match} as any
            const key = getImageKey('U' + multihash.toB58String(multihash.encode(
                createHash('sha1').update(source).digest(), 'sha1')), opts)
            assert.equal(warm.headers.etag, realEtag(key, warm.body, warm.body.length), 'real ETag is derived from the key and the stored bytes')
            const stale = await needle('get', url, null, { headers: { 'if-none-match': fallbackEtag(key) } })
            assert.equal(stale.statusCode, 200)
            assert.equal((await sharp(stale.body).metadata()).width, 120)
        })

        it('serves a cached variant under a substituted key with the fallback contract', async function() {
            this.slow(3000)
            // A variant of the DEFAULT image can legitimately sit in the store (it is a
            // real render of a real upload). When a blocked source is substituted with
            // the default, the cache-hit branch must still answer as a placeholder.
            const source = `http://127.0.0.1:${ port+1 }/blocked-seeded.jpg`
            const url = `http://localhost:${ port }/p/${ base58Enc(source) }?width=120&mode=fit`
            const defaultUrl = getDefaultUrlAndParams().url
            const defaultOrigKey = 'U' + multihash.toB58String(multihash.encode(
                createHash('sha1').update(defaultUrl.toString()).digest(), 'sha1'))
            const defaultKey = getImageKey(defaultOrigKey, {width: 120, mode: ScalingMode.Fit, format: OutputFormat.Match} as any)
            const seeded = await sharp(path.resolve(__dirname, 'test.jpg')).resize(120).jpeg().toBuffer()
            await storeWrite(proxyStore, defaultKey, seeded)
            initBlacklistService([], [], ['127.0.0.1'])
            try {
                const res = await needle('get', url)
                assert.equal(res.statusCode, 200)
                assert.equal(res.body.length, seeded.length, 'the seeded cached variant was served')
                assert.equal(res.headers['cache-control'], 'public,max-age=120')
                assert.equal(res.headers.etag, fallbackEtag(defaultKey))
            } finally {
                initBlacklistService([], [], [])
                try { await storeRemove(proxyStore, defaultKey) } catch (_e) { /* best effort */ }
            }
        })

        it('serves the original as a passthrough when the render fails, with its own ETag and no store write', async function() {
            this.slow(3000)
            this.timeout(15000)
            // A HEIC parses (container metadata) but its pixels need libde265, which
            // the stock development libvips lacks, so the render fails and the
            // original bytes are handed through. Inside the production image the
            // decode succeeds and this scenario does not arise; skip there.
            const heic = fs.readFileSync(path.resolve(__dirname, 'test.heic'))
            let decodes = true
            try { await sharp(heic).resize(64).jpeg().toBuffer() } catch (_e) { decodes = false }
            if (decodes) { this.skip() }

            const heicServer = http.createServer((_req, res) => { res.writeHead(200, {'content-type': 'image/heic'}); res.end(heic) })
            await new Promise<void>((resolve) => heicServer.listen(0, 'localhost', () => resolve()))
            const heicPort = (heicServer.address() as any).port
            const source = `http://localhost:${ heicPort }/photo.heic`
            // blur=1 keeps the request on the Sharp pipeline: this fixture reports two
            // pages (primary plus auxiliary image) and the handler would otherwise take
            // the animated-passthrough branch before any decode is attempted
            const url = `http://localhost:${ port }/p/${ base58Enc(source) }?width=120&mode=fit&blur=1`
            const key = getImageKey('U' + multihash.toB58String(multihash.encode(
                createHash('sha1').update(source).digest(), 'sha1')), {width: 120, mode: ScalingMode.Fit, format: OutputFormat.Match, blur: true} as any)
            try {
                const res = await needle('get', url)
                assert.equal(res.statusCode, 200)
                assert.equal(res.body.length, heic.length, 'the original bytes are handed through')
                assert.equal(res.headers['cache-control'], 'public,max-age=3600', 'a passthrough is fresh for an hour, not a year')
                assert.equal(res.headers.etag, passthroughEtag(key))
                assert.notEqual(res.headers.etag, realEtag(key, res.body, res.body.length), 'a passthrough must not wear the variant ETag')
                assert.equal(await storeExists(proxyStore, key), false, 'a passthrough must not be stored as the variant')
                // a client holding the passthrough is not told it is current
                const inm = await needle('get', url, null, { headers: { 'if-none-match': res.headers.etag as string } })
                assert.equal(inm.statusCode, 200)
            } finally {
                await new Promise<void>((resolve) => heicServer.close(() => resolve()))
            }
        })

        it('does not let a failed cached conversion validate as the recovered variant', async function() {
            this.slow(3000)
            // A stored AVIF variant asked for by a client that cannot take AVIF is
            // converted on the way out. If that conversion fails the stored bytes are
            // handed back; they must not carry the variant ETag, or the client would
            // be told "not modified" once the conversion works again.
            const source = 'http://review.invalid/cached-avif.jpg'
            const key = getImageKey('U' + multihash.toB58String(multihash.encode(
                createHash('sha1').update(source).digest(), 'sha1')), {width: 100, mode: ScalingMode.Fit, format: OutputFormat.Match} as any)
            const avif = await sharp(path.resolve(__dirname, 'test.jpg')).resize(100).avif().toBuffer()
            await storeWrite(proxyStore, key, avif)
            const url = `http://localhost:${ port }/p/${ base58Enc(source) }?width=100&mode=fit&format=match`
            const gate = require('./../src/encode-limit')
            const realRunEncode = gate.runEncode
            try {
                gate.runEncode = async () => { throw new Error('simulated transient encode failure') }
                const first = await needle('get', url, null, {headers: {accept: 'image/jpeg'}})
                assert.equal(first.statusCode, 200)
                assert.equal(first.headers['content-type'], 'image/avif', 'stored bytes handed back unconverted')
                assert.equal(first.headers.etag, passthroughEtag(key))
                assert.equal(first.headers['cache-control'], 'public,max-age=3600')
                gate.runEncode = realRunEncode
                const recovered = await needle('get', url, null,
                    {headers: {accept: 'image/jpeg', 'if-none-match': first.headers.etag as string}})
                assert.equal(recovered.statusCode, 200, 'incompatible AVIF must not validate as the recovered JPEG')
                assert.equal(recovered.headers['content-type'], 'image/jpeg')
                assert.equal(recovered.headers.etag, ((b) => realEtag(key, b, b.length))(await readStream(proxyStore.createReadStream(key))), 'the converted variant is real again')
                assert.equal(recovered.headers['cache-control'], 'public,max-age=31536000,immutable')
            } finally {
                gate.runEncode = realRunEncode
                try { await storeRemove(proxyStore, key) } catch (_e) { /* best effort */ }
            }
        })

        it('renders the requested variant after a transient encode failure', async function() {
            this.slow(3000)
            serveImage = true
            const source = `http://localhost:${ port+1 }/test.jpg`
            const url = `http://localhost:${ port }/p/${ base58Enc(source) }?width=800&mode=fit&format=jpeg`
            const key = getImageKey('U' + multihash.toB58String(multihash.encode(
                createHash('sha1').update(source).digest(), 'sha1')), {width: 800, mode: ScalingMode.Fit, format: OutputFormat.JPEG} as any)
            const gate = require('./../src/encode-limit')
            const realRunEncode = gate.runEncode
            try {
                gate.runEncode = async () => { throw new Error('simulated transient encode failure') }
                const first = await needle('get', url)
                assert.equal(first.statusCode, 200)
                const originalWidth = (await sharp(path.resolve(__dirname, 'test.jpg')).metadata()).width
                assert.equal((await sharp(first.body).metadata()).width, originalWidth, 'the unresized original was handed through')
                assert.equal(first.headers.etag, passthroughEtag(key))
                assert.equal(await storeExists(proxyStore, key), false, 'a passthrough is not stored as the variant')
                gate.runEncode = realRunEncode
                const recovered = await needle('get', url, null, {headers: {'if-none-match': first.headers.etag as string}})
                assert.equal(recovered.statusCode, 200, 'unresized bytes must not validate as the recovered 800px variant')
                assert.equal((await sharp(recovered.body).metadata()).width, 800)
                assert.equal(recovered.headers.etag, realEtag(key, recovered.body, recovered.body.length))
            } finally {
                gate.runEncode = realRunEncode
                try { await storeRemove(proxyStore, key) } catch (_e) { /* best effort */ }
            }
        })

        it('answers 304 only while the store holds a healthy variant for the key', async function() {
            this.slow(3000)
            serveImage = true
            const source = `http://localhost:${ port+1 }/test.jpg`
            const url = `http://localhost:${ port }/p/${ base58Enc(source) }?width=130&mode=fit`
            const key = getImageKey('U' + multihash.toB58String(multihash.encode(
                createHash('sha1').update(source).digest(), 'sha1')), {width: 130, mode: ScalingMode.Fit, format: OutputFormat.Match} as any)
            const warm = await needle('get', url)
            assert.equal(warm.statusCode, 200)
            const inm = { headers: { 'if-none-match': warm.headers.etag as string } }
            assert.equal((await needle('get', url, null, inm)).statusCode, 304, 'healthy stored variant: vouch for the copy')
            // the variant is gone (pruned): nothing to vouch with, so render and answer 200
            await storeRemove(proxyStore, key)
            const again = await needle('get', url, null, inm)
            assert.equal(again.statusCode, 200)
            assert.equal((await sharp(again.body).metadata()).width, 130)
            assert.equal(await storeExists(proxyStore, key), true, 'and the variant is stored again')
            assert.equal((await needle('get', url, null, inm)).statusCode, 304)
        })

        it('never answers 304 for a substituted request', async function() {
            this.slow(3000)
            const source = `http://127.0.0.1:${ port+1 }/blocked-cond.jpg`
            const url = `http://localhost:${ port }/p/${ base58Enc(source) }?width=120&mode=fit`
            initBlacklistService([], [], ['127.0.0.1'])
            try {
                const placeholder = await needle('get', url)
                assert.equal(placeholder.statusCode, 200)
                assert.equal(placeholder.headers['cache-control'], 'public,max-age=120')
                // the substituted key is the default image's; even its real ETag must not shortcut
                const defaultUrl = getDefaultUrlAndParams().url
                const defaultKey = getImageKey('U' + multihash.toB58String(multihash.encode(
                    createHash('sha1').update(defaultUrl.toString()).digest(), 'sha1')),
                    {width: 120, mode: ScalingMode.Fit, format: OutputFormat.Match} as any)
                for (const candidate of [placeholder.headers.etag as string, etag(defaultKey)]) {
                    const res = await needle('get', url, null, { headers: { 'if-none-match': candidate } })
                    assert.equal(res.statusCode, 200, `must not answer 304 for ${ candidate }`)
                }
            } finally {
                initBlacklistService([], [], [])
            }
        })
    })

    describe('multi-image HEIC (#43)', function() {
        const heic = fs.readFileSync(path.resolve(__dirname, 'test.heic'))
        let decodes = true
        let heicServer: http.Server
        let source: string
        before(async function() {
            assert((await sharp(heic).metadata()).pages! > 1, 'fixture must be multi-page for these tests to mean anything')
            try { await sharp(heic).resize(64).jpeg().toBuffer() } catch (_e) { decodes = false }
            heicServer = http.createServer((_req, res) => { res.writeHead(200, {'content-type': 'image/heic'}); res.end(heic) })
            await new Promise<void>((resolve) => heicServer.listen(0, 'localhost', () => resolve()))
            source = `http://localhost:${ (heicServer.address() as any).port }/multi-page.heic`
        })
        after(async function() { await new Promise<void>((resolve) => heicServer.close(() => resolve())) })
        const keyFor = (src: string, opts: any) => getImageKey('U' + multihash.toB58String(multihash.encode(
            createHash('sha1').update(src).digest(), 'sha1')), opts)

        it('renders a resized still from the primary image', async function() {
            this.slow(4000)
            this.timeout(15000)
            // needs a libvips that decodes HEVC (the production build); the stock
            // development library parses the container but cannot decode its pixels
            if (!decodes) { this.skip() }
            const url = `http://localhost:${ port }/p/${ base58Enc(source) }?width=120&mode=fit`
            const key = keyFor(source, {width: 120, mode: ScalingMode.Fit, format: OutputFormat.Match})
            try {
                const res = await needle('get', url)
                assert.equal(res.statusCode, 200)
                assert.notEqual(res.body.length, heic.length, 'the raw container must not be handed through')
                assert.equal((await sharp(res.body).metadata()).width, 120)
                assert.notEqual(res.headers['content-type'], 'image/heif', 'match negotiates away from HEIF')
                assert.equal(res.headers.etag, realEtag(key, res.body, res.body.length))
                assert.equal(await storeExists(proxyStore, key), true)
            } finally {
                try { await storeRemove(proxyStore, key) } catch (_e) { /* best effort */ }
            }
        })

        it('never takes the animated branch: a two-page HEIC is not stored raw as the variant', async function() {
            this.slow(4000)
            this.timeout(15000)
            // Runs everywhere. The animated branch served the raw container as a REAL
            // variant (real ETag, stored). Whatever the render does here, that must
            // not happen: where the render fails, the original is a passthrough with
            // its own ETag and no store write.
            const url = `http://localhost:${ port }/p/${ base58Enc(source) }?width=100&mode=fit`
            const key = keyFor(source, {width: 100, mode: ScalingMode.Fit, format: OutputFormat.Match})
            try {
                const res = await needle('get', url)
                assert.equal(res.statusCode, 200)
                const storedRaw = await storeExists(proxyStore, key)
                    && (await sharp(await readStream(proxyStore.createReadStream(key))).metadata()).format === 'heif'
                assert.equal(storedRaw, false, 'the raw HEIC container must never be stored under the variant key')
                if (!decodes) { assert.equal(res.headers.etag, passthroughEtag(key)) }
            } finally {
                try { await storeRemove(proxyStore, key) } catch (_e) { /* best effort */ }
            }
        })

        it('does not honour the validator of a raw container: a conditional request is repaired too', async function() {
            this.slow(4000)
            this.timeout(15000)
            // A client that cached the raw container holds the real variant's ETag.
            // Answering 304 to it would tell the client to keep the broken bytes.
            const url = `http://localhost:${ port }/p/${ base58Enc(source) }?width=80&mode=fit`
            const key = keyFor(source, {width: 80, mode: ScalingMode.Fit, format: OutputFormat.Match})
            await storeWrite(proxyStore, key, heic)
            try {
                // the validators a pre-repair client can hold: the key-only ETag the
                // old code sent, and the raw container's own content validator
                for (const stale of [etag(key), realEtag(key, heic, heic.length)]) {
                    const res = await needle('get', url, null, {headers: {'if-none-match': stale}})
                    assert.equal(res.statusCode, 200, `the old validator ${ stale } must not shortcut past the repair`)
                    assert.notEqual(res.headers.etag, stale, 'the repaired representation carries a new validator')
                }
                const stillRaw = await storeExists(proxyStore, key)
                    && (await sharp(await readStream(proxyStore.createReadStream(key))).metadata()).format === 'heif'
                assert.equal(stillRaw, false, 'the poisoned variant is removed on the conditional request as well')
                // and a SECOND client, arriving after the repair with the old validator,
                // is not told to keep its broken copy either: the stored bytes changed,
                // so the validator did too
                const second = await needle('get', url, null, {headers: {'if-none-match': etag(key)}})
                assert.equal(second.statusCode, 200, 'a later client with the pre-repair validator must get the repaired bytes')
                const third = await needle('get', url, null, {headers: {'if-none-match': realEtag(key, heic, heic.length)}})
                assert.equal(third.statusCode, 200)
            } finally {
                try { await storeRemove(proxyStore, key) } catch (_e) { /* best effort */ }
            }
        })

        it('gives a repaired variant a new validator, so a second client with the old one is not told to keep its copy', async function() {
            this.slow(4000)
            this.timeout(15000)
            // Decoupled from HEVC decoding: the raw container is seeded under the key
            // of a JPEG source, so the repair renders and stores a real variant in
            // every environment. Then a client holding the pre-repair validator must
            // get a 200 with the repaired bytes, not a 304 for its broken copy.
            serveImage = true
            const jpegSource = `http://localhost:${ port+1 }/repaired-${ Date.now() }.jpg`
            const url = `http://localhost:${ port }/p/${ base58Enc(jpegSource) }?width=70&mode=fit`
            const key = keyFor(jpegSource, {width: 70, mode: ScalingMode.Fit, format: OutputFormat.Match})
            await storeWrite(proxyStore, key, heic)
            try {
                const preRepair = [etag(key), realEtag(key, heic, heic.length)]
                // first client: repairs
                const first = await needle('get', url, null, {headers: {'if-none-match': preRepair[0]}})
                assert.equal(first.statusCode, 200)
                assert.equal((await sharp(first.body).metadata()).width, 70, 'repaired render served')
                assert.equal(await storeExists(proxyStore, key), true, 'and stored')
                assert(!preRepair.includes(first.headers.etag as string), 'the repaired representation carries a new validator')
                // second client: arrives after the repair with the old validator
                for (const stale of preRepair) {
                    const second = await needle('get', url, null, {headers: {'if-none-match': stale}})
                    assert.equal(second.statusCode, 200, `a later client presenting ${ stale } must receive the repaired bytes`)
                    assert.equal((await sharp(second.body).metadata()).width, 70)
                }
                // and the new validator does revalidate
                const fresh = await needle('get', url, null, {headers: {'if-none-match': first.headers.etag as string}})
                assert.equal(fresh.statusCode, 304)
            } finally {
                try { await storeRemove(proxyStore, key) } catch (_e) { /* best effort */ }
            }
        })

        it('repairs a variant key that already holds a raw HEIC container', async function() {
            this.slow(4000)
            this.timeout(15000)
            // Before #43 the container was stored as the variant. Those entries stay
            // in the store; a hit on one must be discarded and re-rendered, not served.
            const url = `http://localhost:${ port }/p/${ base58Enc(source) }?width=90&mode=fit`
            const key = keyFor(source, {width: 90, mode: ScalingMode.Fit, format: OutputFormat.Match})
            await storeWrite(proxyStore, key, heic)
            try {
                // no Accept preference: the request lands on the Match key that was seeded
                const res = await needle('get', url)
                assert.equal(res.statusCode, 200)
                const stillRaw = await storeExists(proxyStore, key)
                    && (await sharp(await readStream(proxyStore.createReadStream(key))).metadata()).format === 'heif'
                assert.equal(stillRaw, false, 'the poisoned variant must be removed on read')
                if (decodes) {
                    assert.equal((await sharp(res.body).metadata()).width, 90, 'and the repaired render is served')
                    assert.equal(await storeExists(proxyStore, key), true, 'and stored in its place')
                } else {
                    assert.equal(res.headers.etag, passthroughEtag(key), 'without a decoder the original is a passthrough')
                }
            } finally {
                try { await storeRemove(proxyStore, key) } catch (_e) { /* best effort */ }
            }
        })
    })

    it('should proxy stored image when source is gone', async function() {
        // First, store via /p/ route (legacy routes no longer store)
        const imageUrl = base58Enc(`http://localhost:${ port+1 }/test.jpg`)
        await needle('get', `http://localhost:${ port }/p/${ imageUrl }?width=100&mode=fit`)
        // Now disable source and verify cached image is served
        serveImage = false
        const res = await needle('get', `http://localhost:${ port }/p/${ imageUrl }?width=100&mode=fit`)
        const image = sharp(res.body)
        const meta = await image.metadata()
        assert.equal(meta.width, 100)
        assert.equal(meta.height, 67)
        assert.equal(meta.format, 'jpeg')
        assert.equal(meta.space, 'srgb')
    })

    it('should proxy directly from upload store', async function() {
        this.slow(1000)
        serveImage = false
        const uploaded = await uploadImage(fs.readFileSync(path.resolve(__dirname, 'test.jpg')), port)
        const [key, fname] = uploaded.body.url.split('/').slice(-2)
        const res = await needle('get', `http://localhost:${ port }/0x0/${ uploaded.body.url }`)
        const image = sharp(res.body)
        const meta = await image.metadata()
        assert((await storeExists(proxyStore, key)) === false, 'proxy store has original')
    })

    it('should proxy using new api', async function() {
        this.slow(1000)
        serveImage = false
        const imageUrl = base58Enc(`http://localhost:${ port+1 }/test.jpg`)
        const res = await needle('get', `http://localhost:${ port }/p/${ imageUrl }?width=100&height=100&format=webp`)
        const image = sharp(res.body)
        const meta = await image.metadata()
        assert.equal(meta.width, 100)
        assert.equal(meta.height, 100)
        assert.equal(meta.format, 'webp')
        assert.equal(meta.space, 'srgb')
    })

    it('should return tiny blur placeholder', async function() {
        this.slow(1000)
        serveImage = true
        const imageUrl = base58Enc(`http://localhost:${ port+1 }/test.jpg`)
        const res = await needle('get', `http://localhost:${ port }/p/${ imageUrl }?blur=1`)
        const image = sharp(res.body)
        const meta = await image.metadata()
        assert.equal(meta.format, 'jpeg')
        assert(meta.width! <= 20, `blur width should be <=20, got ${meta.width}`)
        assert(res.body.length < 2000, `blur image should be small, got ${res.body.length} bytes`)
    })

    it('should resolve double proxied images', async function() {
        this.slow(1000)
        serveImage = false
        const imageUrl = base58Enc(`http://localhost:${ port+1 }/test.jpg`)
        const url1 = `http://localhost:${ port }/p/${ imageUrl }?width=100&height=100`
        const url2 = `http://localhost:${ port }/p/${ base58Enc(url1) }?width=200`
        const res = await needle('get', url2)
        console.log(res.body)
        const image = sharp(res.body)
        const meta = await image.metadata()
        assert.equal(meta.width, 200)
        // this would be 200 if the first url wasn't stripped
        assert.equal(meta.height, 133)
    })

    describe('esteem legacy', function() {
        const esteemUrl = 'https://img.esteem.ws/rescuetest1.jpg'
        // originals are stored under the historically rewritten URL's key
        const esteemKey = 'U' + multihash.toB58String(multihash.encode(
            createHash('sha1').update(`https://steemitimages.com/0x0/${ esteemUrl }`).digest(), 'sha1'
        ))

        before(async () => {
            await storeWrite(uploadStore, esteemKey, fs.readFileSync(path.resolve(__dirname, 'test.jpg')))
        })

        it('should serve esteem-legacy images from the upload store', async function() {
            this.slow(1000)
            serveImage = false
            const res = await needle('get', `http://localhost:${ port }/p/${ base58Enc(esteemUrl) }?width=100&mode=fit`)
            const meta = await sharp(res.body).metadata()
            assert.equal(meta.width, 100)
            assert.equal(meta.format, 'jpeg')
            // original must not be duplicated into the proxy store
            assert((await storeExists(proxyStore, esteemKey)) === false, 'proxy store has esteem original')
        })

        it('should resolve wrapped esteem URLs to the same rescued original', async function() {
            this.slow(1000)
            serveImage = false
            const wrapped = `https://steemitimages.com/500x0/${ esteemUrl }`
            const res = await needle('get', `http://localhost:${ port }/p/${ base58Enc(wrapped) }?width=120&mode=fit`)
            const meta = await sharp(res.body).metadata()
            assert.equal(meta.width, 120)
            assert.equal(meta.format, 'jpeg')
        })

        it('should reject invalidate without the invalidate key', async function() {
            // The rejection path had no cover, so a refactor of the gate could not
            // be caught. Deplorable maps to 403 in src/error.ts.
            this.slow(1000)
            const res = await needle('get',
                `http://localhost:${ port }/p/${ base58Enc(esteemUrl) }?width=100&mode=fit&invalidate=1`)
            assert.equal(res.statusCode, 403)
        })

        it('should reject invalidate with a wrong invalidate key', async function() {
            this.slow(1000)
            const res = await needle('get',
                `http://localhost:${ port }/p/${ base58Enc(esteemUrl) }?width=100&mode=fit&invalidate=1`,
                null, { headers: { 'x-invalidate-key': 'not-the-token' } })
            assert.equal(res.statusCode, 403)
        })

        it('should not remove esteem-legacy originals on invalidate', async function() {
            this.slow(1000)
            serveImage = false
            const res = await needle('get',
                `http://localhost:${ port }/p/${ base58Enc(esteemUrl) }?width=100&mode=fit&invalidate=1`,
                null, { headers: { 'x-invalidate-key': 'test-invalidate-token' } })
            assert.equal(res.statusCode, 200)
            assert((await storeExists(uploadStore, esteemKey)) === true, 'esteem original was removed from upload store')
        })
    })

    describe('rescued originals archive', function() {
        // a source whose origin no longer exists; its original was rescued into
        // the upload store under the proxy-derived key
        const deadUrl = `http://localhost:${ port+2 }/gone.jpg`
        const deadKey = 'U' + multihash.toB58String(multihash.encode(
            createHash('sha1').update(deadUrl).digest(), 'sha1'
        ))

        before(async () => {
            await storeWrite(uploadStore, deadKey, fs.readFileSync(path.resolve(__dirname, 'test.jpg')))
        })

        it('should serve rescued dead-origin originals from the upload store', async function() {
            this.slow(1000)
            const res = await needle('get', `http://localhost:${ port }/p/${ base58Enc(deadUrl) }?width=100&mode=fit`)
            const meta = await sharp(res.body).metadata()
            assert.equal(meta.width, 100)
            assert.equal(meta.format, 'jpeg')
            // archive reads are read-only: original must not be copied into the proxy store
            assert((await storeExists(proxyStore, deadKey)) === false, 'archive original copied into proxy store')
        })

        it('should unwrap wrapped esteem.app URLs to their raw-key archived original', async function() {
            this.slow(1000)
            const appUrl = 'https://img.esteem.app/apptest1.jpg'
            const appKey = 'U' + multihash.toB58String(multihash.encode(
                createHash('sha1').update(appUrl).digest(), 'sha1'
            ))
            await storeWrite(uploadStore, appKey, fs.readFileSync(path.resolve(__dirname, 'test.jpg')))
            const wrapped = `https://images.hive.blog/640x0/${ appUrl }`
            const res = await needle('get', `http://localhost:${ port }/p/${ base58Enc(wrapped) }?width=110&mode=fit`)
            const meta = await sharp(res.body).metadata()
            assert.equal(meta.width, 110)
            assert.equal(meta.format, 'jpeg')
        })

        it('should serve rescued originals even with ignorecache (archive is origin, not cache)', async function() {
            this.timeout(15000)
            this.slow(2000)
            const u = `http://localhost:${ port+2 }/ignorecache-test.jpg`
            const k = 'U' + multihash.toB58String(multihash.encode(
                createHash('sha1').update(u).digest(), 'sha1'
            ))
            await storeWrite(uploadStore, k, fs.readFileSync(path.resolve(__dirname, 'test.jpg')))
            // Authenticated: an unauthenticated ignorecache is now inert, so without
            // the header this would still pass but would no longer exercise a bypass.
            const res = await needle('get', `http://localhost:${ port }/p/${ base58Enc(u) }?width=90&mode=fit&ignorecache=1`,
                null, { headers: { 'x-invalidate-key': 'test-invalidate-token' } })
            const meta = await sharp(res.body).metadata()
            assert.equal(meta.width, 90)
            assert((await storeExists(uploadStore, k)) === true, 'archive object must survive ignorecache')
        })

        it('should ignore an unauthenticated ignorecache and serve the cached variant', async function() {
            // ignorecache forces the same work as invalidate: skip the stored variant,
            // re-fetch upstream, re-decode, re-encode. Anonymous callers must not be
            // able to turn one cheap cache hit into a full miss.
            this.slow(1000)
            const u = `http://localhost:${ port+2 }/unauth-ignorecache.jpg`
            const origKey = 'U' + multihash.toB58String(multihash.encode(
                createHash('sha1').update(u).digest(), 'sha1'
            ))
            // Prime BOTH the original and the rendered variant, then point the source
            // at a path the local test server does not serve: if the gate leaks, the
            // handler refetches and the request cannot succeed from cache.
            const variantKey = `${ origKey }_120x0`
            const primed = await sharp(fs.readFileSync(path.resolve(__dirname, 'test.jpg')))
                .resize(120, null, { fit: 'inside' }).jpeg().toBuffer()
            await storeWrite(proxyStore, variantKey, primed)
            const res = await needle('get',
                `http://localhost:${ port }/p/${ base58Enc(u) }?width=120&mode=fit&ignorecache=1`)
            assert.equal(res.statusCode, 200)
            const meta = await sharp(res.body).metadata()
            assert.equal(meta.width, 120, 'must have been served from the primed variant')
        })

        it('should honour ignorecache when the invalidate key is presented', async function() {
            // An honoured bypass does a real upstream fetch plus a re-render, which
            // runs ~1-2s alone and occasionally crosses mocha's 2s default under
            // full-suite load. slow() only affects reporting, not the deadline.
            this.timeout(15000)
            this.slow(2000)
            const u = `http://localhost:${ port+2 }/auth-ignorecache.jpg`
            const origKey = 'U' + multihash.toB58String(multihash.encode(
                createHash('sha1').update(u).digest(), 'sha1'
            ))
            // A primed variant at the WRONG size: an honoured bypass must skip it and
            // re-render from the real source, so the served width proves the bypass ran.
            const variantKey = `${ origKey }_130x0`
            const wrong = await sharp(fs.readFileSync(path.resolve(__dirname, 'test.jpg')))
                .resize(40, null, { fit: 'inside' }).jpeg().toBuffer()
            await storeWrite(proxyStore, variantKey, wrong)
            const res = await needle('get',
                `http://localhost:${ port }/p/${ base58Enc(u) }?width=130&mode=fit&ignorecache=1`,
                null, { headers: { 'x-invalidate-key': 'test-invalidate-token' } })
            assert.equal(res.statusCode, 200)
            const meta = await sharp(res.body).metadata()
            assert.equal(meta.width, 130, 'authenticated bypass must re-render, not serve the stale variant')
        })

        it('should keep archive objects that fail sharp metadata extraction', async function() {
            // valid JPEG magic so mimeMagic passes, but Sharp cannot parse it:
            // exercises the metadata-failure purge path — must not delete from upload store
            this.timeout(30000)
            this.slow(20000)
            const u = `http://localhost:${ port+2 }/corrupt-meta.jpg`
            const k = 'U' + multihash.toB58String(multihash.encode(
                createHash('sha1').update(u).digest(), 'sha1'
            ))
            const fakeJpeg = Buffer.concat([
                Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]),
                Buffer.alloc(128, 0x41),
            ])
            await storeWrite(uploadStore, k, fakeJpeg)
            await needle('get', `http://localhost:${ port }/p/${ base58Enc(u) }?width=100&mode=fit`)
            assert((await storeExists(uploadStore, k)) === true, 'corrupt-metadata archive object was deleted')
        })

        it('should never delete invalid archive objects from the upload store', async function() {
            // corrupt archive object: request falls through to fetch/fallbacks
            // (may take a while), but the archived object must survive
            this.timeout(30000)
            this.slow(20000)
            const corruptUrl = `http://localhost:${ port+2 }/corrupt.jpg`
            const corruptKey = 'U' + multihash.toB58String(multihash.encode(
                createHash('sha1').update(corruptUrl).digest(), 'sha1'
            ))
            await storeWrite(uploadStore, corruptKey, Buffer.from('definitely not an image'))
            await needle('get', `http://localhost:${ port }/p/${ base58Enc(corruptUrl) }?width=100&mode=fit`)
            assert((await storeExists(uploadStore, corruptKey)) === true, 'invalid archive object was deleted from upload store')
        })
    })

    describe('original caching cap', function() {
        const cacheable = {image: realImage(Buffer.alloc(0)), usesUploadStore: false, isLegacy: false}
        const MAX_IMAGE_SIZE = Number.parseInt(config.get('max_image_size'))

        it('should keep the test cap below the upload limit', function() {
            // Otherwise "over the cap" would also be over max_image_size and the
            // cap tests below would still pass with the cap check deleted.
            assert(MAX_CACHED_ORIGINAL_SIZE < MAX_IMAGE_SIZE,
                `cap ${MAX_CACHED_ORIGINAL_SIZE} must be < max_image_size ${MAX_IMAGE_SIZE}`)
        })

        it('should cache originals up to the cap', function() {
            assert.equal(shouldCacheOriginal(1, cacheable), true)
            assert.equal(shouldCacheOriginal(MAX_CACHED_ORIGINAL_SIZE, cacheable), true)
        })

        it('should skip originals over the cap but within the upload limit', function() {
            const overCap = MAX_CACHED_ORIGINAL_SIZE + 1
            assert(overCap <= MAX_IMAGE_SIZE, 'size must still pass the upload limit')
            assert.equal(shouldCacheOriginal(overCap, cacheable), false)
        })

        it('should still enforce the upload limit', function() {
            assert.equal(shouldCacheOriginal(MAX_IMAGE_SIZE + 1, cacheable, MAX_IMAGE_SIZE * 2), false)
        })

        it('should treat a zero cap as "never cache originals"', function() {
            assert.equal(shouldCacheOriginal(0, cacheable, 0), false)
            assert.equal(shouldCacheOriginal(1, cacheable, 0), false)
        })

        it('should still skip fallback, upload-store and legacy originals', function() {
            assert.equal(shouldCacheOriginal(1, {...cacheable, image: fallbackImage(Buffer.alloc(0), 'test')}), false)
            assert.equal(shouldCacheOriginal(1, {...cacheable, usesUploadStore: true}), false)
            assert.equal(shouldCacheOriginal(1, {...cacheable, isLegacy: true}), false)
        })
    })

    describe('domain blacklist on nested proxy URLs', function() {
        // Bound to 127.0.0.1 explicitly so the nested source host is deterministic
        let nestedPort = 0
        let nestedHits = 0
        const nestedServer = http.createServer((req, res) => {
            nestedHits++
            fs.createReadStream(path.resolve(__dirname, 'test.jpg')).pipe(res)
        })
        before((done) => {
            nestedServer.listen(0, '127.0.0.1', () => {
                nestedPort = (nestedServer.address() as any).port
                done()
            })
        })
        after((done) => { nestedServer.close(done) })

        // An ALLOWED host that redirects to the (blocked) nested server
        let redirectPort = 0
        const redirectServer = http.createServer((req, res) => {
            res.writeHead(302, { Location: `http://127.0.0.1:${ nestedPort }${ req.url }` })
            res.end()
        })
        before((done) => {
            redirectServer.listen(0, 'localhost', () => {
                redirectPort = (redirectServer.address() as any).port
                done()
            })
        })
        after((done) => { redirectServer.close(done) })

        // Stock the default fallback image so blocked requests resolve it from
        // the upload store instead of chasing external mirrors for it
        const defaultKey = new URL(DEFAULT_FALLBACK_IMAGE_URL).pathname.slice(1).split('/')[0]
        before(async () => {
            await storeWrite(uploadStore, defaultKey, fs.readFileSync(path.resolve(__dirname, 'test.png')))
        })
        after(async () => {
            await storeRemove(uploadStore, defaultKey)
        })

        it('blocks a blacklisted source wrapped inside an allowed 0x0 proxy URL', async function() {
            this.slow(3000)
            const source = `http://127.0.0.1:${ nestedPort }/nested-test.jpg`
            // A /0x0/-wrapped internal URL is NOT unwrapped by the early
            // isInternalProxyUrl loop (that handles /p/ forms only) — it goes
            // through the late 0x0-prefix extraction, past the initial check
            const nested = `${ SERVICE_BASE_URL }/0x0/${ source }`
            const params = 'width=100&mode=fit'

            // Prime the variant cache under the source's key, then prove the
            // nested form resolves to that same cached variant
            const prime = await needle('get', `http://localhost:${ port }/p/${ base58Enc(source) }?${ params }`)
            assert.equal((await sharp(prime.body).metadata()).width, 100)
            const control = await needle('get', `http://localhost:${ port }/p/${ base58Enc(nested) }?${ params }`)
            assert.equal((await sharp(control.body).metadata()).width, 100)

            initBlacklistService([], [], ['127.0.0.1'])
            try {
                const res = await needle('get', `http://localhost:${ port }/p/${ base58Enc(nested) }?${ params }`)
                let servedSource = false
                if (res.statusCode === 200 && Buffer.isBuffer(res.body) && res.body.length > 0) {
                    try {
                        const meta = await sharp(res.body).metadata()
                        servedSource = meta.width === 100 && meta.height === 67
                    } catch (_e) { servedSource = false }
                }
                assert.equal(servedSource, false,
                    'blocked nested source must not be served from the primed variant cache')
            } finally {
                initBlacklistService([], [], [])
            }
        })

        it('blocks sources wrapped by a public proxy host, cached and uncached', async function() {
            this.slow(3000)
            // The nested server stands in for a public proxy wrapper host (it is
            // NOT an internal service URL, so the handler never unwraps it) and
            // serves a real image for any path while its host stays unlisted
            const wrapper = `http://127.0.0.1:${ nestedPort }/0x0/http://blocked-nested.test/c.jpg`
            const params = 'width=100&mode=fit'

            // Prime while nothing is listed: variant cached under the wrapper's key
            const prime = await needle('get', `http://localhost:${ port }/p/${ base58Enc(wrapper) }?${ params }`)
            assert.equal((await sharp(prime.body).metadata()).width, 100)

            initBlacklistService([], [], ['blocked-nested.test'])
            try {
                const asSource = (res: any) => res.statusCode === 200 && Buffer.isBuffer(res.body) && res.body.length > 0
                    ? sharp(res.body).metadata().then((m) => m.width === 100 && m.height === 67).catch(() => false)
                    : Promise.resolve(false)

                // cached: the primed variant must not be served once the embedded source is listed
                const cached = await needle('get', `http://localhost:${ port }/p/${ base58Enc(wrapper) }?${ params }`)
                assert.equal(await asSource(cached), false,
                    'wrapper-cached variant of a blocked source must not be served')
                // blocked responses carry the fallback cache contract, not the 1y/600s proxy TTLs
                assert.equal(cached.headers['cache-control'], 'public,max-age=120')

                // uncached: a fresh wrapper URL must not be fetched at all
                const before = nestedHits
                const fresh = `http://127.0.0.1:${ nestedPort }/0x0/http://blocked-nested.test/d.jpg`
                const uncached = await needle('get', `http://localhost:${ port }/p/${ base58Enc(fresh) }?${ params }`)
                assert.equal(await asSource(uncached), false, 'fresh wrapper of a blocked source must not be served')
                assert.equal(nestedHits, before, 'wrapper host must not be contacted for a blocked source')
            } finally {
                initBlacklistService([], [], [])
            }
        })

        it('never follows a redirect to a blacklisted target, and abandons the mirror chain', async function() {
            this.slow(3000)
            this.timeout(10000)
            const log = {info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined}
            const defaultUrl = `http://localhost:${ port }/nonexistent-default.png`

            // Mock the public mirrors: they would receive the ALLOWED redirector
            // URL and follow the redirect to the blocked target themselves, so a
            // mirror answering 200 is exactly the bypass this test pins
            const utilsModule = require('./../src/utils')
            const realFetchUrl = utilsModule.fetchUrl
            let mirrorHits = 0
            utilsModule.fetchUrl = async (url: string, opts: any) => {
                if (/images\.hive\.blog|steemitimages\.com|img\.leopedia\.io|wsrv\.nl/.test(url)) {
                    mirrorHits++
                    return { statusCode: 200, headers: {}, body: fs.readFileSync(path.resolve(__dirname, 'test.png')) }
                }
                return realFetchUrl(url, opts)
            }
            try {
                // control: with nothing listed, the redirect is followed manually
                // and the target's bytes come back before any mirror is consulted
                const source = `http://localhost:${ redirectPort }/redirected-a.jpg`
                const before1 = nestedHits
                const control = await fetchImageWithFallbacks(source, base58Enc(source), 'test-agent', defaultUrl, log)
                assert.equal(control.isFallback, false)
                // the fetch layer returns the raw fixture bytes, unresized
                const fixture = await sharp(fs.readFileSync(path.resolve(__dirname, 'test.jpg'))).metadata()
                assert.equal((await sharp(control.res.body).metadata()).width, fixture.width)
                assert.equal(nestedHits, before1 + 1)
                assert.equal(mirrorHits, 0)

                // with the target's host listed, the redirect must not be followed
                // AND the remaining mirror candidates must not be consulted
                initBlacklistService([], [], ['127.0.0.1'])
                const before2 = nestedHits
                try {
                    const blocked = `http://localhost:${ redirectPort }/redirected-b.jpg`
                    await fetchImageWithFallbacks(blocked, base58Enc(blocked), 'test-agent', defaultUrl, log)
                } catch (_e) { /* expected: no fallback available */ } finally {
                    initBlacklistService([], [], [])
                }
                assert.equal(nestedHits, before2, 'redirect target must receive no requests')
                assert.equal(mirrorHits, 0, 'mirrors must not be handed a URL that redirects to a blocked target')
            } finally {
                utilsModule.fetchUrl = realFetchUrl
            }
        })

        it('fails closed on redirects at and beyond the hop limit', async function() {
            this.slow(3000)
            this.timeout(10000)
            const log = {info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined}
            const defaultUrl = `http://localhost:${ port }/nonexistent-default.png`

            // /boundary/<k>: five allowed self-redirects, then a redirect to the
            // blocked target exactly at the follower's hop limit
            // /endless/<k>: allowed self-redirects forever
            let chainPort = 0
            const chainServer = http.createServer((req, res) => {
                const m = (req.url || '').match(/^\/(boundary|endless)\/(\d+)/)
                const kind = m ? m[1] : 'endless'
                const k = m ? parseInt(m[2], 10) : 0
                // the blocked Location must arrive on the request made at
                // hop 5, the follower's limit: requests 1-5 are allowed hops
                const next = kind === 'boundary' && k >= 6
                    ? `http://127.0.0.1:${ nestedPort }/boundary-final.jpg`
                    : `http://localhost:${ chainPort }/${ kind }/${ k + 1 }`
                res.writeHead(302, { Location: next })
                res.end()
            })
            await new Promise<void>((resolve) => {
                chainServer.listen(0, 'localhost', () => {
                    chainPort = (chainServer.address() as any).port
                    resolve()
                })
            })

            const utilsModule = require('./../src/utils')
            const realFetchUrl = utilsModule.fetchUrl
            let mirrorHits = 0
            utilsModule.fetchUrl = async (url: string, opts: any) => {
                if (/images\.hive\.blog|steemitimages\.com|img\.leopedia\.io|wsrv\.nl/.test(url)) {
                    mirrorHits++
                    return { statusCode: 200, headers: {}, body: fs.readFileSync(path.resolve(__dirname, 'test.png')) }
                }
                return realFetchUrl(url, opts)
            }
            try {
                initBlacklistService([], [], ['127.0.0.1'])
                const before = nestedHits

                // blocked Location arriving exactly at the hop limit must still
                // be recognized as blocked, not returned unvalidated
                try {
                    const boundary = `http://localhost:${ chainPort }/boundary/1`
                    await fetchImageWithFallbacks(boundary, base58Enc(boundary), 'test-agent', defaultUrl, log)
                } catch (_e) { /* expected: no fallback available */ }
                assert.equal(nestedHits, before, 'boundary redirect target must receive no requests')
                assert.equal(mirrorHits, 0, 'mirrors must not be consulted after a boundary-blocked redirect')

                // an exhausted limit with a redirect still pending is unverified
                // territory: the chain must be abandoned, not handed to mirrors
                try {
                    const endless = `http://localhost:${ chainPort }/endless/1`
                    await fetchImageWithFallbacks(endless, base58Enc(endless), 'test-agent', defaultUrl, log)
                } catch (_e) { /* expected: no fallback available */ }
                assert.equal(mirrorHits, 0, 'mirrors must not be consulted after the redirect limit is exhausted')
            } finally {
                initBlacklistService([], [], [])
                utilsModule.fetchUrl = realFetchUrl
                await new Promise<void>((resolve) => { chainServer.close(() => resolve()) })
            }
        })

        it('abandons the mirror chain when a redirect targets a private address', async function() {
            this.slow(3000)
            this.timeout(10000)
            const log = {info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined}
            const defaultUrl = `http://localhost:${ port }/nonexistent-default.png`

            // Fully mocked, production-mode run: the private-target guard only
            // arms outside NODE_ENV=test, and assertPublicUrl is syntactic (no
            // DNS), so a fake public-looking redirector passes the candidate
            // pre-check and its redirect exposes the gap
            const utilsModule = require('./../src/utils')
            const realFetchUrl = utilsModule.fetchUrl
            let mirrorHits = 0
            let privateHits = 0
            utilsModule.fetchUrl = async (url: string, opts: any) => {
                if (/allowed-redirector\.example/.test(url)) {
                    return { statusCode: 302, headers: { location: 'http://127.0.0.1:1/private.jpg' }, body: Buffer.alloc(0) }
                }
                if (/127\.0\.0\.1:1\//.test(url)) {
                    privateHits++
                    return { statusCode: 200, headers: {}, body: fs.readFileSync(path.resolve(__dirname, 'test.jpg')) }
                }
                if (/images\.hive\.blog|steemitimages\.com|img\.leopedia\.io|wsrv\.nl/.test(url)) {
                    mirrorHits++
                    return { statusCode: 200, headers: {}, body: fs.readFileSync(path.resolve(__dirname, 'test.png')) }
                }
                return realFetchUrl(url, opts)
            }
            const realNodeEnv = process.env.NODE_ENV
            process.env.NODE_ENV = 'production'
            try {
                const source = 'http://allowed-redirector.example/one.jpg'
                await fetchImageWithFallbacks(source, base58Enc(source), 'test-agent', defaultUrl, log)
            } catch (_e) { /* expected: no fallback available */ } finally {
                process.env.NODE_ENV = realNodeEnv
                utilsModule.fetchUrl = realFetchUrl
            }
            assert.equal(privateHits, 0, 'private redirect target must receive no requests')
            assert.equal(mirrorHits, 0, 'mirrors must not be handed a URL that redirects to a private target')
        })

        it('never contacts a blacklisted source in the fallback fetch chain', async function() {
            this.slow(3000)
            const log = {info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined}
            const source = `http://127.0.0.1:${ nestedPort }/fetch-chain-test.jpg`
            initBlacklistService([], [], ['127.0.0.1'])
            const before = nestedHits
            try {
                // The default image is not stocked in the test stores, so the call
                // may throw after skipping the chain — only the hit count matters
                await fetchImageWithFallbacks(source, base58Enc(source), 'test-agent',
                    `http://localhost:${ port }/nonexistent-default.png`, log)
            } catch (_e) { /* expected: no fallback available */ } finally {
                initBlacklistService([], [], [])
            }
            assert.equal(nestedHits, before, 'blocked source must receive no requests')
        })
    })

})
