import 'mocha'
import assert from 'assert'
import config from 'config'
import net, { AddressInfo } from 'net'

import { getProfile, rpc } from './../src/common'
import {
    banVarnish,
    ImageKind,
    imagePaths,
    imageRecord,
    invalidateUserImages,
    invalidators,
    noteProfileImages,
    profileUpdates,
    scheduleRefresh,
    timing,
    ServedImages,
} from './../src/profile-change'

/** In-memory record store plus a log of every ban and purge, in call order. */
function harness() {
    const records = new Map<string, ServedImages>()
    const calls: string[] = []
    const purged: string[][] = []
    const orig = { ...imageRecord }
    const origInv = { ...invalidators }
    imageRecord.get = async (user) => records.get(user)
    imageRecord.set = async (user, value) => { records.set(user, value) }
    invalidators.banVarnish = async (user: string, kind: ImageKind) => { calls.push(`ban ${user} ${kind}`); return true }
    invalidators.purgeCdn = (urls: string[]) => { calls.push('purge'); purged.push(urls) }
    const restore = () => {
        Object.assign(imageRecord, orig)
        Object.assign(invalidators, origInv)
    }
    return { records, calls, purged, restore }
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

describe('profile image change', () => {
    let h: ReturnType<typeof harness>
    beforeEach(() => { h = harness() })
    afterEach(() => h.restore())

    it('lists every avatar size', () => {
        assert.deepEqual(imagePaths('esie', 'avatar'), [
            '/u/esie/avatar', '/u/esie/avatar/', '/u/esie/avatar/small', '/u/esie/avatar/medium', '/u/esie/avatar/large',
        ])
        assert.deepEqual(imagePaths('esie', 'cover'), ['/u/esie/cover'])
    })

    it('records a first sighting without clearing anything', async () => {
        await noteProfileImages('esie', profileWith('https://x/a.jpg'))
        assert.deepEqual(h.records.get('esie'), { avatar: 'https://x/a.jpg', cover: '' })
        assert.deepEqual(h.calls, [])
    })

    it('does nothing when the images are unchanged', async () => {
        h.records.set('esie', { avatar: 'https://x/a.jpg', cover: '' })
        await noteProfileImages('esie', profileWith('https://x/a.jpg'))
        assert.deepEqual(h.calls, [])
    })

    it('bans Varnish before purging the CDN when the avatar changes', async () => {
        h.records.set('esie', { avatar: 'https://x/old.jpg', cover: 'https://x/c.jpg' })
        await noteProfileImages('esie', profileWith('https://x/new.jpg', 'https://x/c.jpg'))
        assert.deepEqual(h.calls, ['ban esie avatar', 'purge'])
        assert.deepEqual(h.purged[0], imagePaths('esie', 'avatar').map((p) => `${new URL(config.get('service_url') as string).origin}${p}`))
        assert.deepEqual(h.records.get('esie'), { avatar: 'https://x/new.jpg', cover: 'https://x/c.jpg' })
    })

    it('treats a first avatar on a new account as a change from the default', async () => {
        h.records.set('newbie', { avatar: '', cover: '' })
        await noteProfileImages('newbie', profileWith('https://x/first.jpg'))
        assert.deepEqual(h.calls, ['ban newbie avatar', 'purge'])
    })

    it('clears both kinds in one purge when both change', async () => {
        h.records.set('esie', { avatar: 'https://x/a.jpg', cover: 'https://x/c.jpg' })
        await noteProfileImages('esie', profileWith('https://x/a2.jpg', ''))
        assert.deepEqual(h.calls, ['ban esie avatar', 'ban esie cover', 'purge'])
        assert.equal(h.purged[0].length, 6)
    })

    it('ignores a non-http value, the same as the avatar handler does', async () => {
        h.records.set('esie', { avatar: '', cover: '' })
        await noteProfileImages('esie', profileWith('ipfs://whatever'))
        assert.deepEqual(h.calls, [])
    })

    it('clears a second time after the slowest render could finish', async () => {
        const orig = timing.secondPassMs
        timing.secondPassMs = 10
        try {
            await invalidateUserImages('esie', ['avatar'])
            assert.deepEqual(h.calls, ['ban esie avatar', 'purge'])
            await until(() => h.calls.length === 4)
            assert.deepEqual(h.calls, ['ban esie avatar', 'purge', 'ban esie avatar', 'purge'])
        } finally {
            timing.secondPassMs = orig
        }
    })

    it('still purges the CDN when the Varnish ban fails', async () => {
        invalidators.banVarnish = async () => { h.calls.push('ban failed'); return false }
        await invalidateUserImages('esie', ['avatar'])
        assert.deepEqual(h.calls, ['ban failed', 'purge'])
    })

    it('notes a fresh getProfile and clears on change', async () => {
        h.records.set('foo', { avatar: 'https://example.com/old.jpg', cover: 'https://example.com/cover.jpg' })
        await getProfile('foo', false)
        await until(() => h.calls.length === 2)
        assert.deepEqual(h.calls, ['ban foo avatar', 'purge'])
    })

    it('does not note the short-ttl profile from a failed legacy lookup', async () => {
        h.records.set('ghostbridge', { avatar: 'https://x/a.jpg', cover: '' })
        await getProfile('ghostbridge', false)
        await new Promise((r) => setTimeout(r, 30))
        assert.deepEqual(h.calls, [])
        assert.deepEqual(h.records.get('ghostbridge'), { avatar: 'https://x/a.jpg', cover: '' })
    })

    it('refreshes a recorded user after the delays and skips unknown users', async () => {
        h.records.set('foo', { avatar: 'https://example.com/old.jpg', cover: 'https://example.com/cover.jpg' })
        await scheduleRefresh('foo', [1, 20])
        await until(() => h.calls.length === 2)
        await new Promise((r) => setTimeout(r, 40))
        // The second refresh finds the record already current, so nothing more.
        assert.deepEqual(h.calls, ['ban foo avatar', 'purge'])
    })

    it('makes no lookup for an account it has not served recently', async () => {
        const orig = rpc.call
        const lookups: string[] = []
        rpc.call = async (method: string, params?: any) => { lookups.push(method); return orig(method, params) }
        try {
            await scheduleRefresh('bar', [1])
            await new Promise((r) => setTimeout(r, 30))
        } finally {
            rpc.call = orig
        }
        assert.deepEqual(lookups, [])
    })
})

describe('profileUpdates', () => {
    const block = (ops: any[]) => ({ transactions: [{ operations: ops }] })

    it('picks account updates that carry a profile, once per account', () => {
        const users = profileUpdates(block([
            { type: 'account_update2_operation', value: { account: 'a', posting_json_metadata: '{"profile":{"profile_image":"x"}}' } },
            { type: 'account_update_operation', value: { account: 'b', json_metadata: '{"profile":{}}' } },
            { type: 'account_update2_operation', value: { account: 'a', posting_json_metadata: '{"profile":{}}' } },
        ]))
        assert.deepEqual(users, ['a', 'b'])
    })

    it('counts any posting_json_metadata write, since bridge reads the profile there', () => {
        const users = profileUpdates(block([
            { type: 'account_update2_operation', value: { account: 'd', posting_json_metadata: '{"version":2}' } },
        ]))
        assert.deepEqual(users, ['d'])
    })

    it('skips other ops, empty metadata and legacy metadata without a profile', () => {
        const users = profileUpdates(block([
            { type: 'account_update2_operation', value: { account: 'c', json_metadata: '{"beneficiaries":[]}', posting_json_metadata: '' } },
            { type: 'custom_json_operation', value: { id: 'profile', json: '{"profile":{}}' } },
        ]))
        assert.deepEqual(users, [])
        assert.deepEqual(profileUpdates(undefined), [])
        assert.deepEqual(profileUpdates({}), [])
    })
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
