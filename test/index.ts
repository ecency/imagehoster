import 'mocha'
import assert from 'assert'
import {PrivateKey} from '@ecency/sdk/hive'

import {rpc} from './../src/common'

export const testKeys = {
    foo: PrivateKey.fromSeed('foo'),
    bar: PrivateKey.fromSeed('bar'),
}

export const mockAccounts: any = {
    foo: {
        name: 'foo',
        reputation: '10525900772718',
        posting: {
            weight_threshold: 1,
            account_auths: [],
            key_auths: [[testKeys.foo.createPublic().toString(), 1]]
        },
        active: {
            weight_threshold: 1,
            account_auths: [],
            key_auths: [[testKeys.foo.createPublic().toString(), 1]]
        }
    },
    bar: {
        name: 'bar',
        reputation: '10525900772718',
        posting: {
            weight_threshold: 1,
            account_auths: [],
            key_auths: [[testKeys.bar.createPublic().toString(), 1]]
        },
        active: {
            weight_threshold: 1,
            account_auths: [],
            key_auths: [[testKeys.foo.createPublic().toString(), 1]]
        }
    },
    // Avatar only in legacy json_metadata; posting_json_metadata is a non-`profile`
    // object (so bridge.get_profile returns an empty avatar). Recoverable via fallback.
    legacyonly: {
        name: 'legacyonly',
        active: '2024-01-01T00:00:00',
        posting_json_metadata: '{"combflow":{"voteFloor":50}}',
        json_metadata: '{"profile":{"profile_image":"https://cdn.steemitimages.com/legacy/Kozmos.jpg","cover_image":"https://cdn.steemitimages.com/legacy/cover.jpg","location":"Tirana"}}',
    },
    // posting_json_metadata.profile exists with a cover but NO avatar; avatar lives in
    // json_metadata. Field-level fallback must keep the posting cover and recover the
    // json_metadata avatar.
    splitprofile: {
        name: 'splitprofile',
        active: '2024-01-01T00:00:00',
        posting_json_metadata: '{"profile":{"cover_image":"https://files.peakd.com/posting/cover.jpg","version":2}}',
        json_metadata: '{"profile":{"profile_image":"https://files.steempeak.com/legacy/avatar.jpg"}}',
    },
    // Avatar wiped from BOTH fields (pin-clobber). Nothing to recover.
    noavatar: {
        name: 'noavatar',
        active: '2024-01-01T00:00:00',
        posting_json_metadata: '{"profile":{"pinned":"some-permlink","version":2}}',
        json_metadata: '',
    }
}

/**
 * `.invalid` is reserved by RFC 2606 and guaranteed never to resolve, so these
 * fetches fail immediately and the whole mirror chain ends in the default image.
 * Deterministic without depending on a remote host 404ing, and with no port to
 * collide with a listener that happens to exist on the machine running the tests.
 */
export const BROKEN_AVATAR_URL = 'http://no-such-host.invalid/missing-avatar.jpg'
export const BROKEN_COVER_URL = 'http://no-such-host.invalid/missing-cover.jpg'

export const mockProfiles: any = {
    foo: {
        name: 'foo',
        active: '2024-01-01T00:00:00',
        created: '2016-01-01T00:00:00',
        id: 1,
        post_count: 100,
        reputation: 65,
        blacklists: [],
        stats: { followers: 100, following: 50, rank: 0 },
        metadata: {
            profile: {
                name: 'Foo User',
                about: 'Test account',
                profile_image: 'https://example.com/avatar.jpg',
                cover_image: 'https://example.com/cover.jpg',
            }
        }
    },
    bar: {
        name: 'bar',
        active: '2024-01-01T00:00:00',
        created: '2016-01-01T00:00:00',
        id: 2,
        post_count: 50,
        reputation: 25,
        blacklists: [],
        stats: { followers: 10, following: 5, rank: 0 },
        metadata: {
            profile: {
                name: 'Bar User',
                profile_image: 'https://example.com/bar-avatar.jpg',
            }
        }
    },
    // bridge returns an empty avatar/cover — these live only in legacy json_metadata.
    legacyonly: {
        name: 'legacyonly',
        active: '2024-01-01T00:00:00',
        created: '2016-01-01T00:00:00',
        id: 3,
        post_count: 10,
        reputation: 40,
        blacklists: [],
        stats: { followers: 5, following: 5, rank: 0 },
        metadata: { profile: { name: '', profile_image: '', cover_image: '' } }
    },
    // bridge surfaces the posting cover but no avatar.
    splitprofile: {
        name: 'splitprofile',
        active: '2024-01-01T00:00:00',
        created: '2016-01-01T00:00:00',
        id: 4,
        post_count: 10,
        reputation: 40,
        blacklists: [],
        stats: { followers: 5, following: 5, rank: 0 },
        metadata: { profile: { name: 'Split', profile_image: '', cover_image: 'https://files.peakd.com/posting/cover.jpg' } }
    },
    // bridge empty and nothing recoverable on chain.
    noavatar: {
        name: 'noavatar',
        active: '2024-01-01T00:00:00',
        created: '2016-01-01T00:00:00',
        id: 5,
        post_count: 10,
        reputation: 40,
        blacklists: [],
        stats: { followers: 5, following: 5, rank: 0 },
        metadata: { profile: { name: '', profile_image: '', cover_image: '' } }
    },
    // Avatar and cover both point at an unreachable host, so every fetch ends in
    // the default image. Used to prove fallback bytes are never persisted under
    // the user's key.
    brokenimages: {
        name: 'brokenimages',
        active: '2024-01-01T00:00:00',
        created: '2016-01-01T00:00:00',
        id: 10,
        post_count: 1,
        reputation: 25,
        blacklists: [],
        stats: { followers: 0, following: 0, rank: 0 },
        metadata: { profile: {
            name: 'Broken',
            profile_image: BROKEN_AVATAR_URL,
            cover_image: BROKEN_COVER_URL,
        } }
    },
    // bridge returns an empty avatar; deliberately has NO mockAccounts entry so
    // condenser_api.get_accounts resolves to [undefined] — simulating a transient
    // get_accounts failure during the fallback.
    ghostbridge: {
        name: 'ghostbridge',
        active: '2024-01-01T00:00:00',
        created: '2016-01-01T00:00:00',
        id: 9,
        post_count: 1,
        reputation: 25,
        blacklists: [],
        stats: { followers: 0, following: 0, rank: 0 },
        metadata: { profile: { name: '', profile_image: '', cover_image: '' } }
    }
}

before(() => {
    // mock out hive rpc calls
    rpc.call = async (method: string, params: any = []) => {
        switch (method) {
            case 'condenser_api.get_accounts': {
                const names = (params as string[][])[0]
                assert.equal(names.length, 1, 'can only mock single account lookups')
                const account = mockAccounts[names[0]]
                // Return a fresh copy each call, like a real RPC response.
                return [account ? structuredClone(account) : account]
            }
            case 'bridge.get_profile': {
                const username = (params as any).account || (params as any[])[0]
                const profile = mockProfiles[username]
                // Fresh copy so consumers that mutate the profile don't corrupt the fixture.
                return profile ? structuredClone(profile) : null
            }
            default:
                throw new Error(`No mock data for: ${ method }`)
        }
    }
})

after(() => {
    rpc.call = async () => {
        throw new Error('RPC CALL AFTER UNIT TESTS')
    }
})
