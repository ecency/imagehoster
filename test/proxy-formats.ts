import 'mocha'
import assert from 'assert'
import * as http from 'http'
import needle from 'needle'
import * as path from 'path'
import * as fs from 'fs'
import sharp from 'sharp'

import {app} from './../src/app'
import {base58Enc} from './../src/utils'

describe('proxy formats', function() {
    let port: number
    let imagePort: number
    const server = http.createServer(app.callback())

    let serveFile = 'test.jpg'
    const imageServer = http.createServer((req, res) => {
        const filePath = path.resolve(__dirname, serveFile)
        if (fs.existsSync(filePath)) {
            fs.createReadStream(filePath).pipe(res)
        } else {
            res.writeHead(404)
            res.end()
        }
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

    beforeEach(() => { serveFile = 'test.jpg' })

    it('should output WebP when requested', async function() {
        this.slow(2000)
        this.timeout(10000)
        const imageUrl = base58Enc(`http://localhost:${imagePort}/webp-test.jpg`)
        const res = await needle('get',
            `http://localhost:${port}/p/${imageUrl}?width=100&format=webp`)
        assert.equal(res.statusCode, 200)
        const meta = await sharp(res.body).metadata()
        assert.equal(meta.format, 'webp')
        assert.equal(meta.width, 100)
    })

    it('should output JPEG when requested', async function() {
        this.slow(2000)
        this.timeout(10000)
        const imageUrl = base58Enc(`http://localhost:${imagePort}/jpeg-test.jpg`)
        const res = await needle('get',
            `http://localhost:${port}/p/${imageUrl}?width=200&format=jpeg`)
        assert.equal(res.statusCode, 200)
        const meta = await sharp(res.body).metadata()
        assert.equal(meta.format, 'jpeg')
        assert.equal(meta.width, 200)
    })

    it('should output PNG when requested', async function() {
        this.slow(2000)
        this.timeout(10000)
        serveFile = 'test.png'
        const imageUrl = base58Enc(`http://localhost:${imagePort}/png-test.png`)
        const res = await needle('get',
            `http://localhost:${port}/p/${imageUrl}?width=50&format=png`)
        assert.equal(res.statusCode, 200)
        const meta = await sharp(res.body).metadata()
        assert.equal(meta.format, 'png')
        assert.equal(meta.width, 50)
    })

    it('should preserve format with mode=match', async function() {
        this.slow(2000)
        this.timeout(10000)
        const imageUrl = base58Enc(`http://localhost:${imagePort}/match-test.jpg`)
        const res = await needle('get',
            `http://localhost:${port}/p/${imageUrl}?width=100&format=match`)
        assert.equal(res.statusCode, 200)
        const meta = await sharp(res.body).metadata()
        assert.equal(meta.format, 'jpeg')
    })

    it('should handle cover scaling mode', async function() {
        this.slow(2000)
        this.timeout(10000)
        const imageUrl = base58Enc(`http://localhost:${imagePort}/cover-test.jpg`)
        const res = await needle('get',
            `http://localhost:${port}/p/${imageUrl}?width=100&height=100&mode=cover`)
        assert.equal(res.statusCode, 200)
        const meta = await sharp(res.body).metadata()
        assert.equal(meta.width, 100)
        assert.equal(meta.height, 100)
    })

    it('should handle fit scaling mode', async function() {
        this.slow(2000)
        this.timeout(10000)
        const imageUrl = base58Enc(`http://localhost:${imagePort}/fit-test.jpg`)
        const res = await needle('get',
            `http://localhost:${port}/p/${imageUrl}?width=100&height=100&mode=fit`)
        assert.equal(res.statusCode, 200)
        const meta = await sharp(res.body).metadata()
        // fit preserves aspect ratio, so one dimension may be smaller
        assert(meta.width! <= 100)
        assert(meta.height! <= 100)
    })

    it('should proxy without resizing at 0x0', async function() {
        this.slow(2000)
        this.timeout(10000)
        const imageUrl = base58Enc(`http://localhost:${imagePort}/passthrough.jpg`)
        const res = await needle('get',
            `http://localhost:${port}/p/${imageUrl}`)
        assert.equal(res.statusCode, 200)
        const meta = await sharp(res.body).metadata()
        assert.equal(meta.format, 'jpeg')
        // Original test.jpg is 1280x853
        assert.equal(meta.width, 1280)
    })

    it('should convert single-frame GIF to requested format', async function() {
        this.slow(2000)
        this.timeout(10000)
        serveFile = 'test.gif'
        const imageUrl = base58Enc(`http://localhost:${imagePort}/single-gif-test.gif`)
        const res = await needle('get',
            `http://localhost:${port}/p/${imageUrl}?width=25&format=webp`)
        assert.equal(res.statusCode, 200)
        const meta = await sharp(res.body).metadata()
        // Single-frame GIF is not animated, so format conversion applies
        assert.equal(meta.format, 'webp')
        assert.equal(meta.width, 25)
    })

    it('should set proper cache headers', async function() {
        this.slow(2000)
        this.timeout(10000)
        const imageUrl = base58Enc(`http://localhost:${imagePort}/cache-test.jpg`)
        const res = await needle('get',
            `http://localhost:${port}/p/${imageUrl}?width=100`)
        assert.equal(res.statusCode, 200)
        assert(res.headers['content-type'], 'should have content-type')
        assert(res.headers['cache-control'], 'should have cache-control')
    })

    it('should enforce max dimension limits', async function() {
        this.slow(2000)
        this.timeout(10000)
        const imageUrl = base58Enc(`http://localhost:${imagePort}/maxdim.jpg`)
        const res = await needle('get',
            `http://localhost:${port}/p/${imageUrl}?width=99999&height=99999`)
        assert.equal(res.statusCode, 200)
        const meta = await sharp(res.body).metadata()
        // Should be clamped to max custom limits (8000x8000), but source is only 1280x853
        assert(meta.width! <= 8000, 'width should be clamped')
        assert(meta.height! <= 8000, 'height should be clamped')
    })
})
