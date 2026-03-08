import 'mocha'
import assert from 'assert'
import * as http from 'http'
import needle from 'needle'
import * as path from 'path'
import * as fs from 'fs'
import sharp from 'sharp'

import {app} from './../src/app'

describe('cover', function() {
    let port: number
    let imagePort: number
    const server = http.createServer(app.callback())

    const imageServer = http.createServer((req, res) => {
        fs.createReadStream(path.resolve(__dirname, 'test.jpg')).pipe(res)
    })

    before((done) => {
        server.listen(0, 'localhost', () => {
            port = (server.address() as any).port
            done()
        })
    })
    before((done) => {
        imageServer.listen(0, 'localhost', () => {
            imagePort = (imageServer.address() as any).port
            done()
        })
    })
    after((done) => { server.close(done) })
    after((done) => { imageServer.close(done) })

    it('should serve cover for known user', async function() {
        this.slow(2000)
        this.timeout(10000)
        const res = await needle('get', `http://localhost:${port}/u/foo/cover`)
        assert.equal(res.statusCode, 200)
        assert(res.body.length > 0, 'body should not be empty')
        const meta = await sharp(res.body).metadata()
        // Cover uses fit mode at 1344x240, so width should be <= 1344
        assert(meta.width && meta.width <= 1344, 'cover width should be <= 1344')
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
