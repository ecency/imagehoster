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

import {app} from './../src/app'
import {fetchImageWithFallbacks} from './../src/fetch-image'
import {initBlacklistService} from './../src/blacklist-service'
import {proxyStore, uploadStore} from './../src/common'
import {MAX_CACHED_ORIGINAL_SIZE, SERVICE_BASE_URL} from './../src/constants'
import {shouldCacheOriginal} from './../src/proxy'
import {storeExists, storeWrite, base58Enc} from './../src/utils'

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
            this.slow(1000)
            const u = `http://localhost:${ port+2 }/ignorecache-test.jpg`
            const k = 'U' + multihash.toB58String(multihash.encode(
                createHash('sha1').update(u).digest(), 'sha1'
            ))
            await storeWrite(uploadStore, k, fs.readFileSync(path.resolve(__dirname, 'test.jpg')))
            const res = await needle('get', `http://localhost:${ port }/p/${ base58Enc(u) }?width=90&mode=fit&ignorecache=1`)
            const meta = await sharp(res.body).metadata()
            assert.equal(meta.width, 90)
            assert((await storeExists(uploadStore, k)) === true, 'archive object must survive ignorecache')
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
        const cacheable = {isDefaultImage: false, usesUploadStore: false, isLegacy: false}
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
            assert.equal(shouldCacheOriginal(1, {...cacheable, isDefaultImage: true}), false)
            assert.equal(shouldCacheOriginal(1, {...cacheable, usesUploadStore: true}), false)
            assert.equal(shouldCacheOriginal(1, {...cacheable, isLegacy: true}), false)
        })
    })

    describe('domain blacklist on nested proxy URLs', function() {
        // Bound to 127.0.0.1 explicitly so the nested source host is deterministic
        const nestedPort = port + 3
        let nestedHits = 0
        const nestedServer = http.createServer((req, res) => {
            nestedHits++
            fs.createReadStream(path.resolve(__dirname, 'test.jpg')).pipe(res)
        })
        before((done) => { nestedServer.listen(nestedPort, '127.0.0.1', done) })
        after((done) => { nestedServer.close(done) })

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
