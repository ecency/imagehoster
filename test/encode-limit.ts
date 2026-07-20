import 'mocha'
import assert from 'assert'

import {encodeLimitStats, withEncodeSlot} from './../src/encode-limit'

describe('encode concurrency limit', function() {

    const {limit} = encodeLimitStats()

    const deferred = () => {
        let release!: () => void
        const promise = new Promise<void>((resolve) => { release = resolve })
        return {promise, release}
    }

    it('resolves to a positive limit', function() {
        assert(limit >= 1, `limit should be at least 1, got ${ limit }`)
    })

    it('never runs more than the limit at once', async function() {
        let running = 0
        let peak = 0
        const gates = Array.from({length: limit + 4}, deferred)

        const tasks = gates.map((g) => withEncodeSlot(async () => {
            running++
            peak = Math.max(peak, running)
            await g.promise
            running--
        }))

        // Let everything that can start, start; then release one at a time so a
        // fresh slot is always contended for.
        await new Promise((resolve) => setImmediate(resolve))
        for (const g of gates) {
            g.release()
            await new Promise((resolve) => setImmediate(resolve))
        }
        await Promise.all(tasks)

        assert.equal(peak, limit, `peak concurrency ${ peak } should equal limit ${ limit }`)
        assert.equal(encodeLimitStats().active, 0, 'all slots should be released')
        assert.equal(encodeLimitStats().queued, 0, 'queue should drain')
    })

    it('releases the slot when the work throws', async function() {
        await assert.rejects(withEncodeSlot(async () => { throw new Error('boom') }), /boom/)
        assert.equal(encodeLimitStats().active, 0, 'a thrown error must not leak a slot')

        // The slot is reusable afterwards
        const rv = await withEncodeSlot(async () => 'ok')
        assert.equal(rv, 'ok')
        assert.equal(encodeLimitStats().active, 0)
    })

    it('holds the ceiling when a caller arrives mid hand-off', async function() {
        // Regression test for a real race. If release() decrements `active` and
        // lets the queued waiter re-increment when it resumes, there is a window
        // between those two steps — they are separate microtasks — where an
        // arriving caller sees a free slot and takes it too. The waiter then
        // resumes and increments as well, putting us one over the limit.
        //
        // The window is only reachable at a specific microtask depth, so sweep
        // the delay between releasing a holder and the interloper arriving, and
        // require the ceiling to hold at every depth. With the decrement-then-
        // reacquire shape this fails at turns=2 (peak limit+1); handing the slot
        // straight to the waiter holds at every depth.
        const probe = async (turns: number): Promise<number> => {
            let running = 0
            let peak = 0
            const holders = Array.from({length: limit}, deferred)
            const held = holders.map((g) => withEncodeSlot(async () => {
                running++; peak = Math.max(peak, running); await g.promise; running--
            }))
            await new Promise((resolve) => setImmediate(resolve))

            const queued = deferred()
            const waiter = withEncodeSlot(async () => {
                running++; peak = Math.max(peak, running); await queued.promise; running--
            })

            holders[0].release()
            for (let t = 0; t < turns; t++) { await Promise.resolve() }

            // The interloper must HOLD its slot, otherwise it finishes before the
            // waiter resumes and the overlap is never observable.
            const gate = deferred()
            const interloper = withEncodeSlot(async () => {
                running++; peak = Math.max(peak, running); await gate.promise; running--
            })

            await new Promise((resolve) => setImmediate(resolve))
            queued.release(); gate.release()
            holders.slice(1).forEach((g) => g.release())
            await Promise.all([...held, waiter, interloper])
            return peak
        }

        for (let turns = 0; turns <= 6; turns++) {
            const peak = await probe(turns)
            assert(peak <= limit, `peak ${ peak } exceeded limit ${ limit } at turns=${ turns }`)
            assert.equal(encodeLimitStats().active, 0, `slots leaked at turns=${ turns }`)
            assert.equal(encodeLimitStats().queued, 0, `queue not drained at turns=${ turns }`)
        }
    })

    it('hands a freed slot to a waiter without exceeding the limit', async function() {
        // Fill every slot, queue one more, then release a holder. If release
        // decremented instead of handing the slot over, a caller arriving in the
        // gap could claim it too and put us over the limit.
        let running = 0
        let peak = 0
        const holders = Array.from({length: limit}, deferred)

        const held = holders.map((g) => withEncodeSlot(async () => {
            running++; peak = Math.max(peak, running)
            await g.promise
            running--
        }))
        await new Promise((resolve) => setImmediate(resolve))
        assert.equal(encodeLimitStats().active, limit, 'all slots should be taken')

        const queued = deferred()
        const waiter = withEncodeSlot(async () => {
            running++; peak = Math.max(peak, running)
            await queued.promise
            running--
        })
        assert.equal(encodeLimitStats().queued, 1, 'the extra call should be queued')

        holders[0].release()
        const interloper = withEncodeSlot(async () => {
            running++; peak = Math.max(peak, running)
            running--
        })

        await new Promise((resolve) => setImmediate(resolve))
        queued.release()
        holders.slice(1).forEach((g) => g.release())
        await Promise.all([...held, waiter, interloper])

        assert.equal(peak, limit, `peak ${ peak } must not exceed limit ${ limit }`)
        assert.equal(encodeLimitStats().active, 0)
        assert.equal(encodeLimitStats().queued, 0)
    })
})
