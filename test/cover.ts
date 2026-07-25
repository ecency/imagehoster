import 'mocha'
import assert from 'assert'
import * as http from 'http'
import needle from 'needle'
import sharp from 'sharp'

import {app} from './../src/app'
import {proxyStore} from './../src/common'
import {getImageKey, getUrlHashKey, OutputFormat, ScalingMode, storeExists} from './../src/utils'
import {BROKEN_COVER_URL} from './index'

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
        assert(first.headers['last-modified'], 'response should have last-modified')
    })
})
