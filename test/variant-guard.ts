import 'mocha'
import assert from 'assert'
import * as http from 'http'
import needle from 'needle'
import sharp from 'sharp'

import {app} from './../src/app'
import {base58Enc} from './../src/utils'
import {
    clientKeyFor, memoryLedger, parseVariantQuery, pickFallback, requestedVariantOf, testLedger, variantQuery,
} from './../src/variant-guard'

describe('variant guard', function() {

    describe('client key', function() {
        it('keys IPv4 by address', function() {
            assert.strictEqual(clientKeyFor('203.0.113.7'), '203.0.113.7')
            assert.strictEqual(clientKeyFor(' 203.0.113.7 '), '203.0.113.7')
        })
        it('keys IPv6 by /64, whatever the spelling', function() {
            const a = clientKeyFor('2001:db8:1:2:aaaa:bbbb:cccc:dddd')
            assert.strictEqual(a, '2001:db8:1:2::/64')
            assert.strictEqual(clientKeyFor('2001:0db8:0001:0002::1'), a)
            assert.strictEqual(clientKeyFor('2001:db8:1:2::'), a)
            assert.strictEqual(clientKeyFor('2001:db8::1'), '2001:db8:0:0::/64')
            assert.strictEqual(clientKeyFor('::ffff:192.0.2.1'), '0:0:0:0::/64')
        })
        it('has no key without a valid address (direct origin, garbage header)', function() {
            assert.strictEqual(clientKeyFor(undefined), undefined)
            assert.strictEqual(clientKeyFor(''), undefined)
            assert.strictEqual(clientKeyFor('not-an-ip'), undefined)
            assert.strictEqual(clientKeyFor('1.2.3.4, 5.6.7.8'), undefined)
        })
    })

    describe('requested variant', function() {
        it('normalises the way the proxy reads the query', function() {
            assert.deepStrictEqual(requestedVariantOf({}), {format: 'match', mode: 'cover', width: undefined, height: undefined})
            assert.deepStrictEqual(requestedVariantOf({format: 'jpg', mode: 'fit', width: '600'}),
                {format: 'jpeg', mode: 'fit', width: 600, height: undefined})
            assert.deepStrictEqual(requestedVariantOf({format: 'bogus', width: '0'}),
                {format: 'match', mode: 'cover', width: undefined, height: undefined})
        })
        it('round-trips through the canonical query, in frontend order', function() {
            const v = {format: 'avif', mode: 'fit', width: 1280, height: undefined}
            assert.strictEqual(variantQuery(v), 'format=avif&mode=fit&width=1280')
            assert.deepStrictEqual(parseVariantQuery(variantQuery(v)), v)
        })
    })

    describe('fallback choice', function() {
        const q = (format: string, width: number, mode = 'fit') => variantQuery({format, mode, width})
        it('picks the nearest width of the same format, larger on a tie', function() {
            const members = [q('webp', 320), q('webp', 1024), q('webp', 600)]
            assert.strictEqual(pickFallback(members, {format: 'webp', mode: 'fit', width: 800}), q('webp', 600))
            assert.strictEqual(pickFallback([q('webp', 600), q('webp', 1000)], {format: 'webp', mode: 'fit', width: 800}), q('webp', 1000))
        })
        it('gives an AVIF client WebP, never AVIF to a WebP client', function() {
            assert.strictEqual(pickFallback([q('webp', 600)], {format: 'avif', mode: 'fit', width: 600}), q('webp', 600))
            assert.strictEqual(pickFallback([q('avif', 600)], {format: 'webp', mode: 'fit', width: 600}), undefined)
        })
        it('never mixes match with an explicit format (the CDN does not key on Accept)', function() {
            assert.strictEqual(pickFallback([q('match', 600)], {format: 'webp', mode: 'fit', width: 600}), undefined)
            assert.strictEqual(pickFallback([q('webp', 600)], {format: 'match', mode: 'fit', width: 600}), undefined)
        })
        it('never changes the crop: mode and height must match', function() {
            assert.strictEqual(pickFallback([q('webp', 600, 'cover')], {format: 'webp', mode: 'fit', width: 600}), undefined)
            const withHeight = variantQuery({format: 'webp', mode: 'cover', width: 600, height: 400})
            assert.strictEqual(pickFallback([withHeight], {format: 'webp', mode: 'cover', width: 600}), undefined)
            assert.strictEqual(pickFallback([withHeight], {format: 'webp', mode: 'cover', width: 300, height: 400}), withHeight)
        })
    })

    describe('memory ledger', function() {
        it('allows up to the cap, never counts a repeat, expires with the window', async function() {
            let now = 1000
            const l = memoryLedger(() => now)
            assert.strictEqual(await l.record('k', 'a', 2, 60), null)
            assert.strictEqual(await l.record('k', 'b', 2, 60), null)
            assert.strictEqual(await l.record('k', 'a', 2, 60), null, 'a repeat is not a new variant')
            assert.deepStrictEqual((await l.record('k', 'c', 2, 60))!.sort(), ['a', 'b'])
            assert.strictEqual(await l.record('other', 'c', 2, 60), null, 'keys are independent')
            now += 61000
            assert.strictEqual(await l.record('k', 'c', 2, 60), null, 'the window expired')
        })
    })

    describe('through the proxy', function() {
        const port = 63261
        const server = http.createServer(app.callback())
        let source: Buffer
        const imageServer = http.createServer((_req, res) => {
            res.writeHead(200, {'content-type': 'image/jpeg'})
            res.end(source)
        })
        let n = 0
        // a fresh source per test, so no test sees variants another one rendered
        const newSource = () => `http://localhost:${port + 1}/img-${Date.now()}-${n++}.jpg`
        const url = (src: string, query: string) => `http://localhost:${port}/p/${base58Enc(src)}?${query}`
        const get = (u: string, headers: {[k: string]: string} = {}) =>
            needle('get', u, null, {follow_max: 0, headers: {'cf-connecting-ip': '198.51.100.20', ...headers}})
        const variant = (format: string, width: number) => `format=${format}&mode=fit&width=${width}`

        before(async function() {
            source = await sharp({create: {width: 1600, height: 1000, channels: 3, background: {r: 200, g: 120, b: 40}}})
                .jpeg().toBuffer()
            await new Promise<void>((resolve) => server.listen(port, 'localhost', resolve))
            await new Promise<void>((resolve) => imageServer.listen(port + 1, 'localhost', resolve))
        })
        after((done) => { server.close(() => imageServer.close(done)) })
        beforeEach(() => testLedger.clear())

        it('renders the first four variants, then redirects a new one to the nearest rendered one', async function() {
            const src = newSource()
            for (const w of [320, 600, 800, 1024]) {
                const res = await get(url(src, variant('webp', w)))
                assert.strictEqual(res.statusCode, 200, `width ${w}`)
            }
            const res = await get(url(src, variant('webp', 1280)))
            assert.strictEqual(res.statusCode, 302)
            assert.strictEqual(res.headers['location'], `/p/${base58Enc(src)}?${variant('webp', 1024)}`)
            assert.strictEqual(res.headers['cache-control'], 'no-store')
            assert.strictEqual(res.headers['x-variant-guard'], 'redirect')
            assert.strictEqual(res.headers['etag'], undefined)

            // the redirect target is a stored variant: a cache hit, served normally
            const target = await get(`http://localhost:${port}${res.headers['location']}`)
            assert.strictEqual(target.statusCode, 200)
            assert.match(String(target.headers['cache-control']), /immutable/)
        })

        it('answers 429, uncacheable, when nothing rendered fits the client', async function() {
            const src = newSource()
            for (const w of [320, 600, 800, 1024]) {
                assert.strictEqual((await get(url(src, variant('avif', w)))).statusCode, 200)
            }
            // a WebP-only client cannot be sent to AVIF
            const res = await get(url(src, variant('webp', 600)))
            assert.strictEqual(res.statusCode, 429)
            assert.strictEqual(res.headers['cache-control'], 'no-store')
            assert.strictEqual(res.headers['retry-after'], '120')
            assert.strictEqual(res.headers['x-variant-guard'], 'reject')
        })

        it('never counts or limits a cached variant, even one another client rendered', async function() {
            const src = newSource()
            const other = {'cf-connecting-ip': '198.51.100.99'}
            for (const w of [320, 600, 800, 1024]) {
                assert.strictEqual((await get(url(src, variant('webp', w)), other)).statusCode, 200)
            }
            // this client reads all four from the store, then renders one new one
            for (const w of [320, 600, 800, 1024, 320, 600]) {
                assert.strictEqual((await get(url(src, variant('webp', w)))).statusCode, 200, `cached ${w}`)
            }
            assert.strictEqual((await get(url(src, variant('webp', 1280)))).statusCode, 200)
        })

        it('counts each client separately', async function() {
            const src = newSource()
            for (const w of [320, 600, 800, 1024]) {
                assert.strictEqual((await get(url(src, variant('webp', w)))).statusCode, 200)
            }
            const res = await get(url(src, variant('webp', 1280)), {'cf-connecting-ip': '198.51.100.21'})
            assert.strictEqual(res.statusCode, 200)
        })

        it('does not apply without a trusted client address (direct origin)', async function() {
            const src = newSource()
            for (const w of [100, 200, 300, 400, 500, 700]) {
                const res = await needle('get', url(src, variant('webp', w)), null, {follow_max: 0})
                assert.strictEqual(res.statusCode, 200, `width ${w}`)
            }
        })

        it('does not apply to search crawlers', async function() {
            const src = newSource()
            const googlebot = {'user-agent': 'Mozilla/5.0 (compatible; Googlebot-Image/1.0; +http://www.google.com/bot.html)'}
            for (const w of [100, 200, 300, 400, 500, 700]) {
                assert.strictEqual((await get(url(src, variant('webp', w)), googlebot)).statusCode, 200, `width ${w}`)
            }
        })

        it('does not count blur placeholders', async function() {
            const src = newSource()
            for (const w of [320, 600, 800, 1024]) {
                assert.strictEqual((await get(url(src, variant('webp', w)))).statusCode, 200)
            }
            const res = await get(url(src, `${variant('webp', 64)}&blur=1`))
            assert.strictEqual(res.statusCode, 200)
        })
    })
})
