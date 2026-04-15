import 'mocha'
import assert from 'assert'
import {PrivateKey} from '@ecency/hive-tx'

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
    }
}

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
    }
}

before(() => {
    // mock out hive rpc calls
    rpc.call = async (method: string, params: any = []) => {
        switch (method) {
            case 'condenser_api.get_accounts': {
                const names = (params as string[][])[0]
                assert.equal(names.length, 1, 'can only mock single account lookups')
                return [mockAccounts[names[0]]]
            }
            case 'bridge.get_profile': {
                const username = (params as any).account || (params as any[])[0]
                return mockProfiles[username] || null
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
