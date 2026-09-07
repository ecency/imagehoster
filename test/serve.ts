import 'mocha'
import assert from 'assert'
import * as http from 'http'
import needle from 'needle'
import * as path from 'path'
import * as fs from 'fs'
import * as crypto from 'crypto'
import sharp from 'sharp'

import {app} from './../src/app'
import {errorMiddleware} from './../src/error'
import {serveHandler} from './../src/serve'
import {uploadImage} from './upload'

describe('serve', function() {
    let port: number
    const server = http.createServer(app.callback())

    before((done) => {
        server.listen(0, 'localhost', () => {
            port = (server.address() as any).port
            done()
        })
    })
    after((done) => { server.close(done) })

    it('should serve uploaded image by hash', async function() {
        this.slow(1000)
        const file = path.resolve(__dirname, 'test.jpg')
        const data = fs.readFileSync(file)
        const {body} = await uploadImage(data, port)
        const [key, fname] = body.url.split('/').slice(-2)

        const res = await needle('get', `http://localhost:${port}/${key}/${fname}`)
        assert.equal(res.statusCode, 200)
        assert(crypto.timingSafeEqual(res.body, data), 'served data should match uploaded')
    })

    it('answers 504 with no-store when the upload store stalls, instead of waiting or saying 404', async function() {
        this.slow(3000)
        this.timeout(10000)
        const {uploadStore} = require('./../src/common')
        const {PassThrough} = require('stream')
        const realCreate = uploadStore.createReadStream
        uploadStore.createReadStream = () => new PassThrough() // never ends
        const t0 = Date.now()
        try {
            const res = await needle('get', `http://localhost:${port}/DQmStalledStoreHash/photo.jpg`)
            const elapsed = Date.now() - t0
            assert.equal(res.statusCode, 504)
            assert.equal(res.headers['cache-control'], 'no-store, no-cache', 'a stall must not be cached like a 404 would be')
            assert.equal(res.headers['etag'], undefined)
            // serve allows three store budgets (900ms in the test config)
            assert(elapsed >= 800 && elapsed < 4000, `expected ~900ms, got ${ elapsed }ms`)
        } finally {
            uploadStore.createReadStream = realCreate
        }
    })

    it('should detect correct MIME type', async function() {
        this.slow(1000)
        const file = path.resolve(__dirname, 'test.jpg')
        const data = fs.readFileSync(file)
        const {body} = await uploadImage(data, port)
        const [key] = body.url.split('/').slice(-2)

        const res = await needle('get', `http://localhost:${port}/${key}/test.jpg`)
        assert.equal(res.statusCode, 200)
        assert.equal(res.headers['content-type'], 'image/jpeg')
    })

    it('should serve with immutable cache headers', async function() {
        this.slow(1000)
        const file = path.resolve(__dirname, 'test.jpg')
        const data = fs.readFileSync(file)
        const {body} = await uploadImage(data, port)
        const [key] = body.url.split('/').slice(-2)

        const res = await needle('get', `http://localhost:${port}/${key}/test.jpg`)
        assert(res.headers['cache-control'].includes('immutable'), 'should have immutable cache')
        assert(res.headers['cache-control'].includes('max-age=31536000'), 'should have 1-year max-age')
    })

    it('should serve PNG with correct MIME type', async function() {
        this.slow(1000)
        const pngData = fs.readFileSync(path.resolve(__dirname, 'test.png'))
        const {body} = await uploadImage(pngData, port)
        const [key] = body.url.split('/').slice(-2)

        const res = await needle('get', `http://localhost:${port}/${key}/test.png`)
        assert.equal(res.statusCode, 200)
        assert.equal(res.headers['content-type'], 'image/png')
    })

    it('should return 404 for non-existent hash', async function() {
        // This test makes external HTTP fallback calls, so needs generous timeout
        this.slow(5000)
        this.timeout(30000)
        const res = await needle('get', `http://localhost:${port}/DQmNonExistentHashThatDoesNotExistAnywhere12345/test.jpg`)
        assert.equal(res.statusCode, 404)
    })

    it('should reject non-GET methods', async function() {
        const ctx: any = {
            method: 'POST',
            params: { hash: 'DQmSomeHash', filename: 'test.jpg' },
            tag() {},
            set() {},
            remove() {},
            app: { emit() {} },
        }

        await errorMiddleware(ctx, () => serveHandler(ctx))

        assert.equal(ctx.status, 405)
        assert.equal(ctx.body.error.toJSON().name, 'invalid_method')
    })
})
