import 'mocha'
import assert from 'assert'
import * as http from 'http'
import needle from 'needle'
import * as path from 'path'
import * as fs from 'fs'
import * as crypto from 'crypto'
import sharp from 'sharp'

import {app} from './../src/app'
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
        // POST to /:hash/:filename matches /:username/:signature (upload route)
        // so it returns an upload error, not 405
        const res = await needle('post', `http://localhost:${port}/DQmSomeHash/test.jpg`, {})
        assert(res.statusCode >= 400, 'should return error status')
    })
})
