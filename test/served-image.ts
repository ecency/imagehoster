import 'mocha'
import assert from 'assert'
import etag from 'etag'

import {proxyStore} from './../src/common'
import {
    cacheControlFor, derive, etagFor, FALLBACK_CACHE_CONTROL, fallbackEtag, fallbackImage, isFallbackImage,
    PASSTHROUGH_CACHE_CONTROL, passthroughEtag, passthroughImage, realImage, storeImage, worstOf,
} from './../src/served-image'
import {storeExists, storeRemove} from './../src/utils'

describe('served image', function() {
    const real = realImage(Buffer.from('real'))
    const placeholder = fallbackImage(Buffer.from('placeholder'), 'test')

    it('keeps provenance through a render', function() {
        assert.equal(derive(real, Buffer.from('rendered')).kind, 'real')
        const rendered = derive(placeholder, Buffer.from('rendered'))
        assert(isFallbackImage(rendered))
        assert.equal(rendered.reason, 'test')
        assert.equal(derive(placeholder, Buffer.alloc(0), 'sharper').kind === 'fallback'
            && (derive(placeholder, Buffer.alloc(0), 'sharper') as any).reason, 'sharper')
    })

    it('treats a real fetch inside a substituted request as a placeholder', function() {
        assert.equal(worstOf(real, undefined).kind, 'real')
        const substituted = worstOf(real, fallbackImage(null, 'blocked'))
        assert(isFallbackImage(substituted))
        assert.equal(substituted.reason, 'blocked')
        assert.equal(substituted.bytes, real.bytes, 'the bytes are the ones fetched')
    })

    it('derives the cache policy from the value', function() {
        assert.equal(cacheControlFor(real, 'public,max-age=31536000,immutable'), 'public,max-age=31536000,immutable')
        assert.equal(cacheControlFor(placeholder, 'public,max-age=31536000,immutable'), FALLBACK_CACHE_CONTROL)
        assert.equal(FALLBACK_CACHE_CONTROL, 'public,max-age=120')
    })

    it('never gives a placeholder the real ETag', function() {
        const key = 'Uabc_100x0_fit_match'
        assert.equal(etagFor(real, key), etag(key))
        assert.equal(etagFor(placeholder, key), fallbackEtag(key))
        assert.notEqual(etagFor(placeholder, key), etagFor(real, key))
        assert.equal(etagFor(placeholder, key), etagFor(fallbackImage(Buffer.alloc(0), 'other reason'), key),
            'deterministic across reasons, so a placeholder revalidates as a placeholder')
    })

    it('treats a passthrough as real content that is not the variant', function() {
        const through = passthroughImage(Buffer.from('original'), 'sharp failed')
        const key = 'Uabc_100x0_fit_match'
        assert.equal(derive(through, Buffer.alloc(0)).kind, 'passthrough')
        // genuine content but a degraded answer: an hour, not the variant's year
        assert.equal(cacheControlFor(through, 'public,max-age=31536000,immutable'), PASSTHROUGH_CACHE_CONTROL)
        assert.equal(PASSTHROUGH_CACHE_CONTROL, 'public,max-age=3600')
        // but its own validator, or a client holding it would be told "not modified" by the real variant later
        assert.equal(etagFor(through, key), passthroughEtag(key))
        assert.notEqual(etagFor(through, key), etagFor(real, key))
        assert.notEqual(etagFor(through, key), etagFor(placeholder, key))
    })

    it('refuses to persist a placeholder or a passthrough and persists a real image', async function() {
        const key = `served-image-test-${ Date.now() }`
        try {
            assert.equal(await storeImage(proxyStore, key, placeholder), false)
            assert.equal(await storeExists(proxyStore, key), false, 'a placeholder must never reach the store')
            assert.equal(await storeImage(proxyStore, key, passthroughImage(Buffer.from('x'), 'test')), false)
            assert.equal(await storeExists(proxyStore, key), false, 'a passthrough must never reach the store')
            assert.equal(await storeImage(proxyStore, key, real), true)
            assert.equal(await storeExists(proxyStore, key), true)
        } finally {
            try { await storeRemove(proxyStore, key) } catch (_e) { /* may not exist */ }
        }
    })
})
