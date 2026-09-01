import 'mocha'
import assert from 'assert'
import * as fs from 'fs'
import * as http from 'http'
import * as path from 'path'
import * as net from 'net'

import {clearNegativeFetchCache, fetchImageWithFallbacks, isKnownDeadUrl, peekDeadUrlTtl} from './../src/fetch-image'
import {base58Enc} from './../src/utils'

describe('fetch deadline', function() {
    this.timeout(30000)

    const lines: any[] = []
    const log: any = {
        debug() { /* noop */ },
        info() { /* noop */ },
        warn(obj: any, msg: any) { lines.push({obj, msg}) },
        error() { /* noop */ },
    }

    let port: number
    let hangPort: number
    let attempts = 0
    const sockets = new Set<net.Socket>()

    // Accepts the TCP connection and then says nothing, ever. Unlike the HTTP
    // server's /hang, this also stalls the HTTPS-upgrade candidate, so BOTH
    // candidates burn a full phase timer and the walk reaches the deadline
    // deterministically rather than depending on how fast a TLS handshake fails.
    const hangServer = net.createServer((s2) => { sockets.add(s2); s2.on('error', () => undefined) })

    // /default serves a real image and stands in for the configured placeholder.
    // /hang accepts the connection and never answers, which is exactly the shape
    // that used to burn 10s per phase per candidate.
    const server = http.createServer((req, res) => {
        if (req.url && req.url.startsWith('/default')) {
            fs.createReadStream(path.resolve(__dirname, 'test.jpg')).pipe(res)
            return
        }
        attempts++
        if (req.url && req.url.startsWith('/hang')) {
            return // never respond, never end
        }
        res.writeHead(500)
        res.end()
    })
    server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)) })

    before((done) => {
        server.listen(0, 'localhost', () => {
            port = (server.address() as any).port
            hangServer.listen(0, 'localhost', () => {
                hangPort = (hangServer.address() as any).port
                done()
            })
        })
    })
    after((done) => {
        // Both servers deliberately leave sockets open, so neither would close
        for (const s of sockets) { s.destroy() }
        hangServer.close(() => server.close(done))
    })
    beforeEach(() => { clearNegativeFetchCache(); attempts = 0; lines.length = 0 })

    // Keep every candidate on localhost so a test never reaches the public mirrors
    const externalMirrors = (urlString: string, urlParams: string) => [
        `https://images.hive.blog/p/${ urlParams }`,
        `https://steemitimages.com/p/${ urlParams }`,
        `https://images.hive.blog/0x0/${ urlString }`,
        `https://steemitimages.com/0x0/${ urlString }`,
        `https://img.leopedia.io/0x0/${ urlString }`,
        `https://wsrv.nl/?url=${ encodeURIComponent(urlString) }`,
    ]

    const fetchWith = (urlString: string, opts: any = {}) => {
        const urlParams = base58Enc(urlString)
        return fetchImageWithFallbacks(urlString, urlParams, 'test-agent', `http://localhost:${ port }/default.jpg`, log, {
            skipUrls: externalMirrors(urlString, urlParams),
            ...opts,
        })
    }

    const exhaustedLine = () => lines.find((l) => l.msg === 'Negative-caching exhausted URL')
    const deadlineLine = () => lines.find((l) => l.msg === 'Fetch deadline reached, stopping mirror walk')

    it('stops walking mirrors once the deadline is spent, and still serves the placeholder', async function() {
        // Both candidates stall on a hard 900ms timer, so after the first the
        // remaining budget (~1100ms) is below FETCH_MIN_REMAINING_MS and the walk
        // must stop rather than start a candidate it cannot finish.
        const url = `http://localhost:${ hangPort }/stalled-1.jpg`
        const started = Date.now()
        const result = await fetchWith(url, {timeout: 900, deadlineAt: Date.now() + 2000})
        const elapsed = Date.now() - started

        assert.equal(result.isFallback, true, 'must fall back to the placeholder, not throw')
        assert(elapsed < 5000, `walk should be cut short, took ${ elapsed }ms`)
        const line = deadlineLine()
        assert(line, 'should log that the deadline stopped the walk')
        assert.equal(line.obj.attempted, 1, 'exactly one candidate should have been tried')
    })

    it('gives a deadline-truncated walk the short transient TTL, never the full one', async function() {
        const url = `http://localhost:${ hangPort }/stalled-2.jpg`
        await fetchWith(url, {timeout: 900, deadlineAt: Date.now() + 2000})

        assert.equal(await isKnownDeadUrl(url), true, 'a truncated walk still records the URL')
        const line = exhaustedLine()
        assert(line, 'should log the negative-cache decision')
        assert.equal(line.obj.deadlineHit, true, 'should record that the deadline fired')
        assert.equal(line.obj.transient, true, 'a truncated walk learned nothing conclusive')
        assert.equal(line.obj.ttl, 60, 'must be the transient TTL, not 600')
        const ttl = peekDeadUrlTtl(url)
        assert(ttl !== undefined && ttl <= 60000, `local entry should be short, got ${ ttl }ms`)
    })

    it('records nothing when the deadline was already blown before any candidate ran', async function() {
        const url = `http://localhost:${ hangPort }/stalled-3.jpg`
        const result = await fetchWith(url, {timeout: 800, deadlineAt: Date.now() - 1})

        assert.equal(result.isFallback, true, 'the placeholder is reserved budget, so it still runs')
        assert.equal(attempts, 0, 'must not have contacted the origin at all')
        assert.equal(await isKnownDeadUrl(url), false, 'a walk that probed nothing must not mark the URL dead')
        assert(!exhaustedLine(), 'must not log a negative-cache decision it did not earn')
    })

    it('emits the telemetry the budget is tuned from', async function() {
        const url = `http://localhost:${ hangPort }/stalled-4.jpg`
        await fetchWith(url, {timeout: 900, deadlineAt: Date.now() + 2000})

        const line = exhaustedLine()
        assert(line, 'should log the negative-cache decision at warn level')
        assert(typeof line.obj.elapsedMs === 'number', 'elapsedMs is what says whether 25s is right')
        assert(typeof line.obj.attempted === 'number', 'attempted distinguishes slow from dead')
        assert(line.obj.attempted > 0, 'this walk did probe candidates')
        assert.equal(line.obj.urlString, url)
    })

    it('leaves behaviour unchanged when no deadline is supplied', async function() {
        const url = `http://localhost:${ port }/plain.jpg`
        const result = await fetchWith(url, {timeout: 500})

        assert.equal(result.isFallback, true)
        assert(attempts > 0, 'should have walked the chain normally')
        assert(!deadlineLine(), 'no deadline means no truncation')
        const line = exhaustedLine()
        assert(line, 'still records the exhausted walk')
        assert.equal(line.obj.deadlineHit, false)
    })
})
