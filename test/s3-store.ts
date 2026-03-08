import 'mocha'
import assert from 'assert'
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
                    store.set(`${bucket}/${key}`, Buffer.isBuffer(body) ? body : Buffer.from(body))
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
                    const body = new Readable({
                        read() {
                            this.push(Buffer.from('partial'))
                            this.push(null)
                            // Emit error after data is flushed
                            process.nextTick(() => this.destroy(new Error('S3 connection reset')))
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
