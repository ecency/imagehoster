/** Serve user avatars. */

import { Account } from '@hiveio/dhive'
import { AbstractBlobStore } from 'abstract-blob-store'
import * as config from 'config'
import * as etag from 'etag'
import {URL} from 'url'
import {fetchImageWithFallbacks} from './fetch-image'
import {resizeImageWithOptions} from './image-resizer'

import { getProfile, KoaContext, proxyStore, uploadStore } from './common'
import { APIError } from './error'
import {
  getDefaultUrlAndParams,
  getImageKey,
  getUrlHashKey,
  mimeMagic,
  OutputFormat,
  purgeCache,
  readStream,
  safeParseInt,
  ScalingMode,
  storeExists,
  storeRemove,
  storeWrite,
  supportsWebP,
} from './utils'

const DefaultAvatar = config.get('default_avatar') as string
const REGEX = /^[a-z](-[a-z0-9](-[a-z0-9])*)?(-[a-z0-9]|[a-z0-9])*(?:\.[a-z](-[a-z0-9](-[a-z0-9])*)?(-[a-z0-9]|[a-z0-9])*)*$/

const AVATAR_SIZE = 256

async function handleAvatar(ctx: KoaContext) {
  ctx.tag({ handler: 'avatar' })

  APIError.assert(ctx.method === 'GET', APIError.Code.InvalidMethod)
  APIError.assertParams(ctx.params, ['username'])

  // Detect WebP support from Accept header for content negotiation
  const acceptHeader = ctx.get('accept') || ''
  const preferWebP = supportsWebP(acceptHeader)

  const username = ctx.params['username'].toLowerCase()
  APIError.assert(REGEX.test(username), APIError.Code.NoSuchAccount)

  // Check for cache bypass parameters
  const query = ctx.request.query
  const ignorecache = Number.parseInt(query['ignorecache'] as string) || undefined
  const invalidate = Number.parseInt(query['invalidate'] as string) || undefined
  const shouldBypassCache = !!(ignorecache || invalidate)

  const profile = await getProfile(username, !shouldBypassCache)
  ctx.log.debug({ profile, username }, 'Fetched profile data')

  if (!profile) {
    throw new APIError({ code: APIError.Code.NoSuchAccount })
  }

  // get_profile returns metadata already parsed, no JSON.parse needed
  let avatarUrl = DefaultAvatar
  if (profile.metadata?.profile?.profile_image &&
      profile.metadata.profile.profile_image.startsWith('http')) {
    avatarUrl = profile.metadata.profile.profile_image
  }

  const size = safeParseInt(ctx.params['size']) || AVATAR_SIZE
  const { url, urlParams } = getDefaultUrlAndParams(avatarUrl)
  const urlString = url.toString()
  const origIsUpload = new URL(config.get('service_url')).origin === url.origin && url.pathname[1] === 'D'
  ctx.tag({ is_upload: origIsUpload })

  const origStore: AbstractBlobStore = origIsUpload ? uploadStore : proxyStore
  const origKey = origIsUpload
      ? url.pathname.slice(1).split('/')[0]
      : getUrlHashKey(urlString)

  const options = {
    width: size,
    height: size,
    mode: ScalingMode.Cover,
    format: preferWebP ? OutputFormat.WEBP : OutputFormat.Match,
  }
  const imageKey = getImageKey(origKey, options)

  ctx.set({
    'ETag': etag(imageKey),
    'Last-Modified': new Date(`${profile.active}Z`).toUTCString(),
  })

  if (ctx.fresh && !shouldBypassCache) {
    ctx.status = 304
    return
  }

  if (await storeExists(proxyStore, imageKey) && !shouldBypassCache) {
    ctx.tag({ store: 'resized' })
    const file = proxyStore.createReadStream(imageKey)
    const { head, stream } = await import('stream-head').then((mod) => mod.default(file, { bytes: 16384 }))
    ctx.set('Content-Type', await mimeMagic(head))
    ctx.set('Cache-Control', 'public,max-age=3600,stale-while-revalidate=86400')
    ctx.body = stream
    return
  }

  // If cache bypass requested, remove cached images and purge CDN
  if (shouldBypassCache) {
    ctx.log.debug('cache bypass requested, removing cached images')
    if (await storeExists(proxyStore, imageKey)) {
      await storeRemove(proxyStore, imageKey)
    }
    // Purge Cloudflare cache
    const serviceUrl = new URL(config.get('service_url'))
    await purgeCache(`${serviceUrl.origin}/u/${username}/avatar/`)
    await purgeCache(`${serviceUrl.origin}/u/${username}/avatar/small`)
    await purgeCache(`${serviceUrl.origin}/u/${username}/avatar/medium`)
    await purgeCache(`${serviceUrl.origin}/u/${username}/avatar/large`)
    await purgeCache(`${serviceUrl.origin}/webp/u/${username}/avatar/`)
    await purgeCache(`${serviceUrl.origin}/webp/u/${username}/avatar/small`)
    await purgeCache(`${serviceUrl.origin}/webp/u/${username}/avatar/medium`)
    await purgeCache(`${serviceUrl.origin}/webp/u/${username}/avatar/large`)
  }

  let origData: Buffer
  let contentType: string
  let isFetchFallback = false
  let isResizeFallback = false

  if (await storeExists(origStore, origKey) && !shouldBypassCache) {
    ctx.tag({ store: 'original' })
    origData = await readStream(origStore.createReadStream(origKey))
    contentType = await mimeMagic(origData)
  } else {
    ctx.tag({ store: 'fetch' })
    try {
      // tslint:disable-next-line:max-line-length
      const result = await fetchImageWithFallbacks(urlString, urlParams, ctx.get('user-agent') || 'EcencyProxy/1.0 (+https://github.com/ecency)', DefaultAvatar, ctx.log)
      const res = result.res
      isFetchFallback = result.isFallback
      origData = res.body
      contentType = await mimeMagic(origData)

      if (res.bytes <= Number.parseInt(config.get('max_image_size'))) {
        ctx.log.debug('storing original %s', origKey)
        try {
          await storeWrite(origStore, origKey, origData)
          // Purge Cloudflare cache for this user's avatar endpoint since we fetched a new image
          const serviceUrl = new URL(config.get('service_url'))
          await purgeCache(`${serviceUrl.origin}/u/${username}/avatar/`)
          await purgeCache(`${serviceUrl.origin}/u/${username}/avatar/small`)
          await purgeCache(`${serviceUrl.origin}/u/${username}/avatar/medium`)
          await purgeCache(`${serviceUrl.origin}/u/${username}/avatar/large`)
        } catch (err) {
          ctx.log.error({ err, origKey }, 'failed to store original avatar image')
          // Continue serving - storage failure shouldn't block response
        }
      } else {
        ctx.log.debug('not-storing PayloadTooLarge original %s', origKey)
      }
    } catch (cause) {
      ctx.log.error(cause, 'Image fetch failed')
      throw new APIError({ cause, code: APIError.Code.InvalidImage })
    }
  }

  let rv: Buffer

  if (
      contentType === 'image/gif' &&
      options.format === OutputFormat.Match &&
      options.mode === ScalingMode.Cover
  ) {
    rv = origData
  } else {
    const { buffer, contentType: finalType, isFallback } = await resizeImageWithOptions(
        origData,
        contentType,
        options,
        urlString,
        urlParams,
        ctx.get('user-agent') || '',
        DefaultAvatar,
        ctx.log
    )
    rv = buffer
    contentType = finalType
    isResizeFallback = isFallback

    ctx.log.debug('storing converted %s', imageKey)
    try {
      await storeWrite(proxyStore, imageKey, rv)
    } catch (err) {
      ctx.log.error({ err, imageKey }, 'failed to store converted avatar image')
      // Continue serving - storage failure shouldn't block response
    }
  }

  const isFinalFallback = isFetchFallback || isResizeFallback

  ctx.set('Content-Type', contentType)
  // Vary on Accept header for proper content negotiation caching
  ctx.set('Vary', 'Accept')
  // If cache was bypassed, set no-cache to force revalidation, otherwise use standard cache
  if (shouldBypassCache) {
    ctx.set('Cache-Control', 'no-cache,must-revalidate')
  } else {
    ctx.set('Cache-Control', isFinalFallback
        ? 'public,max-age=600'
        : 'public,max-age=3600,stale-while-revalidate=86400')
  }
  ctx.body = rv
}

export async function avatarHandler(ctx: KoaContext) {
  return handleAvatar(ctx)
}

/**
 * @deprecated Use avatarHandler with Accept: image/webp header instead
 * Kept for backward compatibility - redirects to non-webp URL
 */
export async function avatarWHandler(ctx: KoaContext) {
  // Redirect /webp/u/:username/avatar/:size? to /u/:username/avatar/:size?
  const username = ctx.params['username']
  const size = ctx.params['size']
  const redirectUrl = size ? `/u/${username}/avatar/${size}` : `/u/${username}/avatar`
  ctx.redirect(redirectUrl)
}
