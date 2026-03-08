import 'mocha'
import assert from 'assert'

import {uploadStore, proxyStore} from './../src/common'
import {storeExists, storeWrite, readStream} from './../src/utils'

describe('blob store', function() {

    it('should write and read back data', async function() {
        const key = `test-write-${Date.now()}`
        const data = Buffer.from('hello world')
        await storeWrite(uploadStore, key, data)

        const exists = await storeExists(uploadStore, key)
        assert.equal(exists, true)

        const read = await readStream(uploadStore.createReadStream(key))
        assert(Buffer.isBuffer(read))
        assert.equal(read.toString(), 'hello world')
    })

    it('should report non-existent keys', async function() {
        const exists = await storeExists(uploadStore, `nonexistent-${Date.now()}`)
        assert.equal(exists, false)
    })

    it('should write string data', async function() {
        const key = `test-string-${Date.now()}`
        await storeWrite(proxyStore, key, 'string data')

        const read = await readStream(proxyStore.createReadStream(key))
        assert.equal(read.toString(), 'string data')
    })

    it('should write binary data correctly', async function() {
        const key = `test-binary-${Date.now()}`
        const data = Buffer.alloc(1024)
        for (let i = 0; i < data.length; i++) {
            data[i] = i % 256
        }
        await storeWrite(uploadStore, key, data)

        const read = await readStream(uploadStore.createReadStream(key))
        assert(data.equals(read), 'binary data should roundtrip exactly')
    })

    it('should overwrite existing key', async function() {
        const key = `test-overwrite-${Date.now()}`
        await storeWrite(uploadStore, key, Buffer.from('first'))
        await storeWrite(uploadStore, key, Buffer.from('second'))

        const read = await readStream(uploadStore.createReadStream(key))
        assert.equal(read.toString(), 'second')
    })

    it('should work with proxy store independently', async function() {
        const key = `test-proxy-${Date.now()}`
        const data = Buffer.from('proxy data')
        await storeWrite(proxyStore, key, data)

        // Should exist in proxy store
        assert.equal(await storeExists(proxyStore, key), true)
        // Should NOT exist in upload store
        assert.equal(await storeExists(uploadStore, key), false)
    })
})
