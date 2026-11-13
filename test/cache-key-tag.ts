import 'mocha'
import assert from 'assert'

import {acceptBucket} from './../src/cache-key-tag'

describe('acceptBucket', function() {
    it('files each Accept the way the origin negotiates it', function() {
        assert.equal(acceptBucket('image/avif,image/webp,image/apng,*/*;q=0.8'), 'avif')
        assert.equal(acceptBucket('image/webp,image/apng,image/*,*/*;q=0.8'), 'webp')
        assert.equal(acceptBucket('image/jpeg,image/png,image/*;q=0.8'), '0')
        assert.equal(acceptBucket('*/*'), '0')
        assert.equal(acceptBucket(''), '0')
    })

    it('reads media types case-insensitively and honours q=0', function() {
        assert.equal(acceptBucket('IMAGE/AVIF,*/*'), 'avif')
        assert.equal(acceptBucket('image/avif;q=0,image/webp'), 'webp')
        assert.equal(acceptBucket('image/avif;q=0,image/webp;q=0,*/*'), '0')
    })
})
