import 'mocha'
import assert from 'assert'
import * as http from 'http'
import {AddressInfo} from 'net'
import needle from 'needle'
import sharp from 'sharp'

import {app} from './../src/app'
import {encodeLimitStats, isEncodeShed, MAX_QUEUED_ENCODES, withEncodeSlot} from './../src/encode-limit'
import {canServeUnresized} from './../src/proxy'
import {BUSY_CACHE_CONTROL} from './../src/served-image'
import {base58Enc} from './../src/utils'

const deferred = () => {
    let release!: () => void
    const promise = new Promise<void>((resolve) => { release = resolve })
    return {promise, release}
}
const tick = () => new Promise((resolve) => setImmediate(resolve))

/** Occupy every slot and `queued` queue places, so the next opted-in encode is refused. */
async function fillEncoder(queued: number) {
    const {limit} = encodeLimitStats()
    const gates = Array.from({length: limit + queued}, deferred)
    const tasks = gates.map((g) => withEncodeSlot(async () => { await g.promise }))
    await tick()
    assert.strictEqual(encodeLimitStats().active, limit)
    assert.strictEqual(encodeLimitStats().queued, queued)
    return async () => {
        for (const g of gates) { g.release(); await tick() }
        await Promise.all(tasks)
    }
}

describe('encode queue limit', function() {

    describe('limiter', function() {
        it('refuses an opted-in encode at once when the queue is full, and queues the others', async function() {
            const drain = await fillEncoder(2)
            try {
                let ran = false
                await assert.rejects(withEncodeSlot(async () => { ran = true }, undefined, {shedAt: 2}), (err: any) => isEncodeShed(err))
                assert.strictEqual(ran, false, 'nothing runs for a refused encode')
                assert.strictEqual(encodeLimitStats().queued, 2, 'a refused encode takes no queue place')
                // without the opt-in the same call queues as before
                const queuedAnyway = withEncodeSlot(async () => 'ok')
                await tick()
                assert.strictEqual(encodeLimitStats().queued, 3)
                await drain()
                assert.strictEqual(await queuedAnyway, 'ok')
            } finally {
                await drain()
            }
            assert.strictEqual(encodeLimitStats().active, 0)
            assert.strictEqual(encodeLimitStats().queued, 0)
        })

        it('takes a free slot or a short queue as usual', async function() {
            assert.strictEqual(await withEncodeSlot(async () => 'free', undefined, {shedAt: 0}), 'free')
            const drain = await fillEncoder(0)
            const queued = withEncodeSlot(async () => 'queued', undefined, {shedAt: 1})
            await tick()
            assert.strictEqual(encodeLimitStats().queued, 1)
            await drain()
            assert.strictEqual(await queued, 'queued')
        })
    })

    describe('which originals may stand in', function() {
        it('only small JPEG, PNG or GIF: decodable by every client sharing the cached answer', function() {
            assert.strictEqual(canServeUnresized('image/jpeg', 50000, 1000000), true)
            assert.strictEqual(canServeUnresized('image/png', 50000, 1000000), true)
            assert.strictEqual(canServeUnresized('image/gif', 50000, 1000000), true)
            assert.strictEqual(canServeUnresized('image/jpeg', 1000001, 1000000), false, 'too large')
            assert.strictEqual(canServeUnresized('image/jpeg', 0, 1000000), false, 'empty')
            assert.strictEqual(canServeUnresized('image/webp', 1000, 1000000), false, 'not every client decodes WebP')
            assert.strictEqual(canServeUnresized('image/avif', 1000, 1000000), false, 'not every client decodes AVIF')
            assert.strictEqual(canServeUnresized('image/heif', 1000, 1000000), false)
            assert.strictEqual(canServeUnresized('image/svg+xml', 1000, 1000000), false)
        })
    })

    describe('through the proxy', function() {
        const server = http.createServer(app.callback())
        let jpeg: Buffer
        let avif: Buffer
        const imageServer = http.createServer((req, res) => {
            const isAvif = (req.url || '').includes('.avif')
            res.writeHead(200, {'content-type': isAvif ? 'image/avif' : 'image/jpeg'})
            res.end(isAvif ? avif : jpeg)
        })
        let port = 0
        let imagePort = 0
        let n = 0
        const newSource = (ext: string) => `http://localhost:${imagePort}/busy-${Date.now()}-${n++}.${ext}`
        const url = (src: string, query: string) => `http://localhost:${port}/p/${base58Enc(src)}?${query}`
        const get = (u: string, accept: string) => needle('get', u, null, {follow_max: 0, headers: {accept}})

        before(async function() {
            const base = sharp({create: {width: 1600, height: 1000, channels: 3, background: {r: 30, g: 140, b: 90}}})
            jpeg = await base.clone().jpeg().toBuffer()
            avif = await base.clone().avif({quality: 40, effort: 0}).toBuffer()
            await new Promise<void>((resolve) => server.listen(0, 'localhost', resolve))
            await new Promise<void>((resolve) => imageServer.listen(0, 'localhost', resolve))
            port = (server.address() as AddressInfo).port
            imagePort = (imageServer.address() as AddressInfo).port
        })
        after((done) => { server.close(() => imageServer.close(done)) })

        it('serves the original unresized, cached for a minute, when the queue is full; renders once it drains', async function() {
            this.timeout(20000)
            const src = newSource('jpg')
            const variant = url(src, 'format=webp&mode=fit&width=600')
            // the original has to be at hand: fetch it once at a size that bypasses the queue
            assert.strictEqual((await get(url(src, 'format=webp&mode=fit&width=100'), 'image/webp,*/*')).statusCode, 200)

            const drain = await fillEncoder(MAX_QUEUED_ENCODES)
            let busy: any
            try {
                busy = await get(variant, 'image/webp,*/*')
            } finally {
                await drain()
            }
            assert.strictEqual(busy.statusCode, 200)
            assert.strictEqual(busy.headers['cache-control'], BUSY_CACHE_CONTROL)
            assert.strictEqual(busy.headers['content-type'], 'image/jpeg')
            assert.ok(Buffer.compare(busy.body, jpeg) === 0, 'the original bytes, unresized')

            // not stored under the variant key: the next request renders the real variant
            const real = await get(variant, 'image/webp,*/*')
            assert.strictEqual(real.statusCode, 200)
            assert.match(String(real.headers['cache-control']), /immutable/)
            assert.strictEqual(real.headers['content-type'], 'image/webp')
            assert.strictEqual((await sharp(real.body).metadata()).width, 600)
        })

        it('gives every client the same answer for a URL, whatever its Accept (the CDN shares it)', async function() {
            this.timeout(20000)
            const src = newSource('jpg')
            const variant = url(src, 'format=avif&mode=fit&width=600')
            assert.strictEqual((await get(url(src, 'format=jpeg&mode=fit&width=100'), 'image/avif,image/webp,*/*')).statusCode, 200)
            const drain = await fillEncoder(MAX_QUEUED_ENCODES)
            const answers: any[] = []
            try {
                for (const accept of ['image/avif,image/webp,*/*', 'image/png,image/*;q=0.8', '']) {
                    answers.push(await get(variant, accept))
                }
            } finally {
                await drain()
            }
            for (const a of answers) {
                assert.strictEqual(a.statusCode, 200)
                assert.strictEqual(a.headers['content-type'], 'image/jpeg')
                assert.strictEqual(a.headers['cache-control'], BUSY_CACHE_CONTROL)
                assert.strictEqual(a.headers['etag'], answers[0].headers['etag'])
            }
        })

        it('answers 503, uncacheable, for an original that not every client decodes, even to one that does', async function() {
            this.timeout(20000)
            const src = newSource('avif')
            assert.strictEqual((await get(url(src, 'format=jpeg&mode=fit&width=100'), 'image/avif,*/*')).statusCode, 200)
            const drain = await fillEncoder(MAX_QUEUED_ENCODES)
            let busy: any
            try {
                busy = await get(url(src, 'format=jpeg&mode=fit&width=600'), 'image/avif,image/webp,*/*')
            } finally {
                await drain()
            }
            assert.strictEqual(busy.statusCode, 503)
            assert.strictEqual(busy.headers['cache-control'], 'no-store')
            assert.strictEqual(busy.headers['retry-after'], '30')
            assert.strictEqual(busy.headers['etag'], undefined)
        })
    })
})
