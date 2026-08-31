import 'mocha'
import assert from 'assert'
import * as http from 'http'
import needle from 'needle'
import * as path from 'path'
import * as fs from 'fs'
import * as crypto from 'crypto'
import {PrivateKey} from '@ecency/sdk/hive'

import {app} from './../src/app'

import {APP_ACCOUNT, testKeys} from './index'

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


/**
 * Build a HiveSigner access token the way the client does: base64url of the
 * token object, where the signature covers sha256 of the canonical message.
 */
function makeHsToken(opts: {author: string, signer: any, app?: string, type?: string, timestamp?: number}) {
    const signedMessage = {type: opts.type || 'posting', app: opts.app || 'ecency.app'}
    const authors = [opts.author]
    const timestamp = opts.timestamp || 1700000000
    const message = JSON.stringify({signed_message: signedMessage, authors, timestamp})
    const hash = crypto.createHash('sha256').update(message).digest()
    const signature = opts.signer.sign(Buffer.from(hash)).toString()
    const tokenObj = {signed_message: signedMessage, authors, timestamp, signatures: [signature]}
    return Buffer.from(JSON.stringify(tokenObj))
        .toString('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '.')
}

/** Same token shape, but the signature is over unrelated bytes so it verifies against nothing. */
function makeHsTokenWithBogusSignature(author: string) {
    const signedMessage = {type: 'posting', app: 'ecency.app'}
    const authors = [author]
    const timestamp = 1700000000
    const bogusHash = crypto.createHash('sha256').update('not the token message').digest()
    const signature = testKeys.stranger.sign(Buffer.from(bogusHash)).toString()
    const tokenObj = {signed_message: signedMessage, authors, timestamp, signatures: [signature]}
    return Buffer.from(JSON.stringify(tokenObj))
        .toString('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '.')
}

async function uploadWithHsToken(data: Buffer, port: number, token: string) {
    return new Promise<any>((resolve, reject) => {
        const payload = {
            image_file: {filename: 'test.jpg', buffer: data, content_type: 'image/jpeg'},
        }
        needle.post(`:${ port }/hs/${ token }`, payload, {multipart: true}, (error, response, body) => {
            if (error) { reject(error) } else { resolve({response, body}) }
        })
    })
}

describe('hivesigner upload auth', function() {
    const port = 63207
    const server = http.createServer(app.callback())
    let data: Buffer

    before((done) => {
        data = fs.readFileSync(path.resolve(__dirname, 'test.jpg'))
        server.listen(port, 'localhost', done)
    })
    after((done) => { server.close(done) })

    it('rejects a token whose signature verifies against nothing, even when the account delegated to the app', async function() {
        // The regression this suite exists for. Finding app_account in
        // account_auths used to set validSignature directly, so any caller
        // naming a delegating account was accepted with an arbitrary signature.
        this.slow(1000)
        const token = makeHsTokenWithBogusSignature('hsdelegator')
        const {response} = await uploadWithHsToken(data, port, token)
        assert.equal(response.statusCode, 400)
    })

    it('accepts a token signed by the account own posting key', async function() {
        this.slow(1000)
        const token = makeHsToken({author: 'hsplain', signer: testKeys.bar})
        const {response} = await uploadWithHsToken(data, port, token)
        assert.equal(response.statusCode, 200)
    })

    it('accepts a token signed by the delegate app account key when the account delegated', async function() {
        this.slow(1000)
        const token = makeHsToken({author: 'hsdelegator', signer: testKeys.app})
        const {response} = await uploadWithHsToken(data, port, token)
        assert.equal(response.statusCode, 200)
    })

    it('rejects an app-signed token for an account that has NOT delegated to the app', async function() {
        this.slow(1000)
        const token = makeHsToken({author: 'hsplain', signer: testKeys.app})
        const {response} = await uploadWithHsToken(data, port, token)
        assert.equal(response.statusCode, 400)
    })

    it('rejects a token signed by a key held only under owner authority', async function() {
        this.slow(1000)
        const token = makeHsToken({author: 'hsowneronly', signer: testKeys.bar})
        const {response} = await uploadWithHsToken(data, port, token)
        assert.equal(response.statusCode, 400)
    })

    it('rejects a token signed by a key whose weight is below the authority threshold', async function() {
        this.slow(1000)
        const token = makeHsToken({author: 'hslowweight', signer: testKeys.bar})
        const {response} = await uploadWithHsToken(data, port, token)
        assert.equal(response.statusCode, 400)
    })

    it('rejects a token for an account that does not exist', async function() {
        this.slow(1000)
        const token = makeHsToken({author: 'nosuchaccount', signer: testKeys.bar})
        const {response} = await uploadWithHsToken(data, port, token)
        assert.equal(response.statusCode, 404)
    })

    it('keeps APP_ACCOUNT aligned with the delegation fixture', function() {
        assert.equal(APP_ACCOUNT, 'ecency.app')
    })
})
