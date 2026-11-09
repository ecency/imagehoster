import 'mocha'
import assert from 'assert'
import * as http from 'http'
import {AddressInfo} from 'net'
import needle from 'needle'
import sharp from 'sharp'

import {app} from './../src/app'
import {base58Enc} from './../src/utils'

describe('blur placeholder when the render fails', function() {
    const server = http.createServer(app.callback())
    let source: Buffer
    const imageServer = http.createServer((_req, res) => {
        res.writeHead(200, {'content-type': 'image/jpeg'})
        res.end(source)
    })
    let port = 0
    let imagePort = 0
    const url = (name: string, query: string) =>
        `http://localhost:${port}/p/${base58Enc(`http://localhost:${imagePort}/${name}-${Date.now()}.jpg`)}?${query}`
    const get = (u: string) => needle('get', u, null, {follow_max: 0, headers: {accept: 'image/avif,image/webp,*/*'}})

    before(async function() {
        source = await sharp({create: {width: 1600, height: 1000, channels: 3, background: {r: 10, g: 90, b: 160}}})
            .jpeg().toBuffer()
        await new Promise<void>((resolve) => server.listen(0, 'localhost', resolve))
        await new Promise<void>((resolve) => imageServer.listen(0, 'localhost', resolve))
        port = (server.address() as AddressInfo).port
        imagePort = (imageServer.address() as AddressInfo).port
    })
    after((done) => { server.close(() => imageServer.close(done)) })

    it('answers a tiny uncacheable placeholder, never the original, and a retry renders the real one', async function() {
        this.timeout(20000)
        const u = url('blur-fail', 'blur=1&format=match&mode=fit')
        const proto = sharp.prototype as unknown as {toBuffer: () => Promise<Buffer>}
        const realToBuffer = proto.toBuffer
        proto.toBuffer = () => Promise.reject(new Error('libvips exploded'))
        let res: any
        try {
            res = await get(u)
        } finally {
            proto.toBuffer = realToBuffer
        }
        assert.strictEqual(res.statusCode, 200)
        assert.ok(res.body.length < 100, `a placeholder, not the ${source.length} byte original (got ${res.body.length})`)
        assert.notStrictEqual(Buffer.compare(res.body, source), 0)
        // Varnish caches ?blur= URLs for 24h unless told no-cache; the CDN must not keep it either
        assert.match(String(res.headers['cache-control']), /no-cache/)
        assert.match(String(res.headers['cache-control']), /no-store/)
        assert.strictEqual(res.headers['etag'], undefined)

        // not stored under the blur key: the next request renders the real placeholder
        const real = await get(u)
        assert.strictEqual(real.statusCode, 200)
        assert.strictEqual(real.headers['content-type'], 'image/jpeg')
        assert.strictEqual((await sharp(real.body).metadata()).width, 20)
    })

    it('still serves the original for a normal variant whose render fails', async function() {
        this.timeout(20000)
        const proto = sharp.prototype as unknown as {toBuffer: () => Promise<Buffer>}
        const realToBuffer = proto.toBuffer
        proto.toBuffer = () => Promise.reject(new Error('libvips exploded'))
        let res: any
        try {
            res = await get(url('variant-fail', 'format=webp&mode=fit&width=300'))
        } finally {
            proto.toBuffer = realToBuffer
        }
        assert.strictEqual(res.statusCode, 200)
        assert.strictEqual(Buffer.compare(res.body, source), 0, 'browsers are lenient: the original goes out')
    })
})
