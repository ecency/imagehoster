import 'mocha'
import assert from 'assert'
import * as http from 'http'
import etag from 'etag'
import needle from 'needle'
import sharp from 'sharp'

import * as fs from 'fs'
import * as path from 'path'

import {app} from './../src/app'
import {initBlacklistService} from './../src/blacklist-service'
import {proxyStore} from './../src/common'
import {getImageKey, getUrlHashKey, OutputFormat, ScalingMode, storeExists} from './../src/utils'
import {realEtag} from './../src/served-image'
import {BROKEN_COVER_URL, mockProfiles, pointHealthyProfileAt} from './index'

describe('cover', function() {
    let port: number
    const server = http.createServer(app.callback())

    before((done) => {
        server.listen(0, 'localhost', () => {
            port = (server.address() as any).port
            done()
        })
    })
    after((done) => { server.close(done) })

    // A source that genuinely loads, for the tests that need a real image rather
    // than a placeholder: every fixture URL in mockProfiles points nowhere
    const imageServer = http.createServer((_req, res) => {
        fs.createReadStream(path.resolve(__dirname, 'test.jpg')).pipe(res)
    })
    before((done) => {
        imageServer.listen(0, 'localhost', () => {
            pointHealthyProfileAt(`http://localhost:${ (imageServer.address() as any).port }`)
            done()
        })
    })
    after((done) => { imageServer.close(done) })

    it('should serve cover for known user', async function() {
        this.slow(5000)
        this.timeout(30000)
        const res = await needle('get', `http://localhost:${port}/u/foo/cover`)
        assert.equal(res.statusCode, 200)
        assert(res.body.length > 0, 'body should not be empty')
        const meta = await sharp(res.body).metadata()
        // Cover uses fit mode at 1344x240, so width should be <= 1344
        assert(meta.width && meta.width <= 1344, 'cover width should be <= 1344')
    })

    it('should not persist fallback bytes under the user key', async function() {
        this.slow(5000)
        this.timeout(30000)
        const res = await needle('get', `http://localhost:${port}/u/brokenimages/cover`)
        assert.equal(res.statusCode, 200)
        // 120s freshness is how Varnish and CF identify a fallback render; it must
        // stay on the fallback response even though nothing is written to the store.
        assert.equal(res.headers['cache-control'], 'public,max-age=120')

        const origKey = getUrlHashKey(BROKEN_COVER_URL)
        const imageKey = getImageKey(origKey, {
            width: 1344, height: 240, mode: ScalingMode.Fit, format: OutputFormat.Match,
        } as any)
        assert((await storeExists(proxyStore, origKey)) === false,
            'default cover bytes were stored as the user original')
        assert((await storeExists(proxyStore, imageKey)) === false,
            'default cover bytes were stored as the user variant')
    })

    it('should reject short usernames', async function() {
        const res = await needle('get', `http://localhost:${port}/u/ab/cover`)
        assert.equal(res.statusCode, 404)
    })

    it('should reject invalid usernames', async function() {
        const res = await needle('get', `http://localhost:${port}/u/INVALID!/cover`)
        assert.equal(res.statusCode, 404)
    })

    it('should reject POST method', async function() {
        const res = await needle('post', `http://localhost:${port}/u/foo/cover`, {})
        assert(res.statusCode === 404 || res.statusCode === 405)
    })

    it('should set proper cache headers', async function() {
        this.slow(2000)
        this.timeout(10000)
        const res = await needle('get', `http://localhost:${port}/u/foo/cover`)
        assert.equal(res.statusCode, 200)
        assert(res.headers['cache-control'], 'should have cache-control')
        assert(res.headers['etag'], 'should have etag')
        assert(res.headers['content-type'], 'should have content-type')
    })

    it('should negotiate WebP via Accept header', async function() {
        this.slow(2000)
        this.timeout(10000)
        const res = await needle('get', `http://localhost:${port}/u/foo/cover`, {
            headers: { 'Accept': 'image/webp,*/*' }
        })
        assert.equal(res.statusCode, 200)
        const meta = await sharp(res.body).metadata()
        assert.equal(meta.format, 'webp')
    })

    it('should redirect /webp/ cover to non-webp URL', async function() {
        const res = await needle('get', `http://localhost:${port}/webp/u/foo/cover`, {
            follow_max: 0
        })
        assert.equal(res.statusCode, 302)
        assert(res.headers['location'].includes('/u/foo/cover'))
        assert(!res.headers['location'].includes('/webp/'))
    })

    it('should serve cached cover on second request', async function() {
        this.slow(2000)
        this.timeout(10000)
        await needle('get', `http://localhost:${port}/u/foo/cover`)
        const res = await needle('get', `http://localhost:${port}/u/foo/cover`)
        assert.equal(res.statusCode, 200)
        assert(res.body.length > 0)
    })

    it('should return ETag for caching', async function() {
        this.slow(2000)
        this.timeout(10000)
        const first = await needle('get', `http://localhost:${port}/u/foo/cover`)
        assert.equal(first.statusCode, 200)
        assert(first.headers['etag'], 'response should have etag')
        assert.equal(first.headers['last-modified'], undefined,
            'no Last-Modified: it carried the profile timestamp, which says nothing about the stored bytes')
    })

    it('answers 304 for conditional revalidation of a healthy cover', async function() {
        this.slow(3000)
        this.timeout(15000)
        const warm = await needle('get', `http://localhost:${port}/u/healthy/cover`)
        assert.equal(warm.statusCode, 200)
        assert.equal(warm.headers['cache-control'], 'public,max-age=3600', 'a real cover carries the real freshness')
        const inm = await needle('get', `http://localhost:${port}/u/healthy/cover`,
            null, { headers: { 'if-none-match': warm.headers.etag as string } })
        assert.equal(inm.statusCode, 304)
        // an If-Modified-Since-only revalidation is not honoured: the content
        // validator is the only thing that can vouch for the stored bytes
        const ims = await needle('get', `http://localhost:${port}/u/healthy/cover`,
            null, { headers: { 'if-modified-since': new Date().toUTCString() } })
        assert.equal(ims.statusCode, 200)
    })

    it('gives a placeholder its own ETag, so it never revalidates as the real cover', async function() {
        this.slow(5000)
        this.timeout(30000)
        // foo's cover points at a host that does not exist: the response is the
        // default standing in for it, and used to carry the real image's ETag
        const warm = await needle('get', `http://localhost:${port}/u/foo/cover`)
        assert.equal(warm.statusCode, 200)
        assert.equal(warm.headers['cache-control'], 'public,max-age=120')
        const realUrl = mockProfiles.foo.metadata.profile.cover_image
        const keys = [OutputFormat.Match, OutputFormat.WEBP, OutputFormat.AVIF].map((format) =>
            getImageKey(getUrlHashKey(realUrl), { width: 1344, height: 240, mode: ScalingMode.Fit, format } as any))
        const realEtags = keys.flatMap((k) => [etag(k), realEtag(k, warm.body, warm.body.length)])
        assert(!realEtags.includes(warm.headers.etag as string),
            'placeholder must not wear the ETag the real cover would have')
        // and a client presenting the placeholder ETag is not told it is current
        const inm = await needle('get', `http://localhost:${port}/u/foo/cover`,
            null, { headers: { 'if-none-match': warm.headers.etag as string } })
        assert.equal(inm.statusCode, 200)
        assert.equal(inm.headers.etag, warm.headers.etag, 'placeholder ETag is deterministic')
    })

    it('stops serving cached variants once the source domain is blacklisted', async function() {
        this.slow(5000)
        this.timeout(30000)
        let srcPort = 0
        let srcHits = 0
        const srcServer = http.createServer((req, res) => {
            srcHits++
            fs.createReadStream(path.resolve(__dirname, 'test.jpg')).pipe(res)
        })
        await new Promise<void>((resolve) => {
            srcServer.listen(0, '127.0.0.1', () => { srcPort = (srcServer.address() as any).port; resolve() })
        })
        mockProfiles.blockycover = {
            name: 'blockycover', active: '2024-01-01T00:00:00', created: '2016-01-01T00:00:00',
            id: 990, post_count: 1, reputation: 25, blacklists: [],
            stats: { followers: 0, following: 0, rank: 0 },
            metadata: { profile: { name: 'Blocky', cover_image: `http://127.0.0.1:${srcPort}/blocky.jpg` } },
        }
        try {
            // populate the original and rendered-variant caches
            const warm = await needle('get', `http://localhost:${port}/u/blockycover/cover`)
            assert.equal(warm.statusCode, 200)
            assert.equal(warm.headers['cache-control'], 'public,max-age=3600')
            assert(srcHits > 0, 'warm request must have fetched the source')
            const warmEtag = warm.headers.etag as string

            initBlacklistService([], [], ['127.0.0.1'])
            try {
                const hitsBefore = srcHits
                // conditional request against the cached ETag must not shortcut to 304
                const res = await needle('get', `http://localhost:${port}/u/blockycover/cover`,
                    null, { headers: { 'if-none-match': warmEtag } })
                assert.equal(res.statusCode, 200, 'must not answer 304 for the blocked source ETag')
                assert.equal(res.headers['cache-control'], 'public,max-age=120')
                assert(Buffer.isBuffer(res.body) && !warm.body.equals(res.body),
                    'cached source bytes must not be served')
                assert.equal(srcHits, hitsBefore, 'blocked source must not be re-fetched')

                // a date-only revalidation must not shortcut either
                const ims = await needle('get', `http://localhost:${port}/u/blockycover/cover`,
                    null, { headers: { 'if-modified-since': new Date().toUTCString() } })
                assert.equal(ims.statusCode, 200, 'must not answer 304 for If-Modified-Since revalidation')
                assert.equal(ims.headers['cache-control'], 'public,max-age=120')
            } finally {
                initBlacklistService([], [], [])
            }
        } finally {
            delete mockProfiles.blockycover
            await new Promise<void>((resolve) => { srcServer.close(() => resolve()) })
        }
    })
})
