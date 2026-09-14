import 'mocha'
import assert from 'assert'
import * as fs from 'fs'
import * as path from 'path'

// fetch-image before blacklist-service: loading the latter first trips the
// blacklist-service <-> utils import cycle
import {clearNegativeFetchCache, fetchImageWithFallbacks} from './../src/fetch-image'
import {initBlacklistService} from './../src/blacklist-service'
import {base58Enc} from './../src/utils'

describe('fallback mirror chain', function() {
    const log: any = {debug() {}, info() {}, warn() {}, error() {}}
    const png = fs.readFileSync(path.resolve(__dirname, 'test.png'))
    const DEFAULT_URL = 'https://default.example/default.png'
    const IMGUR_MIRROR = 'https://external-content.duckduckgo.com/iu/?u='

    // The fetch layer reads utils.fetchUrl at call time, so replacing it records
    // every candidate in order without a request leaving the process
    const utilsModule = require('./../src/utils')
    const realFetchUrl = utilsModule.fetchUrl
    let requested: string[]
    let answer: (url: string) => any

    const ok = () => ({statusCode: 200, headers: {}, body: png})
    const refused = () => ({statusCode: 429, headers: {}, body: Buffer.alloc(0)})
    // The origin and every public mirror refuse, the default image loads
    const allRefused = (url: string) => url === DEFAULT_URL ? ok() : refused()
    // Only the imgur mirror can reach the source
    const onlyImgurMirror = (url: string) => url.startsWith(IMGUR_MIRROR) || url === DEFAULT_URL ? ok() : refused()

    const candidates = () => requested.filter((url) => url !== DEFAULT_URL)
    const fetch = (urlString: string) =>
        fetchImageWithFallbacks(urlString, base58Enc(urlString), 'test-agent', DEFAULT_URL, log, {timeout: 1000})

    beforeEach(() => {
        clearNegativeFetchCache()
        requested = []
        answer = allRefused
        utilsModule.fetchUrl = async (url: string) => {
            requested.push(url)
            return answer(url)
        }
    })
    afterEach(() => {
        utilsModule.fetchUrl = realFetchUrl
    })

    it('tries the imgur mirror right after the origin and serves its bytes', async function() {
        const source = 'https://i.imgur.com/mirror-order-1.png'
        answer = onlyImgurMirror
        const result = await fetch(source)
        assert.equal(result.isFallback, false, 'the mirror answer is a real image, not the placeholder')
        assert.equal(Buffer.compare(result.res.body as Buffer, png), 0)
        assert.deepEqual(candidates(), [source, IMGUR_MIRROR + encodeURIComponent(source)],
            'no public mirror is contacted before the imgur mirror')
    })

    it('hands the imgur mirror the https form of an http source', async function() {
        const source = 'http://i.imgur.com/mirror-https-2.jpg'
        const https = 'https://i.imgur.com/mirror-https-2.jpg'
        answer = onlyImgurMirror
        await fetch(source)
        assert.deepEqual(candidates(), [https, source, IMGUR_MIRROR + encodeURIComponent(https)])
    })

    it('covers imgur.com and its subdomains', async function() {
        for (const source of ['https://imgur.com/mirror-apex-3.png', 'https://m.imgur.com/mirror-sub-4.png']) {
            requested = []
            answer = onlyImgurMirror
            const result = await fetch(source)
            assert.equal(result.isFallback, false, source)
            assert.equal(candidates()[1], IMGUR_MIRROR + encodeURIComponent(source), source)
        }
    })

    it('keeps walking the public mirrors when the imgur mirror fails too', async function() {
        const source = 'https://i.imgur.com/mirror-fallthrough-5.png'
        const result = await fetch(source)
        assert.equal(result.isFallback, true)
        const seen = candidates()
        assert.equal(seen[1], IMGUR_MIRROR + encodeURIComponent(source))
        assert(seen.length > 2, 'the rest of the chain still runs')
        assert(seen.slice(2).some((url) => url.startsWith('https://images.hive.blog/')))
    })

    it('never sends other hosts to the imgur mirror, lookalikes included', async function() {
        const sources = [
            'https://example.com/mirror-other-6.png',
            'https://notimgur.com/mirror-lookalike-7.png',
            'https://i.imgur.com.evil.example/mirror-suffix-8.png',
            'https://evil.example/i.imgur.com/mirror-path-9.png',
        ]
        for (const source of sources) {
            requested = []
            const result = await fetch(source)
            assert.equal(result.isFallback, true, source)
            assert(candidates().length > 0, source)
            assert(!requested.some((url) => url.startsWith(IMGUR_MIRROR)), `${ source } must not reach the imgur mirror`)
        }
    })

    it('never hands a blacklisted imgur source to the imgur mirror', async function() {
        const source = 'https://i.imgur.com/mirror-blocked-10.png'
        answer = onlyImgurMirror
        initBlacklistService([], [], ['i.imgur.com'])
        try {
            const result = await fetch(source)
            assert.equal(result.isFallback, true)
            // initBlacklistService refreshes its remote lists through the same
            // fetchUrl, so assert on the image candidates rather than on silence
            assert(!requested.includes(source), 'the blocked source is not fetched')
            assert(!requested.some((url) => url.startsWith(IMGUR_MIRROR)), 'nor handed to the imgur mirror')
        } finally {
            initBlacklistService([], [], [])
        }
    })
})
