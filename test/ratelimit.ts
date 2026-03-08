import 'mocha'
import assert from 'assert'

import * as common from './../src/common'

/** Build a mock Redis multi chain that simulates sorted-set rate limiting. */
function createMockRedis(state: { count: number; oldest?: string; rangeEntry?: string }) {
    const multiChain = {
        zRemRangeByScore: () => multiChain,
        zCard: () => multiChain,
        zAdd: () => multiChain,
        zRange: () => multiChain,
        zRemRangeByRank: () => multiChain,
        pExpire: () => multiChain,
        exec: async () => [
            0,                                              // [0] zRemRangeByScore result
            1,                                              // [1] zAdd result
            state.count,                                    // [2] zCard result (post-add)
            state.oldest ? [state.oldest] : [],             // [3] zRange 0 0
            state.rangeEntry ? [state.rangeEntry] : [],     // [4] zRange -max -max
            0,                                              // [5] zRemRangeByRank
            true,                                           // [6] pExpire
        ],
    }

    return {
        isReady: true,
        multi: () => multiChain,
    }
}

describe('rate limiter', function() {

    // Save and restore original redisClient
    let originalClient: any
    let originalReady: any

    before(() => {
        originalClient = common.redisClient
        originalReady = common.redisReady
    })

    afterEach(() => {
        (common as any).redisClient = originalClient;
        (common as any).redisReady = originalReady
    })

    it('should return remaining quota when under limit', async function() {
        (common as any).redisClient = createMockRedis({ count: 3 });
        (common as any).redisReady = Promise.resolve()

        const result = await common.getRatelimit('testuser', 10, 604800000)
        assert.equal(result.remaining, 7)
        assert.equal(result.total, 10)
    })

    it('should return 0 remaining when at limit', async function() {
        (common as any).redisClient = createMockRedis({ count: 10 });
        (common as any).redisReady = Promise.resolve()

        const result = await common.getRatelimit('testuser', 10, 604800000)
        assert.equal(result.remaining, 0)
        assert.equal(result.total, 10)
    })

    it('should return 0 remaining when over limit', async function() {
        (common as any).redisClient = createMockRedis({ count: 15 });
        (common as any).redisReady = Promise.resolve()

        const result = await common.getRatelimit('testuser', 10, 604800000)
        assert.equal(result.remaining, 0)
        assert.equal(result.total, 10)
    })

    it('should compute reset time from oldest entry', async function() {
        const now = Date.now() * 1000
        const oldest = String(now - 100000000); // 100 seconds ago in microseconds
        (common as any).redisClient = createMockRedis({ count: 5, oldest });
        (common as any).redisReady = Promise.resolve()

        const result = await common.getRatelimit('testuser', 10, 604800000)
        assert(result.reset > 0, 'reset should be positive')
        assert(typeof result.reset === 'number')
    })

    it('should compute reset from rangeEntry when available', async function() {
        const now = Date.now() * 1000
        const rangeEntry = String(now - 50000000)
        const oldest = String(now - 100000000);
        (common as any).redisClient = createMockRedis({ count: 10, oldest, rangeEntry });
        (common as any).redisReady = Promise.resolve()

        const result = await common.getRatelimit('testuser', 10, 604800000)
        assert(result.reset > 0)
    })

    it('should throw when redis is not configured', async function() {
        (common as any).redisClient = undefined;
        (common as any).redisReady = undefined

        try {
            await common.getRatelimit('testuser', 10, 604800000)
            assert.fail('should have thrown')
        } catch (err: any) {
            assert.equal(err.message, 'Redis not configured')
        }
    })

    it('should throw when redis is not connected', async function() {
        (common as any).redisClient = { isReady: false };
        (common as any).redisReady = Promise.resolve()

        try {
            await common.getRatelimit('testuser', 10, 604800000)
            assert.fail('should have thrown')
        } catch (err: any) {
            assert.equal(err.message, 'Redis not connected')
        }
    })

    it('should await redisReady before proceeding', async function() {
        let readyResolved = false;
        (common as any).redisClient = createMockRedis({ count: 0 });
        (common as any).redisReady = new Promise<void>((resolve) => {
            setTimeout(() => { readyResolved = true; resolve() }, 50)
        })

        const result = await common.getRatelimit('testuser', 10, 604800000)
        assert.equal(readyResolved, true, 'should have awaited redisReady')
        assert.equal(result.remaining, 10)
    })

    it('should handle empty zRange results gracefully', async function() {
        // No oldest entry (empty sorted set before our add)
        (common as any).redisClient = createMockRedis({ count: 0 });
        (common as any).redisReady = Promise.resolve()

        const result = await common.getRatelimit('testuser', 10, 604800000)
        assert.equal(result.remaining, 10)
        assert(result.reset > 0, 'reset should still be computed')
    })

    it('should propagate redis multi exec errors', async function() {
        const errorClient = {
            isReady: true,
            multi: () => ({
                zRemRangeByScore: () => errorClient.multi(),
                zCard: () => errorClient.multi(),
                zAdd: () => errorClient.multi(),
                zRange: () => errorClient.multi(),
                zRemRangeByRank: () => errorClient.multi(),
                pExpire: () => errorClient.multi(),
                exec: async () => { throw new Error('REDIS EXEC FAILED') },
            }),
        };
        (common as any).redisClient = errorClient;
        (common as any).redisReady = Promise.resolve()

        try {
            await common.getRatelimit('testuser', 10, 604800000)
            assert.fail('should have thrown')
        } catch (err: any) {
            assert.equal(err.message, 'REDIS EXEC FAILED')
        }
    })
})
