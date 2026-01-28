/** API routes. */

import * as Router from 'koa-router'

import {avatarHandler, avatarWHandler} from './avatar'
import {KoaContext} from './common'
import {coverHandler, coverWHandler} from './cover'
import {legacyProxyHandler, legacyWProxyHandler} from './legacy-proxy'
import {proxyHandler} from './proxy'
import {serveHandler} from './serve'
import {uploadHandler, uploadHsHandler} from './upload'

const version = require('./version')
const router = new Router()

async function healthcheck(ctx: KoaContext) {
    const ok = true
    const date = new Date()
    ctx.set('Cache-Control', 'no-cache')
    ctx.body = {ok, version, date}
}

// Health check endpoints
router.get('/', healthcheck as any)
router.get('/.well-known/healthcheck.json', healthcheck as any)
router.get('/healthcheck', healthcheck as any)

// Image serving endpoints with automatic WebP content negotiation via Accept header
router.get('/u/:username/avatar/:size?', avatarHandler as any)
router.get('/u/:username/cover', coverHandler as any)
router.get('/p/:url', proxyHandler as any)
router.get('/:width(\\d+)x:height(\\d+)/:url(.*)', legacyProxyHandler as any)
router.get('/:hash/:filename?', serveHandler as any)

// Upload endpoints
router.post('/hs/:accesstoken', uploadHsHandler as any)
router.post('/:username/:signature', uploadHandler as any)

// Deprecated /webp/ routes - kept for backward compatibility, redirect to non-webp URLs
// WebP format is now automatically served based on Accept: image/webp header
router.get('/webp/u/:username/avatar/:size?', avatarWHandler as any)
router.get('/webp/u/:username/cover', coverWHandler as any)
router.get('/webp/:width(\\d+)x:height(\\d+)/:url(.*)', legacyWProxyHandler as any)
router.post('/webp/hs/:accesstoken', uploadHsHandler as any) // Uploads don't care about format

export const routes = router.routes()
