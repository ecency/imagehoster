import 'mocha'
import assert from 'assert'
import * as http from 'http'
import {AddressInfo} from 'net'
import needle from 'needle'
import sharp from 'sharp'

import {app} from './../src/app'
import {initBlacklistService} from './../src/blacklist-service'
import {clearDeadUrl, markDeadUrl} from './../src/fetch-image'
import {base58Enc} from './../src/utils'
import {
    acceptableFormats, clientKeyFor, EXTRA_KINDS, hasEdgeToken, memberFor, memoryLedger, parseMember, pickFallback,
    testLedger, variantKind, variantQuery,
} from './../src/variant-guard'

const AVIF_WEBP = 'image/avif,image/webp,image/apng,*/*;q=0.8'
const WEBP_ONLY = 'image/webp,*/*;q=0.8'
const AVIF_ONLY = 'image/avif'
const LEGACY_ONLY = 'image/png,image/*;q=0.8'

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
        })
        it('has no key without a valid address', function() {
            assert.strictEqual(clientKeyFor(undefined), undefined)
            assert.strictEqual(clientKeyFor(''), undefined)
            assert.strictEqual(clientKeyFor('not-an-ip'), undefined)
            assert.strictEqual(clientKeyFor('1.2.3.4, 5.6.7.8'), undefined)
        })
    })

    describe('edge token', function() {
        it('trusts every request when no token is configured', function() {
            assert.strictEqual(hasEdgeToken(undefined, ''), true)
        })
        it('trusts the client address only with the exact token', function() {
            assert.strictEqual(hasEdgeToken(undefined, 's3cret'), false)
            assert.strictEqual(hasEdgeToken('', 's3cret'), false)
            assert.strictEqual(hasEdgeToken('s3cre', 's3cret'), false)
            assert.strictEqual(hasEdgeToken('s3cret!', 's3cret'), false)
            assert.strictEqual(hasEdgeToken('s3cret', 's3cret'), true)
        })
    })

    describe('variant identity', function() {
        it('round-trips a member, and kinds ignore width', function() {
            const v = {format: 'avif', mode: 'fit', width: 1280, height: undefined}
            assert.strictEqual(variantQuery(v), 'format=avif&mode=fit&width=1280')
            assert.deepStrictEqual(parseMember(memberFor(v)), v)
            assert.strictEqual(variantKind(v), variantKind({...v, width: 320}))
            assert.notStrictEqual(variantKind(v), variantKind({...v, format: 'webp'}))
            assert.notStrictEqual(variantKind(v), variantKind({...v, height: 400}))
        })
    })

    describe('fallback choice', function() {
        const m = (format: string, width: number, mode = 'fit', height?: number) => memberFor({format, mode, width, height})
        const want = (format: string, width: number, mode = 'fit', height?: number) => ({format, mode, width, height})

        it('picks the nearest width, larger on a tie', function() {
            const members = [m('webp', 320), m('webp', 1024), m('webp', 600)]
            assert.strictEqual(pickFallback(members, want('webp', 800), WEBP_ONLY), 'format=webp&mode=fit&width=600')
            assert.strictEqual(pickFallback([m('webp', 600), m('webp', 1000)], want('webp', 800), WEBP_ONLY),
                'format=webp&mode=fit&width=1000')
        })
        it('only redirects to a format the Accept header takes', function() {
            assert.deepStrictEqual([...acceptableFormats('avif', AVIF_ONLY)].sort(), ['avif'])
            assert.deepStrictEqual([...acceptableFormats('avif', AVIF_WEBP)].sort(), ['avif', 'webp'])
            assert.strictEqual(pickFallback([m('webp', 600)], want('avif', 600), AVIF_ONLY), undefined)
            assert.strictEqual(pickFallback([m('webp', 600)], want('avif', 600), AVIF_WEBP), 'format=webp&mode=fit&width=600')
            assert.strictEqual(pickFallback([m('avif', 600)], want('webp', 600), WEBP_ONLY), undefined)
        })
        it('uses match only for a client that negotiated match itself', function() {
            assert.strictEqual(pickFallback([m('match', 600)], want('webp', 600), AVIF_WEBP), undefined)
            assert.strictEqual(pickFallback([m('match', 600)], want('match', 800), LEGACY_ONLY), 'format=match&mode=fit&width=600')
            assert.strictEqual(pickFallback([m('webp', 600)], want('match', 800), LEGACY_ONLY), undefined)
        })
        it('never changes the crop: mode and height must match', function() {
            assert.strictEqual(pickFallback([m('webp', 600, 'cover')], want('webp', 600), WEBP_ONLY), undefined)
            assert.strictEqual(pickFallback([m('webp', 600, 'cover', 400)], want('webp', 600, 'cover'), WEBP_ONLY), undefined)
            assert.strictEqual(pickFallback([m('webp', 600, 'cover', 400)], want('webp', 300, 'cover', 400), WEBP_ONLY),
                'format=webp&mode=cover&width=600&height=400')
        })
    })

    describe('memory ledger', function() {
        it('reserves up to the limit, then one per new kind up to the hard cap', async function() {
            const l = memoryLedger(() => 1000)
            const r = (member: string, kind: string) => l.reserve('k', member, kind, 2, 3, 60)
            assert.strictEqual(await r('a#1', 'a'), 'added')
            assert.strictEqual(await r('a#2', 'a'), 'added')
            assert.strictEqual(await r('a#1', 'a'), 'held', 'a slot already held is not counted again')
            assert.deepStrictEqual(await r('a#3', 'a'), ['a#1', 'a#2'], 'same kind past the limit is refused')
            assert.strictEqual(await r('b#1', 'b'), 'added', 'a new kind gets one more')
            assert.deepStrictEqual((await r('c#1', 'c') as string[]).sort(), ['a#1', 'a#2', 'b#1'], 'hard cap reached')
        })
        it('gives a released slot back', async function() {
            const l = memoryLedger(() => 1000)
            await l.reserve('k', 'a#1', 'a', 1, 1, 60)
            assert.ok(Array.isArray(await l.reserve('k', 'a#2', 'a', 1, 1, 60)))
            await l.release('k', 'a#1')
            assert.strictEqual(await l.reserve('k', 'a#2', 'a', 1, 1, 60), 'added')
        })
        it('expires with the window and sweeps clients that never came back', async function() {
            let now = 1000
            const l = memoryLedger(() => now)
            await l.reserve('k', 'a#1', 'a', 1, 1, 60)
            now += 61000
            assert.strictEqual(await l.reserve('k', 'a#2', 'a', 1, 1, 60), 'added', 'the window expired')
            for (let i = 0; i < 997; i++) { await l.reserve(`one-off-${i}`, 'a#1', 'a', 1, 1, 60) }
            now += 61000
            await l.reserve('last', 'a#1', 'a', 1, 1, 60) // the 1000th write sweeps
            assert.strictEqual(l.size(), 1, 'expired one-off entries are swept')
        })
    })

    describe('through the proxy', function() {
        const server = http.createServer(app.callback())
        let source: Buffer
        let serveSource = true
        const imageServer = http.createServer((_req, res) => {
            if (!serveSource) { res.writeHead(404); res.end(); return }
            res.writeHead(200, {'content-type': 'image/jpeg'})
            res.end(source)
        })
        let port = 0
        let imagePort = 0
        let n = 0
        // a fresh source per test, so no test sees variants another one rendered
        const newSource = (host = 'localhost') => `http://${host}:${imagePort}/img-${Date.now()}-${n++}.jpg`
        const url = (src: string, query: string) => `http://localhost:${port}/p/${base58Enc(src)}?${query}`
        const get = (u: string, headers: {[k: string]: string} = {}) =>
            needle('get', u, null, {follow_max: 0, headers: {'cf-connecting-ip': '198.51.100.20', 'accept': AVIF_WEBP, ...headers}})
        const variant = (format: string, width: number) => `format=${format}&mode=fit&width=${width}`

        before(async function() {
            source = await sharp({create: {width: 1600, height: 1000, channels: 3, background: {r: 200, g: 120, b: 40}}})
                .jpeg().toBuffer()
            await new Promise<void>((resolve) => server.listen(0, 'localhost', resolve))
            await new Promise<void>((resolve) => imageServer.listen(0, 'localhost', resolve))
            port = (server.address() as AddressInfo).port
            imagePort = (imageServer.address() as AddressInfo).port
        })
        after((done) => { server.close(() => imageServer.close(done)) })
        beforeEach(() => { testLedger.clear(); serveSource = true })

        it('renders the first four variants, then redirects a new one to the nearest stored one', async function() {
            const src = newSource()
            for (const w of [320, 600, 800, 1024]) {
                assert.strictEqual((await get(url(src, variant('webp', w)))).statusCode, 200, `width ${w}`)
            }
            const res = await get(url(src, variant('webp', 1280)))
            assert.strictEqual(res.statusCode, 302)
            assert.strictEqual(res.headers['location'], `/p/${base58Enc(src)}?${variant('webp', 1024)}`)
            assert.strictEqual(res.headers['cache-control'], 'no-store')
            assert.strictEqual(res.headers['x-variant-guard'], 'redirect')
            assert.strictEqual(res.headers['etag'], undefined)
            assert.strictEqual(res.headers['vary'], undefined)

            const target = await get(`http://localhost:${port}${res.headers['location']}`)
            assert.strictEqual(target.statusCode, 200)
            assert.match(String(target.headers['cache-control']), /immutable/, 'the target is a stored variant')
        })

        it('counts what is rendered: varying Accept on one query cannot exceed the cap', async function() {
            const src = newSource()
            let renders = 0
            for (const accept of [AVIF_WEBP, WEBP_ONLY, LEGACY_ONLY]) {
                for (const w of [320, 600, 800, 1024]) {
                    const res = await get(url(src, variant('match', w)), {accept})
                    if (res.statusCode === 200) {
                        renders++
                        continue
                    }
                    assert.strictEqual(res.statusCode, 302, `${accept} width ${w}`)
                    // the target names an explicit format this client takes, or match for a
                    // client that negotiates match itself, and it is stored for this client
                    const target = await get(`http://localhost:${port}${res.headers['location']}`, {accept})
                    assert.strictEqual(target.statusCode, 200)
                    assert.match(String(target.headers['cache-control']), /immutable/)
                }
            }
            assert.strictEqual(renders, 4 + EXTRA_KINDS)
        })

        it('gives a reader who filled the allowance one render of a new kind (post image after feed)', async function() {
            const src = newSource()
            for (const w of [320, 600, 800, 1024]) {
                assert.strictEqual((await get(url(src, variant('webp', w)))).statusCode, 200)
            }
            // the post body asks for AVIF, a format this reader has not had yet
            const post = await get(url(src, variant('avif', 1280)))
            assert.strictEqual(post.statusCode, 200)
            assert.match(String(post.headers['content-type']), /avif/)
        })

        it('answers 429, uncacheable, rather than sending an AVIF-only client WebP', async function() {
            const src = newSource()
            for (const w of [320, 600, 800, 1024]) {
                assert.strictEqual((await get(url(src, variant('webp', w)))).statusCode, 200)
            }
            assert.strictEqual((await get(url(src, variant('jpeg', 600)))).statusCode, 200)
            assert.strictEqual((await get(url(src, variant('png', 600)))).statusCode, 200)
            const res = await get(url(src, variant('avif', 600)), {accept: AVIF_ONLY})
            assert.strictEqual(res.statusCode, 429)
            assert.strictEqual(res.headers['cache-control'], 'no-store')
            assert.strictEqual(res.headers['retry-after'], '120')
            assert.strictEqual(res.headers['x-variant-guard'], 'reject')
        })

        it('never counts or limits a stored variant, even one another client rendered', async function() {
            const src = newSource()
            const other = {'cf-connecting-ip': '198.51.100.99'}
            for (const w of [320, 600, 800, 1024]) {
                assert.strictEqual((await get(url(src, variant('webp', w)), other)).statusCode, 200)
            }
            for (const w of [320, 600, 800, 1024, 320, 600]) {
                assert.strictEqual((await get(url(src, variant('webp', w)))).statusCode, 200, `stored ${w}`)
            }
            assert.strictEqual((await get(url(src, variant('webp', 1280)))).statusCode, 200)
        })

        it('counts each client separately', async function() {
            const src = newSource()
            for (const w of [320, 600, 800, 1024]) {
                assert.strictEqual((await get(url(src, variant('webp', w)))).statusCode, 200)
            }
            assert.strictEqual((await get(url(src, variant('webp', 1280)), {'cf-connecting-ip': '198.51.100.21'})).statusCode, 200)
        })

        it('gives the slot back when nothing was stored, so a recovered source renders normally', async function() {
            this.timeout(20000)
            const src = newSource()
            await markDeadUrl(src)
            try {
                for (const w of [100, 200, 300, 400, 500, 700, 900]) {
                    const res = await get(url(src, variant('webp', w)))
                    assert.ok(res.statusCode !== 302 && res.statusCode !== 429, `dead source width ${w}: ${res.statusCode}`)
                }
            } finally {
                await clearDeadUrl(src)
            }
            for (const w of [320, 600, 800, 1024]) {
                assert.strictEqual((await get(url(src, variant('webp', w)))).statusCode, 200, `recovered ${w}`)
            }
        })

        it('never redirects a legacy-route request (its renders are not stored)', async function() {
            const src = newSource()
            for (const w of [320, 600, 800, 1024]) {
                assert.strictEqual((await get(url(src, `${variant('webp', w)}&_src=legacy`))).statusCode, 200)
            }
            const res = await get(url(src, `${variant('webp', 1280)}&_src=legacy`))
            assert.strictEqual(res.statusCode, 429)
            assert.strictEqual(res.headers['cache-control'], 'no-store')
        })

        it('does not apply to a blocked source answered with the default image', async function() {
            this.timeout(20000)
            const src = newSource('127.0.0.1')
            initBlacklistService([], [], ['127.0.0.1'])
            try {
                // in parallel, as a scraper sends them: every request is in flight before
                // any of them could give a slot back
                const widths = [100, 200, 300, 400, 500, 700, 900]
                const responses = await Promise.all(widths.map((w) => get(url(src, variant('webp', w)))))
                responses.forEach((res, i) => {
                    assert.ok(res.statusCode !== 302 && res.statusCode !== 429, `blocked width ${widths[i]}: ${res.statusCode}`)
                })
            } finally {
                initBlacklistService([], [], [])
            }
        })

        it('does not apply without a client address (direct origin)', async function() {
            const src = newSource()
            for (const w of [100, 200, 300, 400, 500, 700, 900]) {
                const res = await needle('get', url(src, variant('webp', w)), null, {follow_max: 0, headers: {accept: AVIF_WEBP}})
                assert.strictEqual(res.statusCode, 200, `width ${w}`)
            }
        })

        it('sends a crawler an image too: a redirect to a stored variant, never an error', async function() {
            const src = newSource()
            const googlebot = {'user-agent': 'Googlebot-Image/1.0'}
            for (const w of [320, 600, 800, 1024]) {
                assert.strictEqual((await get(url(src, variant('webp', w)), googlebot)).statusCode, 200)
            }
            const res = await get(url(src, variant('webp', 1280)), googlebot)
            assert.strictEqual(res.statusCode, 302)
        })

        it('does not count blur placeholders', async function() {
            const src = newSource()
            for (const w of [320, 600, 800, 1024]) {
                assert.strictEqual((await get(url(src, variant('webp', w)))).statusCode, 200)
            }
            assert.strictEqual((await get(url(src, `${variant('webp', 64)}&blur=1`))).statusCode, 200)
        })
    })
})
