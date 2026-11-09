import config from 'config'
import {createHash, randomBytes, timingSafeEqual} from 'crypto'
import {isIP} from 'net'
import {KoaContext, redisClient, redisReady} from './common'
import {supportsAvif, supportsWebP} from './utils'

/**
 * Variant-walk guard for /p/ renders.
 *
 * Pages list each image as a srcset of several widths and formats. A browser
 * picks one of them per image (two if the window is resized). An automated
 * client that fetches every candidate turns one image into many fresh renders,
 * which is the most expensive thing this service does.
 *
 * The guard counts, per client address and source image, the DISTINCT variants
 * this service rendered and stored. Cache hits are answered before the guard
 * runs and are never counted. A variant is identified by what is actually
 * rendered (the negotiated output format, mode, width, height), so the same
 * query sent with different Accept headers counts once per output it produces.
 *
 *   - Up to `variant_guard_max_variants` variants render normally.
 *   - Past that, a variant of a kind the client has not had yet (format, mode
 *     and height) still renders once, up to EXTRA_KINDS more, so a reader who
 *     filled the allowance with feed thumbnails still gets the post image in
 *     the format its page asks for.
 *   - Otherwise the request is redirected to the nearest variant of this image
 *     the same client already got, in a format its Accept header takes, with
 *     the same mode and height. The target was rendered and stored, and is
 *     named with an explicit format, so it is a cache hit for this client.
 *   - Only when nothing fits is the answer a 429 with Retry-After.
 * Redirects and 429s are `no-store`, so no cache in front of the service can
 * keep them and hand them to other clients.
 *
 * A slot is reserved before the render (parallel requests for every variant
 * must not all pass a check that runs before any of them is recorded) and given
 * back when the request ends without storing the variant: a failed fetch, the
 * default image, an original passed through. Legacy-route renders are never
 * stored, so they keep their slot and are never redirected.
 *
 * Client address: CF-Connecting-IP, trusted only when the request carries the
 * edge token (`variant_guard_edge_token`, a secret the CDN adds) so a request
 * sent straight to the origin cannot spend another client's allowance. Without
 * a trusted address the guard does not apply. A ledger error or slow answer
 * lets the request through: the guard must never be the reason a real image
 * fails.
 */

const MAX_VARIANTS = configNumber('variant_guard_max_variants', 4)
const WINDOW_SECONDS = configNumber('variant_guard_window_seconds', 300)
const EDGE_TOKEN = config.has('variant_guard_edge_token') ? String(config.get('variant_guard_edge_token') || '') : ''
const EDGE_TOKEN_HEADER = 'x-edge-token'
/** New kinds of variant (format, mode, height) allowed past the limit, one render each. */
export const EXTRA_KINDS = 2
/** A slow ledger answer lets the request through rather than delaying it. */
const LEDGER_TIMEOUT_MS = 100

function configNumber(key: string, fallback: number): number {
    if (!config.has(key)) { return fallback }
    const v = Number.parseInt(config.get(key) as string, 10)
    return Number.isFinite(v) && v >= 0 ? v : fallback
}

/** A variant as rendered: the negotiated output format, not the query's. */
export interface RenderedVariant {
    format: string
    mode: string
    width?: number
    height?: number
}

export interface Reservation {
    key: string
    member: string
    /** the window generation the hold was taken in */
    gen: string
}

export type GuardDecision =
    | {action: 'allow', reservation?: Reservation}
    | {action: 'redirect', query: string}
    | {action: 'reject'}

/**
 * The client this request is counted against: the CDN's view of the
 * connecting address. An IPv6 client is keyed by its /64, which is what one
 * household or one rented exit gets (they rotate inside it freely).
 */
export function clientKeyFor(cfConnectingIp: string | undefined): string | undefined {
    const ip = (cfConnectingIp || '').trim()
    const family = isIP(ip)
    if (family === 4) { return ip }
    if (family === 6) { return ipv6Prefix64(ip) }
    return undefined
}

function ipv6Prefix64(ip: string): string {
    const zone = ip.indexOf('%')
    const addr = (zone >= 0 ? ip.slice(0, zone) : ip).toLowerCase()
    const [head, tail] = addr.split('::')
    const headGroups = head ? head.split(':') : []
    const tailGroups = tail !== undefined && tail !== '' ? tail.split(':') : []
    // An embedded IPv4 tail counts as two groups; it never reaches the first four.
    const tailLen = tailGroups.reduce((n, g) => n + (g.includes('.') ? 2 : 1), 0)
    const groups = tail === undefined
        ? headGroups
        : [...headGroups, ...new Array(Math.max(0, 8 - headGroups.length - tailLen)).fill('0'), ...tailGroups]
    return groups.slice(0, 4).map((g) => (Number.parseInt(g, 16) || 0).toString(16)).join(':') + '::/64'
}

/** True when the request came through the CDN that sets CF-Connecting-IP. */
export function hasEdgeToken(presented: string | undefined, expected: string = EDGE_TOKEN): boolean {
    if (!expected) { return true }
    if (!presented) { return false }
    const a = Buffer.from(presented)
    const b = Buffer.from(expected)
    return a.length === b.length && timingSafeEqual(a, b)
}

/** Canonical query for a variant, in the order the frontends build it. */
export function variantQuery(v: RenderedVariant): string {
    const parts = [`format=${v.format}`, `mode=${v.mode}`]
    if (v.width !== undefined) { parts.push(`width=${v.width}`) }
    if (v.height !== undefined) { parts.push(`height=${v.height}`) }
    return parts.join('&')
}

/** What a variant looks like on the page: format, crop mode and height. */
export function variantKind(v: RenderedVariant): string {
    return `${v.format}/${v.mode}/${v.height || 0}`
}

/** Ledger member: `<kind>#<query>`, so the ledger can tell kinds apart. */
export function memberFor(v: RenderedVariant): string {
    return `${variantKind(v)}#${variantQuery(v)}`
}

export function parseMember(member: string): RenderedVariant | undefined {
    const hash = member.indexOf('#')
    const params = new URLSearchParams(hash >= 0 ? member.slice(hash + 1) : member)
    const format = params.get('format')
    const mode = params.get('mode')
    if (!format || !mode) { return undefined }
    const width = params.has('width') ? Number.parseInt(params.get('width') as string, 10) : undefined
    const height = params.has('height') ? Number.parseInt(params.get('height') as string, 10) : undefined
    return {format, mode, width, height}
}

/**
 * Formats this client can be redirected to. Explicit AVIF/WebP/JPEG/PNG name
 * one stored variant whatever the Accept header says. `match` is negotiated
 * per request, so it is only a target for a client that negotiated `match`
 * itself, i.e. one that takes neither AVIF nor WebP.
 */
export function acceptableFormats(rendered: string, acceptHeader: string): Set<string> {
    const formats = new Set<string>([rendered])
    if (rendered !== 'match') {
        if (supportsAvif(acceptHeader)) { formats.add('avif') }
        if (supportsWebP(acceptHeader)) { formats.add('webp') }
    }
    return formats
}

/**
 * The already-rendered variant to send this client to instead of rendering a
 * new one: a format it takes, the same mode and height (so the crop and aspect
 * are what the page laid out), and the width nearest the one it asked for
 * (ties go to the larger, which scales down cleanly).
 */
export function pickFallback(members: string[], wanted: RenderedVariant, acceptHeader: string): string | undefined {
    const formats = acceptableFormats(wanted.format, acceptHeader)
    let best: {q: string, dist: number, width: number} | undefined
    for (const member of members) {
        const v = parseMember(member)
        if (!v) { continue }
        if (!formats.has(v.format) || v.mode !== wanted.mode || v.height !== wanted.height) { continue }
        const want = wanted.width || 0
        const have = v.width || 0
        const dist = Math.abs(have - want)
        if (!best || dist < best.dist || (dist === best.dist && have > best.width)) {
            best = {q: variantQuery(v), dist, width: have}
        }
    }
    return best ? best.q : undefined
}

/**
 * Reserves `member` in the client's set for this image when allowed. Answers
 * `{held, gen}` when allowed (`held`: the set already had it; otherwise it was
 * reserved now, under the limit or as the first of a new kind under the hard
 * cap), or the recorded members when refused. An allowed request counts as one
 * more in flight on that member.
 *
 * `gen` names the window: a set that starts afresh (none, or the last one
 * expired) clears any state left over and gets a new generation, so an earned
 * flag or in-flight count from an earlier window can never carry over, and a
 * request from an earlier window that settles late is ignored.
 *
 * `settle` ends one in-flight request of the same generation. A request that
 * stored the variant marks the member earned. The member leaves the set only
 * when the LAST request in flight on it has ended and none of them stored it,
 * so a request that fails while another is still rendering the same variant
 * cannot free the slot that the other one is about to earn.
 */
export type ReserveResult = {held: boolean, gen: string} | string[]
export interface Ledger {
    reserve(key: string, member: string, kind: string, max: number, hardMax: number, ttlSeconds: number): Promise<ReserveResult>
    settle(key: string, member: string, gen: string, stored: boolean, ttlSeconds: number): Promise<void>
}

const newGen = () => randomBytes(6).toString('base64url')

// KEYS[1] member set, KEYS[2] state hash (`g` generation, `c:<member>` in-flight
// count, `d:<member>` earned). ARGV member, kind, max, hard max, ttl, new gen.
// Answers {'held'|'added', gen} or {'refused', member...}.
const RESERVE_SCRIPT = `
local ttl = tonumber(ARGV[5])
if redis.call('EXISTS', KEYS[1]) == 0 then
  redis.call('DEL', KEYS[2])
  redis.call('HSET', KEYS[2], 'g', ARGV[6])
end
local gen = redis.call('HGET', KEYS[2], 'g')
if not gen then
  gen = ARGV[6]
  redis.call('HSET', KEYS[2], 'g', gen)
end
local function hold(status)
  redis.call('HINCRBY', KEYS[2], 'c:' .. ARGV[1], 1)
  redis.call('EXPIRE', KEYS[1], ttl)
  redis.call('EXPIRE', KEYS[2], ttl)
  return {status, gen}
end
if redis.call('SISMEMBER', KEYS[1], ARGV[1]) == 1 then return hold('held') end
local n = redis.call('SCARD', KEYS[1])
local allow = n < tonumber(ARGV[3])
local members = nil
if not allow and n < tonumber(ARGV[4]) then
  members = redis.call('SMEMBERS', KEYS[1])
  allow = true
  local prefix = ARGV[2] .. '#'
  for _, m in ipairs(members) do
    if string.sub(m, 1, #prefix) == prefix then allow = false break end
  end
end
if allow then
  redis.call('SADD', KEYS[1], ARGV[1])
  return hold('added')
end
local refused = {'refused'}
for _, m in ipairs(members or redis.call('SMEMBERS', KEYS[1])) do table.insert(refused, m) end
return refused
`

// KEYS[1] member set, KEYS[2] state hash. ARGV member, stored (0/1), ttl, gen.
// A settle from another (expired) generation changes nothing, so it can neither
// re-create state that would outlive its window nor touch a newer window.
const SETTLE_SCRIPT = `
if redis.call('HGET', KEYS[2], 'g') ~= ARGV[4] then return -1 end
local c = 'c:' .. ARGV[1]
local d = 'd:' .. ARGV[1]
if ARGV[2] == '1' then redis.call('HSET', KEYS[2], d, 1) end
local n = redis.call('HINCRBY', KEYS[2], c, -1)
if n <= 0 then
  redis.call('HDEL', KEYS[2], c)
  if redis.call('HEXISTS', KEYS[2], d) == 0 then redis.call('SREM', KEYS[1], ARGV[1]) end
end
-- the set and its state always expire together
local ttl = tonumber(ARGV[3])
if redis.call('EXISTS', KEYS[1]) == 1 then redis.call('EXPIRE', KEYS[1], ttl) end
redis.call('EXPIRE', KEYS[2], ttl)
return n
`

const stateKey = (key: string) => key + ':s'

const redisLedger: Ledger = {
    async reserve(key, member, kind, max, hardMax, ttlSeconds) {
        if (redisReady) { await redisReady }
        if (!redisClient || !redisClient.isReady) { throw new Error('redis not ready') }
        const res = await redisClient.eval(RESERVE_SCRIPT, {
            keys: [key, stateKey(key)],
            arguments: [member, kind, String(max), String(hardMax), String(ttlSeconds), newGen()],
        }) as any[]
        const [status, ...rest] = res.map(String)
        if (status === 'refused') { return rest }
        return {held: status === 'held', gen: rest[0]}
    },
    async settle(key, member, gen, stored, ttlSeconds) {
        if (!redisClient || !redisClient.isReady) { return }
        await redisClient.eval(SETTLE_SCRIPT, {
            keys: [key, stateKey(key)], arguments: [member, stored ? '1' : '0', String(ttlSeconds), gen],
        })
    },
}

/** Per-process ledger for development and tests, where Redis is not configured. */
export function memoryLedger(now: () => number = Date.now): Ledger & {clear(): void, size(): number} {
    interface Entry {
        gen: string, members: Set<string>, inFlight: Map<string, number>, earned: Set<string>, expiresAt: number,
    }
    const sets = new Map<string, Entry>()
    let writes = 0
    const sweep = (t: number) => {
        for (const [k, e] of sets) { if (e.expiresAt <= t) { sets.delete(k) } }
    }
    const hold = (entry: Entry, member: string, t: number, ttlSeconds: number, held: boolean) => {
        entry.inFlight.set(member, (entry.inFlight.get(member) || 0) + 1)
        entry.expiresAt = t + ttlSeconds * 1000
        return {held, gen: entry.gen}
    }
    return {
        async reserve(key, member, kind, max, hardMax, ttlSeconds) {
            const t = now()
            // Expired entries of clients that never came back go in a periodic sweep.
            if (++writes % 1000 === 0) { sweep(t) }
            let entry = sets.get(key)
            if (entry && entry.expiresAt <= t) { sets.delete(key); entry = undefined }
            if (!entry) {
                entry = {gen: newGen(), members: new Set(), inFlight: new Map(), earned: new Set(), expiresAt: 0}
                sets.set(key, entry)
            }
            if (entry.members.has(member)) { return hold(entry, member, t, ttlSeconds, true) }
            const n = entry.members.size
            const newKind = ![...entry.members].some((m) => m.startsWith(kind + '#'))
            if (n < max || (n < hardMax && newKind)) {
                entry.members.add(member)
                return hold(entry, member, t, ttlSeconds, false)
            }
            return [...entry.members]
        },
        async settle(key, member, gen, stored, ttlSeconds) {
            const entry = sets.get(key)
            if (!entry || entry.gen !== gen || entry.expiresAt <= now()) { return }
            if (stored) { entry.earned.add(member) }
            const n = (entry.inFlight.get(member) || 0) - 1
            if (n > 0) { entry.inFlight.set(member, n) } else {
                entry.inFlight.delete(member)
                if (!entry.earned.has(member)) { entry.members.delete(member) }
            }
            entry.expiresAt = now() + ttlSeconds * 1000
        },
        clear() { sets.clear(); writes = 0 },
        size() { return sets.size },
    }
}

export const testLedger = memoryLedger()
const ledger: Ledger = redisClient ? redisLedger : testLedger

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | 'timeout'> {
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), ms) })
    return Promise.race([p, timeout]).finally(() => { if (timer) { clearTimeout(timer) } })
}

export interface GuardInput {
    /** The variant about to be rendered, with the NEGOTIATED output format. */
    variant: RenderedVariant
    /** Key of the source image the variant is rendered from. */
    sourceKey: string
    blur?: boolean
    /** Authenticated invalidate/ignorecache, or a blocked source answered with the default image. */
    skip?: boolean
    /** Legacy-route request: rendered but never stored, so never redirected. */
    legacy?: boolean
}

/**
 * Decide whether this request may render its variant. Call only on the render
 * path, after the stored-variant lookup missed. An `allow` with a reservation
 * must be settled with `settleReservation` once the request is done.
 */
export async function checkVariantWalk(ctx: KoaContext, input: GuardInput): Promise<GuardDecision> {
    if (MAX_VARIANTS <= 0 || input.blur || input.skip) { return {action: 'allow'} }
    if (!hasEdgeToken(ctx.get(EDGE_TOKEN_HEADER) || undefined)) { return {action: 'allow'} }
    const client = clientKeyFor(ctx.get('cf-connecting-ip'))
    if (!client) { return {action: 'allow'} }

    const key = 'vg:' + createHash('sha1').update(client + '|' + input.sourceKey).digest('base64url').slice(0, 22)
    const member = memberFor(input.variant)
    let result: ReserveResult | 'timeout'
    try {
        result = await withTimeout(
            ledger.reserve(key, member, variantKind(input.variant), MAX_VARIANTS, MAX_VARIANTS + EXTRA_KINDS, WINDOW_SECONDS),
            LEDGER_TIMEOUT_MS)
    } catch (err) {
        ctx.log.warn({err}, 'variant guard ledger failed, allowing')
        return {action: 'allow'}
    }
    if (result === 'timeout') { return {action: 'allow'} }
    if (!Array.isArray(result)) { return {action: 'allow', reservation: {key, member, gen: result.gen}} }
    const members = result

    if (input.legacy) { return {action: 'reject'} }
    const fallback = pickFallback(members, input.variant, ctx.get('accept') || '')
    return fallback ? {action: 'redirect', query: fallback} : {action: 'reject'}
}

/**
 * End this request's hold on its variant. A store marks the variant earned;
 * the slot is given back only when the last request in flight on it ended and
 * none stored it (failed fetch, default image, passthrough), so a failure does
 * not spend the allowance and a later recovery is not refused. Legacy renders
 * are never stored but keep their slot. Fire and forget: the response is not
 * held.
 */
export function settleReservation(
    ctx: KoaContext,
    reservation: Reservation | undefined,
    stored: boolean,
    legacy: boolean,
): Promise<void> {
    if (!reservation) { return Promise.resolve() }
    return ledger.settle(reservation.key, reservation.member, reservation.gen, stored || legacy, WINDOW_SECONDS).catch((err) => {
        ctx.log.warn({err}, 'variant guard settle failed')
    })
}

/** Answer a guarded request. Nothing here may be cached by anyone. */
export function applyGuardDecision(ctx: KoaContext, decision: GuardDecision): boolean {
    if (decision.action === 'allow') { return false }
    ctx.remove('ETag')
    ctx.remove('Last-Modified')
    ctx.remove('Vary')
    ctx.set('Cache-Control', 'no-store')
    if (decision.action === 'redirect') {
        ctx.tag({variant_guard: 'redirect'})
        ctx.set('X-Variant-Guard', 'redirect')
        ctx.status = 302
        ctx.set('Location', `${ctx.path}?${decision.query}`)
        ctx.body = ''
    } else {
        ctx.tag({variant_guard: 'reject'})
        ctx.set('X-Variant-Guard', 'reject')
        ctx.set('Retry-After', '120')
        ctx.status = 429
        ctx.body = 'Too many image variants requested'
    }
    return true
}

const FORMAT_NAMES: {[k: string]: string} = {AVIF: 'avif', WEBP: 'webp', JPEG: 'jpeg', PNG: 'png', Match: 'match'}

/** Name of an OutputFormat enum member (as `OutputFormat[x]` gives it), as a query value. */
export function formatQueryValue(enumName: string): string {
    return FORMAT_NAMES[enumName] || 'match'
}
