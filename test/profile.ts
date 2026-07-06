import 'mocha'
import assert from 'assert'

import {getProfile, rpc} from './../src/common'
import {mockProfiles} from './index'

// bridge returns a valid profile object but with an empty avatar; the account is not
// in mockAccounts, so condenser_api.get_accounts resolves to [undefined] — simulating a
// transient get_accounts failure during the fallback.
mockProfiles.ghostbridge = {
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

/** Run `fn` while counting the RPC methods invoked, then restore the mock. */
async function countingRpc<T>(fn: () => Promise<T>): Promise<{ result: T, methods: string[] }> {
    const orig = rpc.call
    const methods: string[] = []
    rpc.call = async (method: string, params?: any) => {
        methods.push(method)
        return orig(method, params)
    }
    try {
        const result = await fn()
        return { result, methods }
    } finally {
        rpc.call = orig
    }
}

describe('getProfile legacy json_metadata fallback', () => {

    it('recovers an avatar stored only in json_metadata (posting has no profile)', async () => {
        const p = await getProfile('legacyonly', false)
        assert(p, 'profile should be defined')
        assert.equal(p!.metadata.profile.profile_image, 'https://cdn.steemitimages.com/legacy/Kozmos.jpg')
        // cover is recovered from the same json_metadata in the one lookup
        assert.equal(p!.metadata.profile.cover_image, 'https://cdn.steemitimages.com/legacy/cover.jpg')
    })

    it('recovers the json_metadata avatar but keeps the posting cover (field-level)', async () => {
        const p = await getProfile('splitprofile', false)
        assert(p)
        assert.equal(p!.metadata.profile.profile_image, 'https://files.steempeak.com/legacy/avatar.jpg')
        // bridge already surfaced the posting cover — it must NOT be overwritten
        assert.equal(p!.metadata.profile.cover_image, 'https://files.peakd.com/posting/cover.jpg')
    })

    it('leaves the avatar empty when it is absent from both metadata fields', async () => {
        const p = await getProfile('noavatar', false)
        assert(p)
        assert.equal(p!.metadata.profile.profile_image, '')
    })

    it('does not fetch the account for a modern profile (single RPC fast path)', async () => {
        const { result, methods } = await countingRpc(() => getProfile('foo', false))
        assert.equal(result!.metadata.profile.profile_image, 'https://example.com/avatar.jpg')
        assert.deepEqual(methods, ['bridge.get_profile'])
        assert.equal(methods.filter((m) => m === 'condenser_api.get_accounts').length, 0)
    })

    it('makes exactly one extra account lookup when the avatar is missing', async () => {
        const { methods } = await countingRpc(() => getProfile('legacyonly', false))
        assert.deepEqual(methods, ['bridge.get_profile', 'condenser_api.get_accounts'])
    })

    it('survives a get_accounts miss/failure during the fallback', async () => {
        const p = await getProfile('ghostbridge', false)
        assert(p, 'still returns the bridge profile')
        assert.equal(p!.metadata.profile.profile_image, '')
    })

    it('returns undefined for an unknown account (bridge null, no account lookup)', async () => {
        const { result, methods } = await countingRpc(() => getProfile('doesnotexist', false))
        assert.equal(result, undefined)
        assert.equal(methods.filter((m) => m === 'condenser_api.get_accounts').length, 0)
    })
})
