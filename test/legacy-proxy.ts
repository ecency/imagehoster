import 'mocha'
import assert from 'assert'
import * as http from 'http'
import needle from 'needle'
import * as path from 'path'
import * as fs from 'fs'
import sharp from 'sharp'

import {app} from './../src/app'

describe('legacy-proxy', function() {
    let port: number
    let imagePort: number
    const server = http.createServer(app.callback())

    const imageServer = http.createServer((req, res) => {
        fs.createReadStream(path.resolve(__dirname, 'test.jpg')).pipe(res)
    })

    before((done) => {
        server.listen(0, 'localhost', () => {
            port = (server.address() as any).port
            imageServer.listen(0, 'localhost', () => {
                imagePort = (imageServer.address() as any).port
                done()
            })
        })
    })
    after((done) => {
        server.close(() => imageServer.close(done))
    })

    it('should redirect with correct dimensions in URL', async function() {
        const res = await needle('get',
            `http://localhost:${port}/500x300/http://localhost:${imagePort}/test.jpg`,
            { follow_max: 0 })
        assert.equal(res.statusCode, 301)
        assert.equal(res.headers['cache-control'], 'public,max-age=86400', 'redirect should be cacheable')
        const location = res.headers['location']
        assert(location.startsWith('/p/'), 'should redirect to /p/ endpoint')
        assert(location.includes('width=500'), 'should include width')
        assert(location.includes('height=300'), 'should include height')
    })

    it('should handle 0x0 as passthrough (no resize)', async function() {
        const res = await needle('get',
            `http://localhost:${port}/0x0/http://localhost:${imagePort}/test.jpg`,
            { follow_max: 0 })
        assert.equal(res.statusCode, 301)
        const location = res.headers['location']
        assert(location.startsWith('/p/'), 'should redirect to /p/')
        // 0x0 means no width/height params
        assert(!location.includes('width='), 'should not include width for 0x0')
        assert(!location.includes('height='), 'should not include height for 0x0')
    })

    it('should handle width-only resize', async function() {
        const res = await needle('get',
            `http://localhost:${port}/500x0/http://localhost:${imagePort}/test.jpg`,
            { follow_max: 0 })
        assert.equal(res.statusCode, 301)
        const location = res.headers['location']
        assert(location.includes('width=500'), 'should include width')
        assert(!location.includes('height='), 'should not include height for 0')
    })

    it('should handle height-only resize', async function() {
        const res = await needle('get',
            `http://localhost:${port}/0x300/http://localhost:${imagePort}/test.jpg`,
            { follow_max: 0 })
        assert.equal(res.statusCode, 301)
        const location = res.headers['location']
        assert(!location.includes('width='), 'should not include width for 0')
        assert(location.includes('height=300'), 'should include height')
    })

    it('should follow redirect and serve resized image', async function() {
        this.slow(2000)
        this.timeout(10000)
        const res = await needle('get',
            `http://localhost:${port}/100x0/http://localhost:${imagePort}/test.jpg`,
            { follow_max: 2 })
        assert.equal(res.statusCode, 200)
        const meta = await sharp(res.body).metadata()
        assert.equal(meta.width, 100)
    })

    it('should redirect /webp/ legacy route', async function() {
        const res = await needle('get',
            `http://localhost:${port}/webp/100x100/http://localhost:${imagePort}/test.jpg`,
            { follow_max: 0 })
        assert.equal(res.statusCode, 301)
        assert.equal(res.headers['cache-control'], 'public,max-age=86400', 'redirect should be cacheable')
        const location = res.headers['location']
        // Should redirect to non-webp legacy URL
        assert(location.includes('/100x100/'), 'should redirect to legacy URL')
        assert(!location.includes('/webp/'), 'should not include /webp/')
    })
})
