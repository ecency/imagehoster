import * as Sentry from '@sentry/node'
import config from 'config'

const dsn = config.has('sentry_dsn') ? config.get('sentry_dsn') as string : ''

const UPLOAD_TOKEN_PATH = /(\/hs\/)[^/?#\s"']+/g

function redactPath(value: any): any {
    return typeof value === 'string' ? value.replace(UPLOAD_TOKEN_PATH, '$1[redacted]') : value
}

// Writes back only what changed, so a getter-only property (Sentry's own
// processing metadata has them) never throws inside a hook, which would drop
// the event; each object is visited once, so a cycle ends.
function redactDeep(value: any, depth = 0, seen = new WeakSet<object>()): any {
    if (typeof value === 'string') { return redactPath(value) }
    if (depth > 8 || !value || typeof value !== 'object' || seen.has(value)) { return value }
    seen.add(value)
    for (const key of Object.keys(value)) {
        const current = value[key]
        const next = redactDeep(current, depth + 1, seen)
        if (next !== current) {
            try {
                value[key] = next
            } catch {
                // A read-only property keeps its value.
            }
        }
    }
    return value
}

/**
 * Removes the upload access token from an event or transaction: the
 * Authorization header, and the `/hs/<token>` and `/webp/hs/<token>` path forms
 * wherever a URL or name carries them (request, transaction name, spans,
 * breadcrumbs, contexts). Mutates and returns the event.
 */
export function scrubSentryEvent<T extends Record<string, any>>(event: T): T {
    const headers = event.request && event.request.headers
    if (headers && typeof headers === 'object') {
        for (const name of Object.keys(headers)) {
            if (name.toLowerCase() === 'authorization') { delete headers[name] }
        }
    }
    return redactDeep(event)
}

export function sentryInitOptions(dsn: string) {
    return {
        dsn,
        tracesSampleRate: 0.1,
        environment: process.env.NODE_ENV || 'production',
        beforeSend: (event: any) => scrubSentryEvent(event),
        beforeSendTransaction: (event: any) => scrubSentryEvent(event),
        // Breadcrumbs reach an envelope without passing beforeSend, so they are
        // scrubbed as they are recorded.
        beforeBreadcrumb: (breadcrumb: any) => redactDeep(breadcrumb),
    }
}

if (dsn) {
    Sentry.init(sentryInitOptions(dsn))
}

export function captureImageFailure(
    reason: string,
    ctx: { request?: { ip?: string; header?: any }; url?: string },
    extra: Record<string, any> = {}
) {
    if (!dsn) return
    Sentry.withScope((scope) => {
        scope.setTag('failure_reason', reason)
        if (ctx.request?.ip) {
            scope.setUser({ ip_address: ctx.request.ip })
        }
        if (ctx.url) {
            scope.setTag('request_url', ctx.url)
        }
        const referer = ctx.request?.header?.referer || ctx.request?.header?.referrer
        if (referer) {
            scope.setTag('referer', referer)
        }
        scope.setExtras(extra)
        Sentry.captureMessage(`Image failure: ${reason}`, 'warning')
    })
}
