import 'mocha'
import assert from 'assert'
import * as http from 'http'
import needle from 'needle'
import * as path from 'path'
import * as fs from 'fs'
import sharp from 'sharp'

import {app} from './../src/app'

describe('avatar', function() {
    const port = 63205
    const server = http.createServer(app.callback())
    const imagePort = port + 1

    // Serve test.jpg as avatar image
    const imageServer = http.createServer((req, res) => {
        fs.createReadStream(path.resolve(__dirname, 'test.jpg')).pipe(res)
    })

    before((done) => { server.listen(port, 'localhost', done) })
    before((done) => { imageServer.listen(imagePort, 'localhost', done) })
    after((done) => { server.close(done) })
    after((done) => { imageServer.close(done) })

    it('should serve avatar for known user', async function() {
        this.slow(2000)
        this.timeout(10000)
        const res = await needle('get', `http://localhost:${port}/u/foo/avatar`)
        assert.equal(res.statusCode, 200)
        assert(res.body.length > 0, 'body should not be empty')
        const meta = await sharp(res.body).metadata()
        assert(meta.width && meta.width <= 256, 'avatar width should be <= 256')
        assert(meta.height && meta.height <= 256, 'avatar height should be <= 256')
    })

    it('should serve avatar with size parameter', async function() {
        this.slow(2000)
        this.timeout(10000)
        const res = await needle('get', `http://localhost:${port}/u/foo/avatar/64`)
        assert.equal(res.statusCode, 200)
        const meta = await sharp(res.body).metadata()
        assert.equal(meta.width, 64)
        assert.equal(meta.height, 64)
    })

    it('should reject short usernames', async function() {
        const res = await needle('get', `http://localhost:${port}/u/ab/avatar`)
        assert.equal(res.statusCode, 404)
    })

    it('should reject invalid usernames', async function() {
        const res = await needle('get', `http://localhost:${port}/u/INVALID_USER!/avatar`)
        assert.equal(res.statusCode, 404)
    })

    it('should reject POST method', async function() {
        const res = await needle('post', `http://localhost:${port}/u/foo/avatar`, {})
        // POST to a GET-only route hits the 404 catch-all
        assert(res.statusCode === 404 || res.statusCode === 405)
    })

    it('should set cache headers', async function() {
        this.slow(2000)
        this.timeout(10000)
        const res = await needle('get', `http://localhost:${port}/u/foo/avatar`)
        assert.equal(res.statusCode, 200)
        assert(res.headers['cache-control'], 'should have cache-control header')
        assert(res.headers['etag'], 'should have etag header')
        assert(res.headers['vary'], 'should have vary header')
        assert(res.headers['content-type'], 'should have content-type header')
    })

    it('should negotiate WebP via Accept header', async function() {
        this.slow(2000)
        this.timeout(10000)
        const res = await needle('get', `http://localhost:${port}/u/foo/avatar`, {
            headers: { 'Accept': 'image/webp,image/png,*/*' }
        })
        assert.equal(res.statusCode, 200)
        const meta = await sharp(res.body).metadata()
        assert.equal(meta.format, 'webp')
    })

    it('should redirect /webp/ avatar to non-webp URL', async function() {
        const res = await needle('get', `http://localhost:${port}/webp/u/foo/avatar/small`, {
            follow_max: 0
        })
        assert.equal(res.statusCode, 302)
        assert(res.headers['location'].includes('/u/foo/avatar/small'))
        assert(!res.headers['location'].includes('/webp/'))
    })

    it('should serve cached avatar on second request', async function() {
        this.slow(2000)
        this.timeout(10000)
        // First request populates cache
        await needle('get', `http://localhost:${port}/u/foo/avatar/64`)
        // Second request should serve from cache
        const res = await needle('get', `http://localhost:${port}/u/foo/avatar/64`)
        assert.equal(res.statusCode, 200)
        const meta = await sharp(res.body).metadata()
        assert.equal(meta.width, 64)
    })

    it('should return ETag for caching', async function() {
        this.slow(2000)
        this.timeout(10000)
        const first = await needle('get', `http://localhost:${port}/u/foo/avatar`)
        assert.equal(first.statusCode, 200)
        assert(first.headers['etag'], 'response should have etag')
        assert(first.headers['last-modified'], 'response should have last-modified')
    })
})
