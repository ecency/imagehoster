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

export const ENCODE_ABORTED = 'EncodeAborted'

/** True when an encode was dropped because its client went away, not because Sharp failed. */
export function isEncodeAborted(err: any): boolean {
    return !!err && err.name === ENCODE_ABORTED
}

function abortedError(): Error {
    const err = new Error('encode abandoned: client disconnected while queued')
    err.name = ENCODE_ABORTED
    return err
}

interface Waiter {
    settled: boolean
    grant: () => void
}

let active = 0
const waiting: Waiter[] = []

function acquire(signal?: AbortSignal): Promise<void> {
    if (signal && signal.aborted) { return Promise.reject(abortedError()) }
    if (active < LIMIT) {
        active++
        return Promise.resolve()
    }
    return new Promise<void>((resolve, reject) => {
        const waiter: Waiter = {settled: false, grant: () => undefined}
        const onAbort = () => {
            if (waiter.settled) { return }
            waiter.settled = true
            const idx = waiting.indexOf(waiter)
            if (idx >= 0) { waiting.splice(idx, 1) }
            reject(abortedError())
        }
        waiter.grant = () => {
            if (waiter.settled) { return }
            waiter.settled = true
            if (signal) { signal.removeEventListener('abort', onAbort) }
            resolve()
        }
        waiting.push(waiter)
        if (signal) { signal.addEventListener('abort', onAbort, {once: true}) }
    })
}

function release(): void {
    // Hand the slot straight to a waiter without dropping `active`. If we
    // decremented and let the waiter re-increment, a caller arriving in the gap
    // (the waiter resumes on a microtask) would see a free slot and take it too,
    // putting us over the limit. Skip waiters that already aborted.
    while (waiting.length > 0) {
        const next = waiting.shift() as Waiter
        if (!next.settled) {
            next.grant()
            return
        }
    }
    active--
}

/**
 * Runs `fn` once a slot is free. Keep the wrapped region as small as possible —
 * ideally the single encode call — so a slot is never held across other awaits,
 * and so a gated call can never nest inside another (which would deadlock at
 * low limits).
 *
 * Pass `signal` so a request whose client has already gone away drops out of the
 * queue instead of claiming a slot to build a response nobody will read. That
 * matters under load: the cache in front of us gives up long before a deep queue
 * drains, so without it the queue fills with work for dead sockets while live
 * requests wait behind it.
 */
export async function withEncodeSlot<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await acquire(signal)
    try {
        return await fn()
    } finally {
        release()
    }
}

/**
 * AbortSignal that fires if the connection closes before the response was fully
 * written — i.e. the client, or the cache in front of us, gave up waiting.
 */
export function clientGoneSignal(ctx: any): AbortSignal | undefined {
    const res = ctx && ctx.res
    if (!res || typeof res.once !== 'function') { return undefined }
    const controller = new AbortController()
    res.once('close', () => {
        if (!res.writableEnded) { controller.abort() }
    })
    return controller.signal
}

/** Exposed for tests and diagnostics. */
export function encodeLimitStats() {
    return { limit: LIMIT, active, queued: waiting.length }
}
