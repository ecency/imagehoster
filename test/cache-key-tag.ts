import 'mocha'
import assert from 'assert'

import Koa from 'koa'
import * as http from 'http'
import needle from 'needle'

import {acceptBucket, makeCacheKeyTagGuard} from './../src/cache-key-tag'

describe('acceptBucket', function() {
    it('files each Accept the way the origin negotiates it', function() {
        assert.equal(acceptBucket('image/avif,image/webp,image/apng,*/*;q=0.8'), 'avif')
        assert.equal(acceptBucket('image/webp,image/apng,image/*,*/*;q=0.8'), 'webp')
        assert.equal(acceptBucket('image/jpeg,image/png,image/*;q=0.8'), '0')
        assert.equal(acceptBucket('*/*'), '0')
        assert.equal(acceptBucket(''), '0')
    })

    it('reads media types case-insensitively and honours q=0', function() {
        assert.equal(acceptBucket('IMAGE/AVIF,*/*'), 'avif')
        assert.equal(acceptBucket('image/avif;q=0,image/webp'), 'webp')
        assert.equal(acceptBucket('image/avif;q=0,image/webp;q=0,*/*'), '0')
    })
})

describe('cache-key tag guard behind the CDN', function() {
    // A negotiated request that reached us through the CDN without a tag means an
    // edge rule missed it (a query shape the rewrite skipped), so every client
    // would share one key: never let that be cached. Redirects are exempt (the
    // `amp;` 301 is meant to be cached), and so is anything not from the CDN.
    let port: number
    let status = 200
    const app = new Koa()
    app.use(makeCacheKeyTagGuard('secret') as any)
    app.use((ctx) => {
        ctx.status = status
        ctx.set('Cache-Control', 'public,max-age=31536000,immutable')
        if (status === 301) { ctx.set('Location', '/p/x?format=match') }
        ctx.type = 'image/jpeg'
        ctx.body = 'x'
    })
    const server = http.createServer(app.callback())
    before((done) => { server.listen(0, 'localhost', () => { port = (server.address() as any).port; done() }) })
    after((done) => { server.close(done) })
    beforeEach(() => { status = 200 })
    const get = (path: string, headers: any = {}) => needle('get', `http://localhost:${port}${path}`, null, {headers, follow_max: 0})

    it('answers no-store for an untagged negotiated request that came through the CDN', async function() {
        for (const path of ['/p/x?format=match', '/p/x?format=%6datch', '/p/x?foo=format=jpeg', '/p/x?format=jpeg&format=match', '/u/a/avatar']) {
            const res = await get(path, {'x-edge-token': 'secret'})
            assert.equal(res.headers['cache-control'], 'no-store', path)
        }
    })

    it('leaves untagged requests alone off the CDN, for explicit formats and for redirects', async function() {
        assert.match(String((await get('/p/x?format=match')).headers['cache-control']), /immutable/)
        assert.match(String((await get('/p/x?format=match', {'x-edge-token': 'wrong'})).headers['cache-control']), /immutable/)
        assert.match(String((await get('/p/x?format=webp', {'x-edge-token': 'secret'})).headers['cache-control']), /immutable/)
        status = 301
        assert.match(String((await get('/p/x?format=match&amp;width=1', {'x-edge-token': 'secret'})).headers['cache-control']), /immutable/)
    })

    it('keeps a matching tag cacheable behind the CDN', async function() {
        const res = await get('/p/x?format=match&_acc=0', {'x-edge-token': 'secret', accept: 'image/jpeg'})
        assert.match(String(res.headers['cache-control']), /immutable/)
    })
})
