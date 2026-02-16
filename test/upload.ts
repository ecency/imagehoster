import 'mocha'
import * as assert from 'assert'
import * as http from 'http'
import * as needle from 'needle'
import * as path from 'path'
import * as fs from 'fs'
import * as crypto from 'crypto'
import {PrivateKey, cryptoUtils} from '@hiveio/dhive'

import {app} from './../src/app'
import {rpcClient} from './../src/common'

import {testKeys} from './index'

export async function uploadImage(data: Buffer, port: number) {
    return new Promise<any>((resolve, reject) => {
        // Compute the signature the same way the server does:
        // sha256('ImageSigningChallenge' + image_data)
        const imageHash = crypto.createHash('sha256')
            .update('ImageSigningChallenge')
            .update(data)
            .digest()

        const signature = testKeys.foo.sign(Buffer.from(imageHash)).toString()

        const payload = {
            foo: 'bar',
            image_file: {
                filename: 'test.jpg',
                buffer: data,
                content_type: 'image/jpeg',
            },
        }
        needle.post(`:${ port }/foo/${ signature }`, payload, {multipart: true}, function (error, response, body) {
            if (error) {
                reject(error)
            } else {
                resolve({response, body})
            }
        })
    })
}

describe('upload', function() {
    const port = 63205
    const server = http.createServer(app.callback())

    before((done) => { server.listen(port, 'localhost', done) })
    after((done) => { server.close(done) })

    it('should upload image', async function() {
        this.slow(500)
        const file = path.resolve(__dirname, 'test.jpg')
        const data = fs.readFileSync(file)
        const {response, body} = await uploadImage(data, port)
        assert.equal(response.statusCode, 200)
        const {url} = body
        const [key, fname] = url.split('/').slice(-2)
        assert.equal(key, 'DQmZi174Xz96UrRVBMNRHb6A2FfU3z1HRPwPPQCgSMgdiUT')
        assert.equal(fname, 'test.jpg')
        const res = await needle('get', `:${ port }/${ key }/bla.bla`)
        assert.equal(res.statusCode, 200)
        assert(crypto.timingSafeEqual(res.body, data), 'file same')
    })

    it('should reject invalid signature', async function() {
        this.slow(500)
        const file = path.resolve(__dirname, 'test.jpg')
        const data = fs.readFileSync(file)

        // Sign different data than what we upload
        const fakeHash = crypto.createHash('sha256')
            .update('ImageSigningChallenge')
            .update('this is not the image data')
            .digest()
        const badSignature = testKeys.foo.sign(Buffer.from(fakeHash)).toString()

        const payload = {
            image_file: {
                filename: 'test.jpg',
                buffer: data,
                content_type: 'image/jpeg',
            },
        }
        const res = await needle('post', `:${ port }/foo/${ badSignature }`, payload, {multipart: true})
        assert.equal(res.statusCode, 400)
        assert.equal(res.body.error.name, 'invalid_signature')
    })

    it('should reject non-existent account', async function() {
        this.slow(500)
        const file = path.resolve(__dirname, 'test.jpg')
        const data = fs.readFileSync(file)

        const imageHash = crypto.createHash('sha256')
            .update('ImageSigningChallenge')
            .update(data)
            .digest()
        const signature = testKeys.foo.sign(Buffer.from(imageHash)).toString()

        const payload = {
            image_file: {
                filename: 'test.jpg',
                buffer: data,
                content_type: 'image/jpeg',
            },
        }
        const res = await needle('post', `:${ port }/nonexistent/${ signature }`, payload, {multipart: true})
        assert.equal(res.statusCode, 404)
        assert.equal(res.body.error.name, 'no_such_account')
    })

    it('should reject legacy stndt signature bypass', async function() {
        this.slow(500)
        const file = path.resolve(__dirname, 'test.jpg')
        const data = fs.readFileSync(file)
        const payload = {
            image_file: {
                filename: 'test.jpg',
                buffer: data,
                content_type: 'image/jpeg',
            },
        }
        const res = await needle('post', `:${ port }/foo/stndt123456`, payload, {multipart: true})
        assert.equal(res.statusCode, 400)
        assert.equal(res.body.error.name, 'invalid_signature')
    })

})
