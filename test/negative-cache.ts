import 'mocha'
import assert from 'assert'
import * as fs from 'fs'
import * as http from 'http'
import * as path from 'path'

import {clearNegativeFetchCache, fetchImageWithFallbacks, isKnownDeadUrl, markDeadUrl, peekDeadUrlTtl} from './../src/fetch-image'
import {base58Enc} from './../src/utils'

describe('negative fetch cache', function() {
    this.timeout(20000)

    const log: any = {debug() {}, info() {}, warn() {}, error() {}}

    let port: number
    let originHits = 0
    let flakyAlive = false
    // /default* serves a real image (stands in for the configured default);
    // /flaky* serves one only while flakyAlive is set; /gone* answers 404, a
    // terminal "not here"; every other path counts the hit and fails with a 500,
    // standing in for an origin that is merely having a bad moment
    const server = http.createServer((req, res) => {
        if (req.url && (req.url.startsWith('/default') || (req.url.startsWith('/flaky') && flakyAlive))) {
            fs.createReadStream(path.resolve(__dirname, 'test.jpg')).pipe(res)
        } else if (req.url && req.url.startsWith('/gone')) {
            originHits++
            res.writeHead(404)
            res.end()
        } else {
            originHits++
            res.writeHead(500)
            res.end()
        }
    })

    before((done) => {
        server.listen(0, 'localhost', () => {
            port = (server.address() as any).port
            done()
        })
    })
    after((done) => { server.close(done) })
    beforeEach(() => { clearNegativeFetchCache() })

    // Exclude the public mirrors so tests never leave localhost
    const externalMirrors = (urlString: string, urlParams: string) => [
        `https://images.hive.blog/p/${ urlParams }`,
        `https://steemitimages.com/p/${ urlParams }`,
        `https://images.hive.blog/0x0/${ urlString }`,
        `https://steemitimages.com/0x0/${ urlString }`,
        `https://img.leopedia.io/0x0/${ urlString }`,
        `https://wsrv.nl/?url=${ encodeURIComponent(urlString) }`,
    ]

    const fetchDead = (urlString: string, opts: any = {}) => {
        const urlParams = base58Enc(urlString)
        return fetchImageWithFallbacks(urlString, urlParams, 'test-agent', `http://localhost:${ port }/default.jpg`, log, {
            timeout: 1000,
            skipUrls: externalMirrors(urlString, urlParams),
            ...opts,
        })
    }

    it('marks a URL dead after the mirror chain is exhausted', async function() {
        const deadUrl = `http://localhost:${ port }/dead-1.jpg`
        const result = await fetchDead(deadUrl)
        assert.equal(result.isFallback, true, 'should serve the default image')
        assert(originHits >= 1, 'should have tried the origin')
        assert.equal(await isKnownDeadUrl(deadUrl), true, 'should be negatively cached')
    })

    it('skips the mirror chain for a known-dead URL', async function() {
        const deadUrl = `http://localhost:${ port }/dead-2.jpg`
        await fetchDead(deadUrl)
        const hitsAfterFirst = originHits
        const result = await fetchDead(deadUrl)
        assert.equal(result.isFallback, true, 'should still serve the default image')
        assert.equal(originHits, hitsAfterFirst, 'should not contact the origin again')
    })

    it('walks the chain again when skipNegativeCache is set', async function() {
        const deadUrl = `http://localhost:${ port }/dead-3.jpg`
        await fetchDead(deadUrl)
        const hitsAfterFirst = originHits
        await fetchDead(deadUrl, {skipNegativeCache: true})
        assert(originHits > hitsAfterFirst, 'should contact the origin again')
    })

    it('does not affect URLs that fetch successfully', async function() {
        const liveUrl = `http://localhost:${ port }/default-live.jpg`
        const result = await fetchDead(liveUrl)
        assert.equal(result.isFallback, false, 'should serve the fetched image')
        assert.equal(await isKnownDeadUrl(liveUrl), false, 'should not be negatively cached')
    })

    it('clears the negative entry when a bypassed re-fetch succeeds', async function() {
        const flakyUrl = `http://localhost:${ port }/flaky-1.jpg`
        flakyAlive = false
        await fetchDead(flakyUrl)
        assert.equal(await isKnownDeadUrl(flakyUrl), true, 'should be negatively cached while dead')
        flakyAlive = true
        const revived = await fetchDead(flakyUrl, {skipNegativeCache: true})
        assert.equal(revived.isFallback, false, 'bypassed re-fetch should serve the real image')
        assert.equal(await isKnownDeadUrl(flakyUrl), false, 'successful fetch should clear the entry')
        const followUp = await fetchDead(flakyUrl)
        assert.equal(followUp.isFallback, false, 'normal requests should fetch the revived URL again')
    })

    it('remembers a terminally-dead URL for the full TTL', async function() {
        // Every hop answers 404, so the origin has definitively said "not here"
        const goneUrl = `http://localhost:${ port }/gone-1.jpg`
        await fetchDead(goneUrl)
        assert.equal(await isKnownDeadUrl(goneUrl), true, 'should be negatively cached')
        const ttl = peekDeadUrlTtl(goneUrl) as number
        assert(ttl > 60 * 1000, `terminal failure should use the full TTL, got ${ ttl }ms`)
    })

    it('only briefly remembers a URL whose chain failed transiently', async function() {
        // The default path 500s, which says nothing about whether the image exists
        const flakyUrl = `http://localhost:${ port }/transient-1.jpg`
        await fetchDead(flakyUrl)
        assert.equal(await isKnownDeadUrl(flakyUrl), true, 'should still be cached to stop a stampede')
        const ttl = peekDeadUrlTtl(flakyUrl) as number
        assert(ttl <= 60 * 1000, `transient failure should use the short TTL, got ${ ttl }ms`)
    })

    it('treats a chain that timed out as transient, not dead', async function() {
        // Unroutable address: connect never completes, so this surfaces as a
        // timeout rather than any HTTP answer
        const timeoutUrl = 'http://192.0.2.1/never-answers.jpg'
        const urlParams = base58Enc(timeoutUrl)
        await fetchImageWithFallbacks(timeoutUrl, urlParams, 'test-agent', `http://localhost:${ port }/default.jpg`, log, {
            timeout: 300,
            skipUrls: externalMirrors(timeoutUrl, urlParams),
        })
        const ttl = peekDeadUrlTtl(timeoutUrl) as number
        assert(ttl !== undefined && ttl <= 60 * 1000, `timeout should use the short TTL, got ${ ttl }ms`)
    })

    it('expires local entries after their TTL', async function() {
        const deadUrl = `http://localhost:${ port }/dead-4.jpg`
        await markDeadUrl(deadUrl, 0.05)
        assert.equal(await isKnownDeadUrl(deadUrl), true)
        await new Promise((resolve) => setTimeout(resolve, 120))
        assert.equal(await isKnownDeadUrl(deadUrl), false)
    })
})
