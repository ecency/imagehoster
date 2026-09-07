import 'mocha'
import assert from 'assert'
import {s3RequestHandlerOptions} from './../src/constants'
import {HeadObjectCommand, S3Client} from '@aws-sdk/client-s3'
import * as http from 'http'
import { Readable } from 'stream'

import { S3BlobStore } from './../src/s3-store'
import { readStream } from './../src/utils'

/** Create a mock S3 client that stores data in memory. */
function createMockS3() {
    const store = new Map<string, Buffer>()

    return {
        store,
        send: async (command: any) => {
            const name = command.constructor.name
            const bucket = command.input.Bucket
            const key = command.input.Key

            switch (name) {
                case 'PutObjectCommand': {
                    const body = command.input.Body
                    if (Buffer.isBuffer(body)) {
                        store.set(`${bucket}/${key}`, body)
                    } else if (body && typeof body.pipe === 'function') {
                        // Stream body — collect chunks
                        const chunks: Buffer[] = []
                        await new Promise<void>((resolve, reject) => {
                            body.on('data', (chunk: Buffer) => chunks.push(chunk))
                            body.on('end', () => resolve())
                            body.on('error', reject)
                        })
                        store.set(`${bucket}/${key}`, Buffer.concat(chunks))
                    } else {
                        store.set(`${bucket}/${key}`, Buffer.from(body))
                    }
                    return {}
                }
                case 'GetObjectCommand': {
                    const data = store.get(`${bucket}/${key}`)
                    if (!data) {
                        const err: any = new Error('Not Found')
                        err.name = 'NotFound'
                        err.$metadata = { httpStatusCode: 404 }
                        throw err
                    }
                    const readable = new Readable()
                    readable.push(data)
                    readable.push(null)
                    return { Body: readable }
                }
                case 'HeadObjectCommand': {
                    if (!store.has(`${bucket}/${key}`)) {
                        const err: any = new Error('Not Found')
                        err.name = 'NotFound'
                        err.$metadata = { httpStatusCode: 404 }
                        throw err
                    }
                    return {}
                }
                case 'DeleteObjectCommand': {
                    store.delete(`${bucket}/${key}`)
                    return {}
                }
                default:
                    throw new Error(`Unexpected S3 command: ${name}`)
            }
        },
    }
}

describe('S3BlobStore', function() {
    let mockS3: ReturnType<typeof createMockS3>
    let blobStore: S3BlobStore

    beforeEach(() => {
        mockS3 = createMockS3()
        blobStore = new S3BlobStore({ client: mockS3 as any, bucket: 'test-bucket' })
    })

    describe('putBuffer', function() {
        it('should store buffer directly', async function() {
            await blobStore.putBuffer('mykey', Buffer.from('hello'))
            assert(mockS3.store.has('test-bucket/mykey'))
            assert.equal(mockS3.store.get('test-bucket/mykey')!.toString(), 'hello')
        })

        it('should store large buffers', async function() {
            const big = Buffer.alloc(1024 * 1024, 0xAB)
            await blobStore.putBuffer('bigkey', big)
            const stored = mockS3.store.get('test-bucket/bigkey')!
            assert.equal(stored.length, 1024 * 1024)
            assert(big.equals(stored))
        })
    })

    describe('createReadStream', function() {
        it('should read stored data as stream', async function() {
            mockS3.store.set('test-bucket/readkey', Buffer.from('stream data'))
            const stream = blobStore.createReadStream('readkey')
            const data = await readStream(stream)
            assert.equal(data.toString(), 'stream data')
        })

        it('should accept key as object', async function() {
            mockS3.store.set('test-bucket/objkey', Buffer.from('obj data'))
            const stream = blobStore.createReadStream({ key: 'objkey' })
            const data = await readStream(stream)
            assert.equal(data.toString(), 'obj data')
        })

        it('should emit error for non-existent key', async function() {
            const stream = blobStore.createReadStream('nonexistent')
            try {
                await readStream(stream)
                assert.fail('should have thrown')
            } catch (err: any) {
                assert.equal(err.name, 'NotFound')
            }
        })

        it('should propagate body stream errors', async function() {
            // Mock an S3 response where body stream errors mid-transfer
            const errorS3 = {
                send: async (command: any) => {
                    let pushed = false
                    const body = new Readable({
                        read() {
                            if (!pushed) {
                                pushed = true
                                this.push(Buffer.from('partial'))
                                // Destroy with error instead of ending — no push(null)
                                process.nextTick(() => this.destroy(new Error('S3 connection reset')))
                            }
                        }
                    })
                    return { Body: body }
                }
            }
            const errorStore = new S3BlobStore({ client: errorS3 as any, bucket: 'b' })
            const stream = errorStore.createReadStream('key')
            try {
                await readStream(stream)
                assert.fail('should have thrown')
            } catch (err: any) {
                assert.equal(err.message, 'S3 connection reset')
            }
        })
    })

    describe('client floors', function() {
        it('cuts off an accepted but stalled request with the configured handler options', async function() {
            this.timeout(5000)
            // An endpoint that accepts the connection and never answers. requestTimeout
            // alone only logs when it elapses; the options must make it throw.
            const endpoint = http.createServer((_req, _res) => undefined)
            await new Promise<void>((resolve) => endpoint.listen(0, '127.0.0.1', () => resolve()))
            const client = new S3Client({
                endpoint: `http://127.0.0.1:${ (endpoint.address() as any).port }`,
                region: 'us-east-1', credentials: {accessKeyId: 'test', secretAccessKey: 'test'},
                forcePathStyle: true, maxAttempts: 1,
                requestHandler: s3RequestHandlerOptions({connectionTimeout: 500, requestTimeout: 100}),
            })
            const t0 = Date.now()
            try {
                await assert.rejects(client.send(new HeadObjectCommand({Bucket: 'b', Key: 'k'})),
                    (err: any) => err.name === 'TimeoutError' || /timeout/i.test(err.message))
                assert(Date.now() - t0 < 3000, 'the stalled request must be cut off by the handler, not by anything outside it')
            } finally {
                client.destroy()
                endpoint.closeAllConnections()
                await new Promise<void>((resolve) => endpoint.close(() => resolve()))
            }
        })
    })

    describe('read stream after the consumer gave up', function() {
        it('does not pipe a late GET body into a destroyed stream', async function() {
            let bodyDestroyed = false
            let release: (v: any) => void = () => undefined
            const client: any = { send: () => new Promise((resolve) => { release = resolve }) }
            const store = new S3BlobStore({ client, bucket: 'b' })
            const rs = store.createReadStream({key: 'k'})
            let erred: any
            rs.on('error', (e) => { erred = e })
            rs.destroy() // consumer aborted (budget)
            const {Readable} = require('stream')
            const body = Readable.from([Buffer.from('late')])
            const origDestroy = body.destroy.bind(body)
            body.destroy = (...a: any[]) => { bodyDestroyed = true; return origDestroy(...a) }
            release({Body: body})
            await new Promise((r) => setTimeout(r, 20))
            assert.equal(bodyDestroyed, true, 'the late body must be released')
            assert.equal(erred, undefined, 'and nothing must be written into the destroyed stream')
        })
    })

    describe('abort signals', function() {
        it('forwards the signal to the SDK for exists, createReadStream and putBuffer', async function() {
            const calls: any[] = []
            const client: any = {
                send: async (command: any, options: any) => {
                    calls.push({name: command.constructor.name, options})
                    if (command.constructor.name === 'GetObjectCommand') {
                        const {Readable} = require('stream')
                        return {Body: Readable.from([Buffer.from('x')])}
                    }
                    return {}
                }
            }
            const store = new S3BlobStore({ client, bucket: 'b' })
            const signal = AbortSignal.timeout(5000)
            await new Promise<void>((resolve, reject) => store.exists({key: 'k', signal}, (err) => err ? reject(err) : resolve()))
            await new Promise<void>((resolve, reject) => {
                const rs = store.createReadStream({key: 'k', signal})
                rs.on('error', reject); rs.on('end', () => resolve()); rs.resume()
            })
            await store.putBuffer('k', Buffer.from('x'), signal)
            assert.equal(calls.length, 3)
            for (const c of calls) { assert.equal(c.options && c.options.abortSignal, signal, `${ c.name } must carry the abortSignal`) }
            // and nothing is passed when there is no signal
            await new Promise<void>((resolve, reject) => store.exists('plain', (err) => err ? reject(err) : resolve()))
            assert.equal(calls[3].options, undefined)
        })
    })

    describe('createWriteStream', function() {
        it('should write via stream with callback', function(done) {
            const ws = blobStore.createWriteStream('wskey', (err, meta) => {
                assert.ifError(err)
                assert.equal(meta.key, 'wskey')
                assert(mockS3.store.has('test-bucket/wskey'))
                assert.equal(mockS3.store.get('test-bucket/wskey')!.toString(), 'streamed')
                done()
            })
            ws.write('streamed')
            ws.end()
        })

        it('should only call done once on error', function(done) {
            let callCount = 0
            const errorS3 = {
                send: async () => { throw new Error('S3 write failed') }
            }
            const errorStore = new S3BlobStore({ client: errorS3 as any, bucket: 'b' })
            const ws = errorStore.createWriteStream('key', (err) => {
                callCount++
                assert(err)
                // Wait a tick to ensure no double callback
                setTimeout(() => {
                    assert.equal(callCount, 1, 'done should only be called once')
                    done()
                }, 50)
            })
            ws.write('data')
            ws.end()
        })
    })

    describe('exists', function() {
        it('should return true for existing key', function(done) {
            mockS3.store.set('test-bucket/existskey', Buffer.from('x'))
            blobStore.exists('existskey', (err, exists) => {
                assert.ifError(err)
                assert.equal(exists, true)
                done()
            })
        })

        it('should return false for non-existent key', function(done) {
            blobStore.exists('nope', (err, exists) => {
                assert.ifError(err)
                assert.equal(exists, false)
                done()
            })
        })

        it('should accept key as object', function(done) {
            mockS3.store.set('test-bucket/objexist', Buffer.from('x'))
            blobStore.exists({ key: 'objexist' }, (err, exists) => {
                assert.ifError(err)
                assert.equal(exists, true)
                done()
            })
        })
    })

    describe('remove', function() {
        it('should delete existing key', function(done) {
            mockS3.store.set('test-bucket/rmkey', Buffer.from('x'))
            blobStore.remove('rmkey', (err) => {
                assert.ifError(err)
                assert(!mockS3.store.has('test-bucket/rmkey'))
                done()
            })
        })
    })
})
