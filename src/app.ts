import cors from '@koa/cors'
import * as Bunyan from 'bunyan'
import cluster from 'cluster'
import config from 'config'
import * as http from 'http'
import Koa from 'koa'
import * as os from 'os'

import './sentry' // Initialize Sentry early
import {KoaContext} from './common'
import {APIError, errorMiddleware} from './error'
import {logger, loggerMiddleware} from './logger'
import {routes} from './routes'
import {parseBool} from './utils'

export const app = new Koa()
export const version = require('./version')

app.proxy = parseBool(config.get('proxy'))

app.on('error', (error, ctx: KoaContext) => {
    const log: Bunyan = ctx.log || logger
    const meta = {
        url: ctx.url,
        method: ctx.method,
        req_id: ctx.req_id,
        imageKey: ctx.imageKey,
        ref: ctx.referrer,
        normalizedUrl: ctx.normalizedUrl,
        originalUrl: ctx.originalUrl,
        fallbackUsed: ctx.fallbackUsed
    }

    if (error instanceof APIError) {
        const errLog = error.cause || error
        if (error.statusCode >= 500) {
            log.error({ ...meta, err: errLog }, 'unexpected API error')
        } else {
            log.debug({ ...meta, err: errLog }, 'handled API error')
        }
    } else {
        log.error({ ...meta, err: error }, 'unhandled application error')
    }
})

app.use(loggerMiddleware as any)
app.use(errorMiddleware as any)

app.use(async (ctx, next) => {
    ctx.set('X-Content-Type-Options', 'nosniff')
    ctx.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'")
    await next()
})

app.use(cors({origin: '*',
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']}))
app.use(routes)
app.use((_ctx: Koa.Context) => {
    throw new APIError({code: APIError.Code.NotFound})
})

async function main() {
    if (cluster.isPrimary) {
        logger.info({version}, 'starting service')
    }

    const server = http.createServer(app.callback())
    const listen = (port: any) => new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, resolve)
    })
    const close = () => new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()))

    let numWorkers = Number.parseInt(config.get('num_workers'))
    if (numWorkers === 0) {
        numWorkers = os.cpus().length
    }
    const isPrimary = cluster.isPrimary && numWorkers > 1

    if (isPrimary) {
        logger.info('spawning %d workers', numWorkers)
        for (let i = 0; i < numWorkers; i++) {
            cluster.fork()
        }
        const restartTimestamps: number[] = []
        const RESTART_WINDOW = 60000  // 1 minute
        const MAX_RESTARTS = 5
        const RESTART_DELAY = 5000    // 5 second backoff
        cluster.on('exit', (worker, code, signal) => {
            const now = Date.now()
            restartTimestamps.push(now)
            // Prune entries older than window
            while (restartTimestamps.length > 0 && restartTimestamps[0] <= now - RESTART_WINDOW) {
                restartTimestamps.shift()
            }
            if (restartTimestamps.length > MAX_RESTARTS) {
                logger.warn({ workerId: worker.id, code, signal, restartsInWindow: restartTimestamps.length },
                    'worker died, throttling respawn due to rapid restarts')
                setTimeout(() => { cluster.fork() }, RESTART_DELAY)
            } else {
                logger.warn({ workerId: worker.id, code, signal }, 'worker died, respawning')
                cluster.fork()
            }
        })
    } else {
        const port = config.get('port')
        await listen(port)
        logger.info('listening on port %d', port)
    }

    const exit = async () => {
        if (!isPrimary) {
            await close()
        }
        return 0
    }

    process.on('SIGTERM', () => {
        logger.info('got SIGTERM, exiting...')
        exit().then((code) => {
            process.exit(code)
        }).catch((error) => {
            logger.fatal(error, 'unable to exit gracefully')
            setTimeout(() => process.exit(1), 1000)
        })
    })
}

if (module === require.main) {
    main().catch((error) => {
        logger.fatal(error, 'unable to start')
        setTimeout(() => process.exit(1), 1000)
    })
}
