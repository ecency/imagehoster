import 'mocha'
import assert from 'assert'

import Koa from 'koa'
import * as http from 'http'
import needle from 'needle'

import {acceptBucket, makeCacheKeyTagGuard} from './../src/cache-key-tag'
import {supportsAvif, supportsWebP} from './../src/utils'

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

describe('edge Accept groups (scripts/cloudflare-accept-buckets.sh)', function() {
    // Mirror of the AVIF/WEBP rule expressions: a type counts only as a whole, bare
    // list item of the lower-cased header. Keep in step with the script.
    const bare = (accept: string, type: string) => {
        const a = accept.toLowerCase()
        return a === type || a.startsWith(type + ',') || a.includes(',' + type + ',') || a.endsWith(',' + type)
    }
    const edge = (a: string) => bare(a, 'image/avif') ? 'avif' : bare(a, 'image/webp') ? 'webp' : '0'

    // A cache HIT never reaches the origin guard, so a client must accept whatever its
    // group caches: AVIF for `avif`, WebP for `webp`. Landing lower than the origin
    // would choose is fine (the origin answers no-store on the miss)
    it('never files a client into a group whose cached format it does not accept', function() {
        for (const accept of [
            'ximage/avif,image/jpeg', 'image/jpeg,ximage/webp', 'image/avifx,image/jpeg',
            'image/avif;foo=bar;q=0,image/jpeg', 'image/avif;q=0,image/webp', 'image/webp;q=0,image/jpeg',
            'image/avif;q=0.5,image/webp', 'image/jpeg, image/avif', 'IMAGE/AVIF,*/*', '*/*', '',
        ]) {
            const group = edge(accept)
            const accepted = group === '0' || (group === 'avif' ? supportsAvif(accept) : supportsWebP(accept))
            assert.ok(accepted, `${accept}: filed under ${group}, which it does not accept`)
        }
    })

    it('keeps the groups real browsers send', function() {
        assert.equal(edge('image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'), 'avif') // Chrome
        assert.equal(edge('image/avif,image/webp,image/png,image/svg+xml,image/*;q=0.8,*/*;q=0.5'), 'avif') // Firefox
        assert.equal(edge('image/webp,image/avif,image/jxl,image/heic,image/heic-sequence,video/*;q=0.8,image/png,image/svg+xml,image/*;q=0.8,*/*;q=0.5'), 'avif') // Safari
        assert.equal(edge('image/webp,image/apng,image/*,*/*;q=0.8'), 'webp')
    })
})
