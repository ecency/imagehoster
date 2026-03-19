import * as Sentry from '@sentry/node'
import config from 'config'

const dsn = config.has('sentry_dsn') ? config.get('sentry_dsn') as string : ''

if (dsn) {
    Sentry.init({
        dsn,
        tracesSampleRate: 0.1,
        environment: process.env.NODE_ENV || 'production',
    })
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
