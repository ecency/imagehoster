import config from 'config'
import {createHash} from 'crypto'
import {isIP} from 'net'
import {KoaContext, redisClient, redisReady} from './common'

/**
 * Variant-walk guard for /p/ renders.
 *
 * Pages list each image as a srcset of several widths and formats. A browser
 * picks one of them per image (two if the window is resized). An automated
 * client that fetches every candidate turns one image into many fresh renders,
 * which is the most expensive thing this service does.
 *
 * The guard counts, per client address and source image, the DISTINCT variants
 * this service had to render (cache hits are answered before the guard runs and
 * are never counted). Up to `variant_guard_max_variants` are allowed per window.
 * Past that the request is not rendered:
 *   - if the same client already got a compatible variant of this image (same
 *     mode and height, a format it can decode), it is redirected there, so a
 *     person behind a busy shared address still sees the image at another size;
 *     the target was just rendered, so it is a cache hit;
 *   - otherwise it gets a 429 with Retry-After.
 * Both answers are `no-store`, so no cache in front of the service can keep
 * them and hand them to other clients.
 *
 * Never applied when the client address is unknown (no CF-Connecting-IP, as on
 * direct-origin requests, where every client would share one key), to known
 * search crawlers, to `blur` placeholders or to authenticated cache-bypass
 * requests. A ledger error or slow answer lets the request through: the guard
 * must never be the reason a real image fails.
 */

const MAX_VARIANTS = configNumber('variant_guard_max_variants', 4)
const WINDOW_SECONDS = configNumber('variant_guard_window_seconds', 300)
/** A slow ledger answer lets the request through rather than delaying it. */
const LEDGER_TIMEOUT_MS = 100

function configNumber(key: string, fallback: number): number {
    if (!config.has(key)) { return fallback }
    const v = Number.parseInt(config.get(key) as string, 10)
    return Number.isFinite(v) && v >= 0 ? v : fallback
}

/**
 * Search and social crawlers fetch whichever candidates they like and must never
 * see a 429 or an unexpected redirect. A scraper spoofing one of these strings
 * is out of reach here; the CDN's bot verification is the place for that.
 */
const CRAWLER_UA = /Googlebot|Google-InspectionTool|GoogleOther|Storebot-Google|AdsBot-Google|Mediapartners-Google|bingbot|BingPreview|msnbot|Applebot|DuckDuckBot|YandexBot|YandexImages|Baiduspider|Slurp|facebookexternalhit|meta-externalagent|meta-webindexer|Twitterbot|LinkedInBot|Slackbot|Discordbot|TelegramBot|WhatsApp|Pinterestbot|redditbot/i

/** The variant as the CLIENT named it, which is what a redirect has to reproduce. */
export interface RequestedVariant {
    format: string
    mode: string
    width?: number
    height?: number
}

export type GuardDecision =
    | {action: 'allow'}
    | {action: 'redirect', query: string}
    | {action: 'reject'}

/**
 * The client this request is counted against: Cloudflare's view of the
 * connecting address. An IPv6 client is keyed by its /64, which is what one
 * household or one rented proxy exit gets (they rotate inside it freely).
 */
export function clientKeyFor(cfConnectingIp: string | undefined): string | undefined {
    const ip = (cfConnectingIp || '').trim()
    const family = isIP(ip)
    if (family === 4) { return ip }
    if (family === 6) { return ipv6Prefix64(ip) }
    return undefined
}

function ipv6Prefix64(ip: string): string {
    // Expand '::' so the first four groups are positional.
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

/** Canonical query for a variant, in the order the frontends build it. */
export function variantQuery(v: RequestedVariant): string {
    const parts = [`format=${v.format}`, `mode=${v.mode}`]
    if (v.width !== undefined) { parts.push(`width=${v.width}`) }
    if (v.height !== undefined) { parts.push(`height=${v.height}`) }
    return parts.join('&')
}

export function parseVariantQuery(q: string): RequestedVariant | undefined {
    const params = new URLSearchParams(q)
    const format = params.get('format')
    const mode = params.get('mode')
    if (!format || !mode) { return undefined }
    const width = params.has('width') ? Number.parseInt(params.get('width') as string, 10) : undefined
    const height = params.has('height') ? Number.parseInt(params.get('height') as string, 10) : undefined
    return {format, mode, width, height}
}

/**
 * Formats a client that asked for `requested` can certainly decode. `match` is
 * Accept-negotiated and the CDN does not key on Accept, so it only stands in
 * for itself; an AVIF client takes WebP too, but not the other way round.
 */
function compatibleFormats(requested: string): string[] {
    if (requested === 'avif') { return ['avif', 'webp'] }
    return [requested]
}

/**
 * The already-rendered variant to send this client to instead of rendering a
 * new one: same mode and height (so the crop and aspect are what the page laid
 * out), a format it can decode, and the width nearest the one it asked for
 * (ties go to the larger, which scales down cleanly).
 */
export function pickFallback(members: string[], requested: RequestedVariant): string | undefined {
    const formats = compatibleFormats(requested.format)
    let best: {q: string, dist: number, width: number} | undefined
    for (const q of members) {
        const v = parseVariantQuery(q)
        if (!v) { continue }
        if (!formats.includes(v.format) || v.mode !== requested.mode || v.height !== requested.height) { continue }
        const want = requested.width || 0
        const have = v.width || 0
        const dist = Math.abs(have - want)
        if (!best || dist < best.dist || (dist === best.dist && have > best.width)) {
            best = {q, dist, width: have}
        }
    }
    return best ? best.q : undefined
}

/**
 * Records `member` in the client's set for this image when there is room.
 * Answers `null` when the variant is allowed (new and under the cap, or already
 * recorded), or the recorded members when the cap is reached.
 */
interface Ledger {
    record(key: string, member: string, max: number, ttlSeconds: number): Promise<string[] | null>
}

// KEYS[1] set, ARGV member, max, ttl. Membership first, so retrying a variant
// the client already rendered is never counted twice.
const RECORD_SCRIPT = `
if redis.call('SISMEMBER', KEYS[1], ARGV[1]) == 1 then return nil end
if redis.call('SCARD', KEYS[1]) < tonumber(ARGV[2]) then
  redis.call('SADD', KEYS[1], ARGV[1])
  redis.call('EXPIRE', KEYS[1], tonumber(ARGV[3]))
  return nil
end
return redis.call('SMEMBERS', KEYS[1])
`

const redisLedger: Ledger = {
    async record(key, member, max, ttlSeconds) {
        if (redisReady) { await redisReady }
        if (!redisClient || !redisClient.isReady) { return null }
        const res = await redisClient.eval(RECORD_SCRIPT, {keys: [key], arguments: [member, String(max), String(ttlSeconds)]})
        return Array.isArray(res) ? res.map(String) : null
    },
}

/** Per-process ledger for development and tests, where Redis is not configured. */
export function memoryLedger(now: () => number = Date.now): Ledger & {clear(): void} {
    const sets = new Map<string, {members: Set<string>, expiresAt: number}>()
    return {
        async record(key, member, max, ttlSeconds) {
            const t = now()
            let entry = sets.get(key)
            if (entry && entry.expiresAt <= t) { sets.delete(key); entry = undefined }
            if (entry && entry.members.has(member)) { return null }
            if (!entry) { entry = {members: new Set(), expiresAt: 0}; sets.set(key, entry) }
            if (entry.members.size < max) {
                entry.members.add(member)
                entry.expiresAt = t + ttlSeconds * 1000
                return null
            }
            return [...entry.members]
        },
        clear() { sets.clear() },
    }
}

export const testLedger = memoryLedger()
const ledger: Ledger = redisClient ? redisLedger : testLedger

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | 'timeout'> {
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), ms) })
    return Promise.race([p, timeout]).finally(() => { if (timer) { clearTimeout(timer) } })
}

/**
 * Decide whether this request may render `variant` of the source `sourceKey`.
 * Call only on the render path, after the stored-variant lookup missed.
 */
export async function checkVariantWalk(
    ctx: KoaContext,
    sourceKey: string,
    variant: RequestedVariant,
    opts: {blur?: boolean, bypass?: boolean} = {}
): Promise<GuardDecision> {
    if (MAX_VARIANTS <= 0 || opts.blur || opts.bypass) { return {action: 'allow'} }
    const client = clientKeyFor(ctx.get('cf-connecting-ip'))
    if (!client) { return {action: 'allow'} }
    if (CRAWLER_UA.test(ctx.get('user-agent') || '')) { return {action: 'allow'} }

    const key = 'vg:' + createHash('sha1').update(client + '|' + sourceKey).digest('base64url').slice(0, 22)
    const member = variantQuery(variant)
    let members: string[] | null | 'timeout'
    try {
        members = await withTimeout(ledger.record(key, member, MAX_VARIANTS, WINDOW_SECONDS), LEDGER_TIMEOUT_MS)
    } catch (err) {
        ctx.log.warn({err}, 'variant guard ledger failed, allowing')
        return {action: 'allow'}
    }
    if (members === null || members === 'timeout') { return {action: 'allow'} }

    const fallback = pickFallback(members, variant)
    return fallback ? {action: 'redirect', query: fallback} : {action: 'reject'}
}

/** Answer a guarded request. Nothing here may be cached by anyone. */
export function applyGuardDecision(ctx: KoaContext, decision: GuardDecision): boolean {
    if (decision.action === 'allow') { return false }
    ctx.remove('ETag')
    ctx.remove('Last-Modified')
    ctx.set('Cache-Control', 'no-store')
    if (decision.action === 'redirect') {
        ctx.tag({variant_guard: 'redirect'})
        ctx.set('X-Variant-Guard', 'redirect')
        ctx.status = 302
        // Legacy-route requests are rendered but never stored; keep the marker so
        // the target is handled the same way as the variants recorded for it.
        const legacy = ctx.query['_src'] === 'legacy' ? '&_src=legacy' : ''
        ctx.set('Location', `${ctx.path}?${decision.query}${legacy}`)
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

const KNOWN_FORMATS = new Set(['match', 'jpeg', 'jpg', 'png', 'webp', 'avif'])

/**
 * The variant as the client's query names it, normalised the way parseOptions
 * reads it (unknown format = match, missing mode = cover, 0 width = none), so
 * two spellings of one variant count once and a redirect reproduces it.
 */
export function requestedVariantOf(query: {[key: string]: any}): RequestedVariant {
    const rawFormat = typeof query['format'] === 'string' ? query['format'] : 'match'
    const format = KNOWN_FORMATS.has(rawFormat) ? (rawFormat === 'jpg' ? 'jpeg' : rawFormat) : 'match'
    const mode = query['mode'] === 'fit' ? 'fit' : 'cover'
    const width = Number.parseInt(query['width']) || undefined
    const height = Number.parseInt(query['height']) || undefined
    return {format, mode, width, height}
}
