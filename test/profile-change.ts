import 'mocha'
import assert from 'assert'
import config from 'config'
import net, { AddressInfo } from 'net'

import { getProfile, rpc } from './../src/common'
import {
    banVarnish,
    clearOnce,
    ImageKind,
    imagePaths,
    imageRecord,
    invalidators,
    noteProfileImages,
    profileUpdates,
    queue,
    REFRESH_DELAYS_MS,
    runDue,
    scheduleRefresh,
    ServedImages,
    timing,
} from './../src/profile-change'
import { cdnSettings, purgeCache } from './../src/utils'

const ORIGIN = new URL(config.get('service_url') as string).origin

/** In-memory record store and queue, plus a log of every ban and purge in call order. */
function harness() {
    const records = new Map<string, ServedImages>()
    const due = new Map<string, number>()
    const calls: string[] = []
    const purged: string[][] = []
    const result = { ban: true, purge: true }
    const orig = { record: { ...imageRecord }, queue: { ...queue }, inv: { ...invalidators } }
    imageRecord.get = async (user) => records.get(user)
    imageRecord.set = async (user, value) => { records.set(user, value) }
    queue.add = async (member, at) => { due.set(member, at) }
    queue.due = async (now, limit) => [...due.entries()]
        .filter(([, at]) => at <= now).sort((a, b) => a[1] - b[1]).slice(0, limit).map(([m]) => m)
    queue.claim = async (member, now, leaseUntil) => {
        const at = due.get(member)
        if (at === undefined || at > now) return false
        due.set(member, leaseUntil)
        return true
    }
    queue.finish = async (member, leaseUntil) => { if (due.get(member) === leaseUntil) due.delete(member) }
    queue.retry = async (member, leaseUntil, at) => { if (due.get(member) === leaseUntil) due.set(member, at) }
    invalidators.banVarnish = async (user: string, kind: ImageKind) => { calls.push(`ban ${user} ${kind}`); return result.ban }
    invalidators.purgeCdn = async (urls: string[]) => { calls.push('purge'); purged.push(urls); return result.purge }
    const restore = () => {
        Object.assign(imageRecord, orig.record)
        Object.assign(queue, orig.queue)
        Object.assign(invalidators, orig.inv)
    }
    return { records, due, calls, purged, result, restore }
}

const profileWith = (avatar: string, cover = '') =>
    ({ name: 'u', active: '', metadata: { profile: { profile_image: avatar, cover_image: cover } } } as any)

const until = async (check: () => boolean, ms = 1000) => {
    const end = Date.now() + ms
    while (!check()) {
        if (Date.now() > end) throw new Error('timed out')
        await new Promise((r) => setTimeout(r, 5))
    }
}

const T = 1_000_000

describe('profile image change detection', () => {
    let h: ReturnType<typeof harness>
    beforeEach(() => { h = harness() })
    afterEach(() => h.restore())

    it('lists every avatar size', () => {
        assert.deepEqual(imagePaths('esie', 'avatar'), [
            '/u/esie/avatar', '/u/esie/avatar/', '/u/esie/avatar/small', '/u/esie/avatar/medium', '/u/esie/avatar/large',
        ])
        assert.deepEqual(imagePaths('esie', 'cover'), ['/u/esie/cover', '/u/esie/cover/'])
    })

    it('records a first sighting without queueing anything', async () => {
        await noteProfileImages('esie', profileWith('https://x/a.jpg'), T)
        assert.deepEqual(h.records.get('esie'), { avatar: 'https://x/a.jpg', cover: '' })
        assert.deepEqual([...h.due.keys()], [])
    })

    it('queues nothing when the images are unchanged', async () => {
        h.records.set('esie', { avatar: 'https://x/a.jpg', cover: '' })
        await noteProfileImages('esie', profileWith('https://x/a.jpg'), T)
        assert.deepEqual([...h.due.keys()], [])
    })

    it('queues a clear, due now, for a changed avatar', async () => {
        h.records.set('esie', { avatar: 'https://x/old.jpg', cover: 'https://x/c.jpg' })
        await noteProfileImages('esie', profileWith('https://x/new.jpg', 'https://x/c.jpg'), T)
        assert.deepEqual([...h.due.entries()], [[`clear|esie|avatar|1|${T}|all`, T]])
        assert.deepEqual(h.records.get('esie'), { avatar: 'https://x/new.jpg', cover: 'https://x/c.jpg' })
    })

    it('treats a first avatar on a new account as a change from the default', async () => {
        h.records.set('newbie', { avatar: '', cover: '' })
        await noteProfileImages('newbie', profileWith('https://x/first.jpg'), T)
        assert.deepEqual([...h.due.keys()], [`clear|newbie|avatar|1|${T}|all`])
    })

    it('queues both kinds when both change', async () => {
        h.records.set('esie', { avatar: 'https://x/a.jpg', cover: 'https://x/c.jpg' })
        await noteProfileImages('esie', profileWith('https://x/a2.jpg', ''), T)
        assert.deepEqual([...h.due.keys()], [`clear|esie|avatar|1|${T}|all`, `clear|esie|cover|1|${T}|all`])
    })

    it('ignores a non-http value, the same as the avatar handler does', async () => {
        h.records.set('esie', { avatar: '', cover: '' })
        await noteProfileImages('esie', profileWith('ipfs://whatever'), T)
        assert.deepEqual([...h.due.keys()], [])
    })

    it('notes a fresh getProfile and queues on change', async () => {
        h.records.set('foo', { avatar: 'https://example.com/old.jpg', cover: 'https://example.com/cover.jpg' })
        await getProfile('foo', false)
        await until(() => h.due.size === 1)
        assert.match([...h.due.keys()][0], /^clear\|foo\|avatar\|1\|\d+\|all$/)
    })

    it('does not note the short-ttl profile from a failed legacy lookup', async () => {
        h.records.set('ghostbridge', { avatar: 'https://x/a.jpg', cover: '' })
        await getProfile('ghostbridge', false)
        await new Promise((r) => setTimeout(r, 30))
        assert.deepEqual([...h.due.keys()], [])
        assert.deepEqual(h.records.get('ghostbridge'), { avatar: 'https://x/a.jpg', cover: '' })
    })
})

describe('clearing caches', () => {
    let h: ReturnType<typeof harness>
    beforeEach(() => { h = harness() })
    afterEach(() => h.restore())

    it('bans Varnish before purging the CDN, for the right URLs', async () => {
        assert.deepEqual(await clearOnce('esie', 'avatar'), { banned: true, purged: true })
        assert.deepEqual(h.calls, ['ban esie avatar', 'purge'])
        assert.deepEqual(h.purged[0], imagePaths('esie', 'avatar').map((p) => `${ORIGIN}${p}`))
    })

    it('still purges the CDN when the ban fails, and reports failure', async () => {
        h.result.ban = false
        assert.deepEqual(await clearOnce('esie', 'avatar'), { banned: false, purged: true })
        assert.deepEqual(h.calls, ['ban esie avatar', 'purge'])
    })

    it('skips the ban when only the purge is left', async () => {
        assert.deepEqual(await clearOnce('esie', 'avatar', true), { banned: true, purged: true })
        assert.deepEqual(h.calls, ['purge'])
    })

    it('runs pass 1, then queues pass 2 after the slowest render', async () => {
        h.due.set(`clear|esie|avatar|1|${T}|all`, T)
        await runDue(T)
        assert.deepEqual(h.calls, ['ban esie avatar', 'purge'])
        assert.deepEqual([...h.due.entries()], [[`clear|esie|avatar|2|${T}|all`, T + timing.secondPassMs]])
        await runDue(T + timing.secondPassMs)
        assert.deepEqual(h.calls, ['ban esie avatar', 'purge', 'ban esie avatar', 'purge'])
        assert.deepEqual([...h.due.keys()], [])
    })

    it('does not run work that is not due yet', async () => {
        h.due.set(`clear|esie|avatar|2|${T}|all`, T + 10)
        await runDue(T)
        assert.deepEqual(h.calls, [])
        assert.equal(h.due.size, 1)
    })

    it('retries both after a failed ban, since the purge must follow it', async () => {
        h.result.ban = false
        h.due.set(`clear|esie|avatar|1|${T}|all`, T)
        await runDue(T)
        assert.deepEqual([...h.due.entries()], [[`clear|esie|avatar|1|${T}|all`, T + timing.retryMs]])
        h.result.ban = true
        await runDue(T + timing.retryMs)
        assert.deepEqual(h.calls, ['ban esie avatar', 'purge', 'ban esie avatar', 'purge'])
        assert.deepEqual([...h.due.keys()], [`clear|esie|avatar|2|${T}|all`])
    })

    it('retries only the purge when the ban already succeeded', async () => {
        h.result.purge = false
        h.due.set(`clear|esie|avatar|1|${T}|all`, T)
        await runDue(T)
        assert.deepEqual([...h.due.keys()], [`clear|esie|avatar|1|${T}|cdn`])
        h.result.purge = true
        await runDue(T + timing.retryMs)
        assert.deepEqual(h.calls, ['ban esie avatar', 'purge', 'purge'])
        assert.deepEqual([...h.due.keys()], [`clear|esie|avatar|2|${T}|all`])
    })

    it('backs off to half the time since the change, up to a cap', async () => {
        h.result.ban = false
        const late = T + 20 * 60 * 1000
        h.due.set(`clear|esie|avatar|1|${T}|all`, late)
        await runDue(late)
        assert.equal(h.due.get(`clear|esie|avatar|1|${T}|all`), late + 10 * 60 * 1000)
        const later = T + 100 * 60 * 1000
        await runDue(later)
        assert.equal(h.due.get(`clear|esie|avatar|1|${T}|all`), later + timing.maxRetryMs)
    })

    it('skips a member another holder already claimed', async () => {
        h.due.set(`clear|esie|avatar|1|${T}|all`, T)
        queue.claim = async () => false
        await runDue(T)
        assert.deepEqual(h.calls, [])
    })

    it('stops starting work once the time budget is spent', async () => {
        const orig = timing.runBudgetMs
        timing.runBudgetMs = -1
        try {
            h.due.set(`clear|esie|avatar|1|${T}|all`, T)
            await runDue(T)
        } finally {
            timing.runBudgetMs = orig
        }
        assert.deepEqual(h.calls, [])
        assert.equal(h.due.size, 1)
    })

    it('drops a clear with a malformed timestamp instead of retrying it forever', async () => {
        h.result.ban = false
        h.due.set('clear|esie|avatar|1|nope|all', T)
        await runDue(T)
        assert.equal(h.due.size, 0)
        assert.deepEqual(h.calls, [])
    })

    it('gives up once every cache layer has expired the old image anyway', async () => {
        h.result.ban = false
        h.due.set(`clear|esie|avatar|1|${T}|all`, T)
        await runDue(T + timing.giveUpMs + 1)
        assert.deepEqual([...h.due.keys()], [])
    })

    it('keeps the lease on a task that throws, so it runs again when the lease ends', async () => {
        h.records.set('foo', { avatar: 'https://example.com/old.jpg', cover: 'https://example.com/cover.jpg' })
        h.due.set('refresh|foo|0', T)
        const add = queue.add
        queue.add = async (member, at) => {
            if (member.startsWith('clear|')) throw new Error('redis down')
            return add(member, at)
        }
        await runDue(T)
        assert.deepEqual([...h.due.entries()], [['refresh|foo|0', T + timing.claimLeaseMs]])
        // The record did not move, so the retry still sees the change.
        assert.equal(h.records.get('foo')!.avatar, 'https://example.com/old.jpg')
        queue.add = add
        await runDue(T + timing.claimLeaseMs)
        assert.equal(h.due.has('refresh|foo|0'), false)
        assert([...h.due.keys()].some((m) => m.startsWith('clear|foo|avatar|1|')))
    })

    it('does not finish a member that was moved while it ran', async () => {
        h.records.set('foo', { avatar: 'https://example.com/avatar.jpg', cover: 'https://example.com/cover.jpg' })
        h.due.set('refresh|foo|0', T)
        const finish = queue.finish
        queue.finish = async (member, leaseUntil) => {
            // A newer account update re-adds the refresh before this one finishes.
            h.due.set(member, T + 999)
            return finish(member, leaseUntil)
        }
        await runDue(T)
        assert.equal(h.due.get('refresh|foo|0'), T + 999)
    })

    it('keeps the record unchanged when queueing the clear fails', async () => {
        h.records.set('esie', { avatar: 'https://x/old.jpg', cover: '' })
        queue.add = async () => { throw new Error('redis down') }
        await assert.rejects(noteProfileImages('esie', profileWith('https://x/new.jpg'), T))
        assert.deepEqual(h.records.get('esie'), { avatar: 'https://x/old.jpg', cover: '' })
    })

    it('drops a member it does not understand', async () => {
        h.due.set('bogus|x', T)
        await runDue(T)
        assert.equal(h.due.size, 0)
        assert.deepEqual(h.calls, [])
    })
})

describe('refresh scheduling', () => {
    let h: ReturnType<typeof harness>
    beforeEach(() => { h = harness() })
    afterEach(() => h.restore())

    it('queues the delayed lookups for a recorded user', async () => {
        h.records.set('foo', { avatar: 'https://example.com/avatar.jpg', cover: '' })
        await scheduleRefresh('foo', T)
        assert.deepEqual([...h.due.entries()], [
            ['refresh|foo|0', T + REFRESH_DELAYS_MS[0]],
            ['refresh|foo|1', T + REFRESH_DELAYS_MS[1]],
        ])
    })

    it('restarts the window when another update arrives before it ran', async () => {
        h.records.set('foo', { avatar: 'https://example.com/avatar.jpg', cover: '' })
        await scheduleRefresh('foo', T)
        await scheduleRefresh('foo', T + 85_000)
        assert.equal(h.due.get('refresh|foo|1'), T + 85_000 + REFRESH_DELAYS_MS[1])
    })

    it('queues nothing, and makes no lookup, for an account it has not served recently', async () => {
        const orig = rpc.call
        const lookups: string[] = []
        rpc.call = async (method: string, params?: any) => { lookups.push(method); return orig(method, params) }
        try {
            await scheduleRefresh('bar', T)
        } finally {
            rpc.call = orig
        }
        assert.equal(h.due.size, 0)
        assert.deepEqual(lookups, [])
    })

    it('a due refresh looks the profile up fresh, which queues the clear', async () => {
        h.records.set('foo', { avatar: 'https://example.com/old.jpg', cover: 'https://example.com/cover.jpg' })
        h.due.set('refresh|foo|0', T)
        await runDue(T)
        await until(() => [...h.due.keys()].some((m) => m.startsWith('clear|foo|avatar|1|')))
        assert.equal(h.due.has('refresh|foo|0'), false)
    })

    it('retries a refresh whose lookup failed while the user still has a record', async () => {
        const orig = rpc.call
        rpc.call = async () => { throw new Error('node down') }
        try {
            h.records.set('nodeisdown', { avatar: 'https://x/a.jpg', cover: '' })
            h.due.set('refresh|nodeisdown|1', T)
            await runDue(T)
            assert.deepEqual([...h.due.entries()], [['refresh|nodeisdown|1', T + timing.retryMs]])
            h.records.delete('nodeisdown')
            await runDue(T + timing.retryMs)
            assert.equal(h.due.size, 0)
        } finally {
            rpc.call = orig
        }
    })

    it('a failed refresh does not pull a newer update\'s later lookup earlier', async () => {
        const orig = rpc.call
        rpc.call = async () => {
            // A newer account update re-adds this refresh while the lookup runs.
            h.due.set('refresh|nodeisdown|1', T + 90_000)
            throw new Error('node down')
        }
        try {
            h.records.set('nodeisdown', { avatar: 'https://x/a.jpg', cover: '' })
            h.due.set('refresh|nodeisdown|1', T)
            await runDue(T)
        } finally {
            rpc.call = orig
        }
        assert.equal(h.due.get('refresh|nodeisdown|1'), T + 90_000)
    })

    it('retries a refresh that came back incomplete (legacy lookup failed)', async () => {
        h.records.set('ghostbridge', { avatar: 'https://x/a.jpg', cover: '' })
        h.due.set('refresh|ghostbridge|0', T)
        await runDue(T)
        assert.deepEqual([...h.due.entries()], [['refresh|ghostbridge|0', T + timing.retryMs]])
    })

    it('leaves later refreshes queued for whoever holds the lock next', async () => {
        h.records.set('foo', { avatar: 'https://example.com/avatar.jpg', cover: 'https://example.com/cover.jpg' })
        await scheduleRefresh('foo', T)
        await runDue(T + REFRESH_DELAYS_MS[0])
        assert.deepEqual([...h.due.keys()], ['refresh|foo|1'])
    })
})

describe('profileUpdates', () => {
    const block = (ops: any[]) => ({ transactions: [{ operations: ops }] })

    it('counts any metadata write, once per account', () => {
        const users = profileUpdates(block([
            { type: 'account_update2_operation', value: { account: 'a', posting_json_metadata: '{"profile":{"profile_image":"x"}}' } },
            { type: 'account_update_operation', value: { account: 'b', json_metadata: '{}' } },
            { type: 'account_update2_operation', value: { account: 'a', posting_json_metadata: '{"version":2}' } },
            { type: 'account_update2_operation', value: { account: 'd', json_metadata: '{"beneficiaries":[]}', posting_json_metadata: '' } },
        ]))
        assert.deepEqual(users, ['a', 'b', 'd'])
    })

    it('skips other ops and updates that leave both fields unchanged', () => {
        const users = profileUpdates(block([
            { type: 'account_update2_operation', value: { account: 'c', json_metadata: '', posting_json_metadata: '' } },
            { type: 'account_update_operation', value: { account: 'e', memo_key: 'STM...' } },
            { type: 'custom_json_operation', value: { id: 'profile', json: '{"profile":{}}' } },
        ]))
        assert.deepEqual(users, [])
        assert.deepEqual(profileUpdates(undefined), [])
        assert.deepEqual(profileUpdates({}), [])
    })
})

describe('purgeCache result', () => {
    it('resolves true when no CDN is configured, as there is nothing to clear', async () => {
        const orig = cdnSettings.get
        cdnSettings.get = () => undefined
        try {
            assert.equal(await purgeCache(`${ORIGIN}/u/esie/avatar`), true)
        } finally {
            cdnSettings.get = orig
        }
    })

    for (const [name, reply, expected] of [
        ['accepted', { ok: true, body: { success: true } }, true],
        ['rejected', { ok: true, body: { success: false } }, false],
        ['an HTTP error', { ok: false, body: null }, false],
        ['unreadable', { ok: true, body: null }, false],
        ['a network error', 'throw', false],
    ] as const) {
        it(`resolves ${expected} when the purge is ${name}`, async () => {
            const origSettings = cdnSettings.get
            const origFetch = globalThis.fetch
            cdnSettings.get = () => ({ token: 't', zone: 'z' })
            globalThis.fetch = (async () => {
                if (reply === 'throw') throw new Error('down')
                return { ok: reply.ok, status: reply.ok ? 200 : 500, json: async () => reply.body } as any
            }) as any
            try {
                assert.equal(await purgeCache(`${ORIGIN}/u/esie/avatar`), expected)
            } finally {
                cdnSettings.get = origSettings
                globalThis.fetch = origFetch
            }
        })
    }
})

describe('banVarnish', () => {
    // A raw TCP server: Node's HTTP parser rejects the BAN method with a 400
    // before any handler runs. Varnish accepts any method token.
    let server: net.Server
    let url: string
    let seen: Array<{ method?: string, user?: string, kind?: string }>
    let status = 200

    before(async () => {
        server = net.createServer((socket) => {
            let raw = ''
            socket.on('data', (chunk) => {
                raw += chunk.toString()
                if (!raw.includes('\r\n\r\n')) return
                const [requestLine, ...headerLines] = raw.split('\r\n\r\n')[0].split('\r\n')
                const header = (name: string) => {
                    const line = headerLines.find((l) => l.toLowerCase().startsWith(`${name}:`))
                    return line && line.slice(name.length + 1).trim()
                }
                seen.push({ method: requestLine.split(' ')[0], user: header('x-ban-user'), kind: header('x-ban-kind') })
                socket.end(`HTTP/1.1 ${status} X\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`)
            })
        })
        await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
        url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
    })
    after(() => server.close())
    beforeEach(() => { seen = []; status = 200 })

    it('sends a BAN with the user and kind headers', async () => {
        assert.equal(await banVarnish(url, 'esie', 'avatar'), true)
        assert.deepEqual(seen, [{ method: 'BAN', user: 'esie', kind: 'avatar' }])
    })

    it('reports a refused ban', async () => {
        status = 405
        assert.equal(await banVarnish(url, 'esie', 'cover'), false)
    })

    it('reports an unreachable Varnish without throwing', async () => {
        assert.equal(await banVarnish('http://127.0.0.1:1/', 'esie', 'avatar'), false)
    })
})
