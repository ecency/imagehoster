import 'mocha'
import assert from 'assert'
import * as fs from 'fs'
import * as http from 'http'
import * as path from 'path'

import {clearNegativeFetchCache, fetchImageWithFallbacks, isKnownDeadUrl, markDeadUrl} from './../src/fetch-image'
import {base58Enc} from './../src/utils'

describe('negative fetch cache', function() {
    this.timeout(20000)

    const log: any = {debug() {}, info() {}, warn() {}, error() {}}

    let port: number
    let originHits = 0
    // /default* serves a real image (stands in for the configured default);
    // every other path counts the hit and fails, standing in for a dead origin
    const server = http.createServer((req, res) => {
        if (req.url && req.url.startsWith('/default')) {
            fs.createReadStream(path.resolve(__dirname, 'test.jpg')).pipe(res)
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

    it('expires local entries after their TTL', async function() {
        const deadUrl = `http://localhost:${ port }/dead-4.jpg`
        await markDeadUrl(deadUrl, 0.05)
        assert.equal(await isKnownDeadUrl(deadUrl), true)
        await new Promise((resolve) => setTimeout(resolve, 120))
        assert.equal(await isKnownDeadUrl(deadUrl), false)
    })
})
