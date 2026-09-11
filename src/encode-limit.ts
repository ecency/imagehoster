import config from 'config'
import os from 'os'

/**
 * Bounds how many Sharp encodes run concurrently in this worker.
 *
 * Sharp's async work runs on the libuv threadpool — the SAME pool Node uses for
 * `fs` reads, `dns.lookup` and zlib. libuv sizes that pool from UV_THREADPOOL_SIZE
 * once per process and defaults to 4. An AVIF encode occupies a slot for seconds,
 * so with encodes unbounded two things go wrong:
 *
 *   1. Cheap work starves. Serving an already-converted variant is just a file
 *      read, but it queues behind multi-second encodes. Measured on a loaded
 *      box: a 32KB cached variant took 0.46-8.08s to serve while the pure-JS
 *      healthcheck answered in 2ms — the event loop was fine, the pool was full.
 *      A DNS lookup for a dead mirror holds a slot for the resolver timeout too.
 *   2. The CPU oversubscribes. More simultaneous encodes than cores does not
 *      increase throughput, it just makes every encode slower.
 *
 * Capping concurrency keeps slots free for the cheap reads that make up most
 * requests, and lets each encode finish sooner. The two purposes have different
 * inputs: the CPU bound comes from cores per worker, the starvation bound from
 * the pool size. The limit honours both: it is the CPU figure, capped so that
 * RESERVED_POOL_SLOTS of the pool can never be taken by encodes. Without the cap,
 * lowering num_workers raised the per-worker limit until it consumed the whole
 * default pool, recreating the starvation the file exists to prevent. The image
 * sets UV_THREADPOOL_SIZE well above the default so the cap does not normally
 * engage; app.ts logs the resulting budget at boot and warns when it does.
 *
 * NOTE: this limit is per worker process. Service-wide concurrency is
 * `max_concurrent_encodes * num_workers`.
 */

const CONFIG_KEY = 'max_concurrent_encodes'

/** libuv's compiled-in default and ceiling for the threadpool. */
export const LIBUV_DEFAULT_THREADPOOL_SIZE = 4
export const LIBUV_MAX_THREADPOOL_SIZE = 1024
/** Pool slots encodes may never take, kept for file reads, DNS and zlib. */
export const RESERVED_POOL_SLOTS = 2

/**
 * The libuv threadpool size this process runs with, derived the way libuv does
 * it (src/threadpool.c): `atoi()` of UV_THREADPOOL_SIZE when set, so a value
 * that is not a number reads as 0 and becomes ONE thread, and a negative value
 * wraps to the 1024 ceiling. Modelling those edges here is what lets the boot
 * log say what the process actually got rather than what was intended.
 */
export function libuvThreadpoolSize(env: NodeJS.ProcessEnv = process.env): number {
    const raw = env.UV_THREADPOOL_SIZE
    if (raw === undefined) { return LIBUV_DEFAULT_THREADPOOL_SIZE }
    const parsed = Number.parseInt(raw, 10)
    const asAtoi = Number.isFinite(parsed) ? parsed : 0
    if (asAtoi < 0) { return LIBUV_MAX_THREADPOOL_SIZE }
    if (asAtoi === 0) { return 1 }
    return Math.min(asAtoi, LIBUV_MAX_THREADPOOL_SIZE)
}

/**
 * The pool arithmetic for one worker. `freeSlots` is what GATED encodes can never
 * occupy. Encodes below ENCODE_GATE_MIN_PIXELS and blur placeholders bypass the
 * gate by design (they take 10-20ms and would otherwise queue behind full-size
 * encodes, see runEncode), so a burst of them can briefly borrow from the free
 * slots; that is bounded by their duration, not by this accounting, and is one
 * of the reasons the image sizes the pool well above the default.
 */
export interface EncodeBudget {
    /** libuv threadpool slots in this process */
    poolSize: number
    /** what the CPU rule (or explicit config) asked for */
    requested: number
    /** the limit actually enforced */
    limit: number
    /** pool slots gated encodes can never occupy */
    freeSlots: number
    /** true when the pool, not the CPU rule, decided the limit */
    cappedByPool: boolean
}

export function resolveEncodeBudget(input: {
    cpus?: number
    numWorkers?: number
    configured?: number
    poolSize?: number
} = {}): EncodeBudget {
    const cpus = input.cpus !== undefined ? input.cpus : os.cpus().length
    const poolSize = input.poolSize !== undefined ? input.poolSize : libuvThreadpoolSize()

    let requested: number | undefined
    const configured = input.configured !== undefined
        ? input.configured
        : (config.has(CONFIG_KEY) ? Number.parseInt(config.get(CONFIG_KEY) as string, 10) : undefined)
    if (configured !== undefined && Number.isFinite(configured) && configured > 0) {
        requested = configured
    } else {
        // Default: divide the machine across the workers that will compete for it,
        // so the service-wide total lands near the core count rather than a multiple
        // of it. Workers are what app.ts will actually fork (0 = autodetect).
        let numWorkers = input.numWorkers !== undefined
            ? input.numWorkers
            : Number.parseInt(config.get('num_workers') as string, 10)
        if (!Number.isFinite(numWorkers) || numWorkers <= 0) { numWorkers = cpus }
        requested = Math.max(1, Math.floor(cpus / numWorkers))
    }

    const poolCap = Math.max(1, poolSize - RESERVED_POOL_SLOTS)
    const limit = Math.min(requested, poolCap)
    return {
        poolSize,
        requested,
        limit,
        freeSlots: poolSize - limit,
        cappedByPool: limit < requested,
    }
}

const BUDGET = resolveEncodeBudget()
const LIMIT = BUDGET.limit

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
 *
 * The signal covers everything up to the moment work STARTS: already aborted at
 * the door, aborted while queued, and aborted in the hand-off. It does not, and
 * cannot, abandon an encode already running. Measured on the sharp/libvips this
 * repo pins (0.33.5 / 8.15.3), calling `.destroy()` on the instance 402ms into a
 * 7.0s encode changed nothing: the promise RESOLVED with the full buffer at
 * 6,987ms, having burnt 7.1s of CPU. There is no cancellation to propagate, so
 * do not add an abort listener here expecting one.
 *
 * That is also why the slot is held to the end rather than released on abort.
 * The native encode keeps its libuv threadpool thread whether or not anyone is
 * still waiting for the result, so releasing early would admit another encode
 * against a thread that is still busy and oversubscribe the pool — the exact
 * starvation RESERVED_POOL_SLOTS exists to prevent. Wasted work is bounded at
 * the other end instead, by not admitting an encode too big to finish quickly
 * (see MAX_ANIMATED_OUTPUT_PIXELS_WEBP / _GIF and the size gate below).
 */
export async function withEncodeSlot<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await acquire(signal)
    // The slot is ours, but a queued client can go away in the moment between the
    // hand-off and this line resuming: `grant()` drops the abort listener, so
    // nothing else would notice, and the encode would run for a closed socket.
    // Checking here is what makes the contract exact — a slot is never SPENT on
    // work for a client that has already gone.
    if (signal && signal.aborted) {
        release()
        throw abortedError()
    }
    try {
        return await fn()
    } finally {
        release()
    }
}

/**
 * Output area below which an encode runs ungated.
 *
 * Encode cost scales steeply with output size. Measured at effort 3: a 64px
 * avatar is ~13ms and a 128px ~19ms, against ~578ms for a full 1280 proxy image
 * — roughly 30-45x cheaper. Sending that 13ms of work through a one-slot queue
 * made it wait behind multi-second full-size encodes, so cold avatars went from
 * milliseconds to seconds while cached ones stayed fast. The queue exists to
 * stop expensive encodes starving cheap disk reads; it should not make cheap
 * encodes starve behind expensive ones instead.
 *
 * 256x256 sits between the measured-cheap sizes (64/128, <=20ms) and the ones
 * worth gating (512 at ~170ms, 1280 at ~578ms).
 */
export const ENCODE_GATE_MIN_PIXELS = 256 * 256

/** Whether an encode for this output target is expensive enough to queue. */
export function encodeNeedsSlot(
    target: {width?: number, height?: number, blur?: boolean, animated?: boolean},
): boolean {
    // Blur placeholders are ~20px LQIP thumbnails regardless of the requested size.
    if (target.blur) { return false }
    // An animated encode decodes and re-encodes every frame, so the size-based
    // cheapness rule below does not hold for it: a 150x150 thumbnail of a 40-frame
    // GIF is hundreds of milliseconds, not the ~13ms a still of that size costs.
    // Feed thumbnails are exactly the sizes that would otherwise bypass the gate.
    if (target.animated) { return true }
    const {width, height} = target
    // An unspecified target means "no resize" — it could be the full original, so gate it.
    if (!width || !height) { return true }
    return width * height >= ENCODE_GATE_MIN_PIXELS
}

/**
 * Runs an encode, queueing it only when it is expensive enough to be worth
 * gating. Prefer this over calling withEncodeSlot directly at request paths so
 * the cheap/expensive decision stays in one place.
 */
export async function runEncode<T>(
    fn: () => Promise<T>,
    target: {width?: number, height?: number, blur?: boolean, animated?: boolean},
    signal: AbortSignal | undefined,
): Promise<T> {
    // Check for a client that already left before either path. withEncodeSlot
    // does this when it queues, but the bypass calls fn() directly — without this
    // a cheap encode for a disconnected client would still run Sharp and cache a
    // result nobody will read, which the gated path already avoids.
    if (signal && signal.aborted) { throw abortedError() }
    if (!encodeNeedsSlot(target)) { return fn() }
    return withEncodeSlot(fn, signal)
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

/** The budget this worker booted with, for the startup log. */
export function encodeBudget(): EncodeBudget {
    return BUDGET
}
