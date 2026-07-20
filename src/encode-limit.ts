import config from 'config'
import os from 'os'

/**
 * Bounds how many Sharp encodes run concurrently in this worker.
 *
 * Sharp's async work runs on the libuv threadpool — the SAME pool Node uses for
 * `fs` reads. That pool defaults to 4 slots per process. An AVIF encode occupies
 * a slot for seconds, so with encodes unbounded two things go wrong:
 *
 *   1. Cheap work starves. Serving an already-converted variant is just a file
 *      read, but it queues behind multi-second encodes. Measured on a loaded
 *      box: a 32KB cached variant took 0.46-8.08s to serve while the pure-JS
 *      healthcheck answered in 2ms — the event loop was fine, the pool was full.
 *   2. The CPU oversubscribes. More simultaneous encodes than cores does not
 *      increase throughput, it just makes every encode slower.
 *
 * Capping concurrency keeps slots free for the cheap reads that make up most
 * requests, and lets each encode finish sooner.
 *
 * NOTE: this limit is per worker process. Service-wide concurrency is
 * `max_concurrent_encodes * num_workers`.
 */

const CONFIG_KEY = 'max_concurrent_encodes'

function resolveLimit(): number {
    if (config.has(CONFIG_KEY)) {
        const configured = Number.parseInt(config.get(CONFIG_KEY) as string, 10)
        if (Number.isFinite(configured) && configured > 0) { return configured }
    }
    // Default: divide the machine across the workers that will compete for it,
    // so the service-wide total lands near the core count rather than a multiple
    // of it. Workers are what app.ts will actually fork (0 = autodetect).
    let numWorkers = Number.parseInt(config.get('num_workers') as string, 10)
    if (!Number.isFinite(numWorkers) || numWorkers <= 0) { numWorkers = os.cpus().length }
    return Math.max(1, Math.floor(os.cpus().length / numWorkers))
}

const LIMIT = resolveLimit()

let active = 0
const waiting: Array<() => void> = []

/**
 * Runs `fn` once a slot is free. Keep the wrapped region as small as possible —
 * ideally the single encode call — so a slot is never held across other awaits,
 * and so a gated call can never nest inside another (which would deadlock at
 * low limits).
 */
function acquire(): Promise<void> {
    if (active < LIMIT) {
        active++
        return Promise.resolve()
    }
    return new Promise<void>((resolve) => { waiting.push(resolve) })
}

function release(): void {
    const next = waiting.shift()
    if (next) {
        // Hand the slot straight to the waiter without dropping `active`. If we
        // decremented and let the waiter re-increment, a caller arriving in the
        // gap (the waiter resumes on a microtask) would see a free slot and take
        // it too, putting us over the limit.
        next()
    } else {
        active--
    }
}

export async function withEncodeSlot<T>(fn: () => Promise<T>): Promise<T> {
    await acquire()
    try {
        return await fn()
    } finally {
        release()
    }
}

/** Exposed for tests and diagnostics. */
export function encodeLimitStats() {
    return { limit: LIMIT, active, queued: waiting.length }
}
