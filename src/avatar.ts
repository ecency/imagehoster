/** Serve user avatars. */

import { AbstractBlobStore } from 'abstract-blob-store'
import config from 'config'
import {URL} from 'url'
import {fetchImageWithFallbacks} from './fetch-image'
import {clientGoneSignal} from './encode-limit'
import {resizeImageWithOptions} from './image-resizer'

import { getProfile, KoaContext, proxyStore, retentionStore, uploadStore } from './common'
import { budgetSignal, FETCH_DEADLINE_MS, STORE_OP_TIMEOUT_MS } from './constants'
import { APIError } from './error'
import {
  cacheControlFor, derive, etagFor, fallbackImage, FallbackImage, isFallbackImage, realImage, ServedImage,
  storeImage, worstOf,
} from './served-image'
import {
  getDefaultUrlAndParams,
  getImageKey,
  isInternalUploadUrl,
  getUrlHashKey,
  hasValidInvalidateKey,
  isBlacklistedUrl,
  mimeMagic,
  OutputFormat,
  purgeCache,
  readStream,
  safeParseInt,
  ScalingMode,
  storeExists,
  storeExistsBounded,
  storeStat,
  storeStatBounded,
  streamHeadBounded,
  storeRemove,
  supportsAvif,
  supportsWebP,
} from './utils'

/** A real avatar is fresh for an hour so profile changes propagate. */
const REAL_CACHE_CONTROL = 'public,max-age=3600'
const DefaultAvatar = config.get('default_avatar') as string
const REGEX = /^[a-z](-[a-z0-9](-[a-z0-9])*)?(-[a-z0-9]|[a-z0-9])*(?:\.[a-z](-[a-z0-9](-[a-z0-9])*)?(-[a-z0-9]|[a-z0-9])*)*$/

const AVATAR_SIZE = 256

async function handleAvatar(ctx: KoaContext) {
  ctx.tag({ handler: 'avatar' })
  // One wall-clock budget for every upstream fetch this request makes, so an
  // exhausted mirror chain gets the chance to answer with a placeholder well
  // inside the 60s Varnish allows the backend, rather than being cut off as a 503.
  const fetchDeadlineAt = Date.now() + FETCH_DEADLINE_MS

  APIError.assert(ctx.method === 'GET', APIError.Code.InvalidMethod)
  APIError.assertParams(ctx.params, ['username'])

  // Detect modern format support from Accept header for content negotiation
  const acceptHeader = ctx.get('accept') || ''
  const preferAvif = supportsAvif(acceptHeader)
  const preferWebP = !preferAvif && supportsWebP(acceptHeader)

  const username = ctx.params['username'].toLowerCase()
  APIError.assert(username.length >= 3, APIError.Code.NoSuchAccount)
  APIError.assert(REGEX.test(username), APIError.Code.NoSuchAccount)

  // Check for cache bypass parameters
  const query = ctx.request.query
  let ignorecache = Number.parseInt(query['ignorecache'] as string) || undefined
  const invalidate = Number.parseInt(query['invalidate'] as string) || undefined
  // Unauthenticated `ignorecache` additionally bypassed the 300s Redis profile
  // cache (forcing a Hive RPC per request) and fired a Cloudflare purge for this
  // user on success, evicting a perfectly good cached avatar. Same gate as
  // `invalidate`; neutralised rather than rejected, so the request resumes normal
  // cache handling rather than being guaranteed a hit.
  if (ignorecache && !hasValidInvalidateKey(ctx)) {
    ctx.log.warn({username}, 'ignoring unauthenticated ignorecache')
    ignorecache = undefined
  }
  const shouldBypassCache = !!(ignorecache || invalidate)
  if (invalidate) {
    APIError.assert(
      hasValidInvalidateKey(ctx),
      { code: APIError.Code.Deplorable, message: 'Forbidden: invalid invalidate key' }
    )
  }
  const avatarRequestPurgeUrl = (() => {
    const purgeUrl = new URL(ctx.request.url, new URL(config.get('service_url')).origin)
    purgeUrl.searchParams.delete('invalidate')
    purgeUrl.searchParams.delete('ignorecache')
    return purgeUrl.toString()
  })()

  const profile = await getProfile(username, !shouldBypassCache)
  ctx.log.debug({ profile, username }, 'Fetched profile data')

  // get_profile returns metadata already parsed, no JSON.parse needed
  // If profile is undefined, it means a transient RPC error — fall back to default avatar.
  // If account doesn't exist, getProfile throws and we never reach here.
  let avatarUrl = DefaultAvatar
  let isProfileFallback = false
  if (profile && profile.metadata && profile.metadata.profile &&
      profile.metadata.profile.profile_image &&
      profile.metadata.profile.profile_image.startsWith('http')) {
    avatarUrl = profile.metadata.profile.profile_image
  } else if (!profile) {
    isProfileFallback = true
  }

  if (isBlacklistedUrl(avatarUrl)) {
    // A blacklisted source behaves like a profile fallback: substitute the
    // default BEFORE keys, ETag and store reads, so variants cached before the
    // listing became effective are unreachable and the response carries the
    // 120s fallback header. Keys then derive from the default image's own URL,
    // the documented safe-to-cache exception.
    ctx.log.error({ avatarUrl }, 'Falling back to default avatar due to blacklist')
    avatarUrl = DefaultAvatar
    isProfileFallback = true
  }

  const size = safeParseInt(ctx.params['size']) || AVATAR_SIZE
  const { url, urlParams } = getDefaultUrlAndParams(avatarUrl)
  const urlString = url.toString()
  const origIsUpload = isInternalUploadUrl(url)
  ctx.tag({ is_upload: origIsUpload })

  const origStore: AbstractBlobStore = origIsUpload ? uploadStore : proxyStore
  const origKey = origIsUpload
      ? url.pathname.slice(1).split('/')[0]
      : getUrlHashKey(urlString)

  const options = {
    width: size,
    height: size,
    mode: ScalingMode.Cover,
    format: preferAvif ? OutputFormat.AVIF : preferWebP ? OutputFormat.WEBP : OutputFormat.Match,
  }
  const imageKey = getImageKey(origKey, options)

  // No validator yet: a real variant's ETag is derived from its stored bytes
  // (see realEtag) and is set once those are in hand. No Last-Modified either:
  // it used to carry the profile's timestamp, which says nothing about the
  // stored bytes, so an If-Modified-Since-only revalidation could answer 304
  // for a variant that had since been repaired or re-encoded.

  // ctx.fresh only consults the conditional headers once the status is
  // 2xx/304, and Koa's default is 404 at this point, so without an explicit 200
  // the revalidation branch inside the cache-hit block could never fire. The 304
  // itself is answered only there, with a healthy stored variant in hand: a
  // validator alone does not prove the bytes behind it are what this key renders
  // to today, and an If-Modified-Since-only revalidation would otherwise let the
  // client keep a copy of whatever it holds.
  ctx.status = 200

  // Every store call before the upstream fetch, this first variant lookup
  // included, is bounded and charged to the request budget; a stall reads as a
  // miss and the handler carries on to the original and the fetch (see #44)
  const storeSignal = () => budgetSignal(fetchDeadlineAt, STORE_OP_TIMEOUT_MS)
  let cachedVariant: {head: Buffer, stream: NodeJS.ReadableStream} | undefined
  const variantStat = shouldBypassCache ? {exists: false}
    : await storeStatBounded(proxyStore, imageKey, storeSignal(), ctx.log, 'variant')
  if (variantStat.exists) {
    const headSignal = storeSignal()
    try {
      cachedVariant = await streamHeadBounded(
        proxyStore.createReadStream({ key: imageKey, signal: headSignal } as any), 16384, headSignal)
    } catch (err) {
      ctx.log.warn({ err: (err as Error).message, imageKey }, 'cached variant read failed or timed out, treating as a miss')
    }
  }
  if (cachedVariant) {
    ctx.tag({ store: 'resized' })
    const { head, stream } = cachedVariant
    // The store only holds real variants (storeImage refuses the rest), so a hit
    // is real unless the whole request was substituted for a missing or blocked
    // profile; the response then carries the fallback contract and its own ETag
    const served: ServedImage<NodeJS.ReadableStream> = isProfileFallback
      ? fallbackImage(stream, 'profile lookup fell back, default substituted')
      : realImage(stream)
    ctx.set('ETag', etagFor(served, imageKey, head, variantStat.size))
    // never take the freshness shortcut for a fallback response: the substituted
    // default changes the ETag, but Last-Modified still carries the profile's
    // timestamp, so an If-Modified-Since-only revalidation would answer 304 and let
    // the client keep its cached (possibly blocked) bytes
    if (ctx.fresh && !shouldBypassCache && !isProfileFallback) {
      if ((stream as any).destroy) { (stream as any).destroy() }
      ctx.status = 304
      return
    }
    ctx.set('Content-Type', await mimeMagic(head))
    ctx.set('Vary', 'Accept')
    ctx.set('Cache-Control', cacheControlFor(served, REAL_CACHE_CONTROL))
    ctx.body = stream
    return
  }

  // Invalidate requested: remove cached images and purge CDN for this endpoint URL
  if (invalidate) {
    ctx.log.debug('invalidate requested, removing cached images')
    purgeCache(avatarRequestPurgeUrl)
    // Delete all known avatar variants directly — no directory scan needed
    const avatarSizes = [64, 128, 256, 512]
    const avatarFormats = [OutputFormat.Match, OutputFormat.WEBP, OutputFormat.AVIF]
    for (const s of avatarSizes) {
      for (const f of avatarFormats) {
        const key = getImageKey(origKey, { width: s, height: s, mode: ScalingMode.Cover, format: f })
        try { await storeRemove(proxyStore, key) } catch (_e) { /* may not exist */ }
      }
    }
    ctx.log.debug({ origKey }, 'removed known avatar variants on invalidate')
    if (!origIsUpload) {
      try { await storeRemove(origStore, origKey) } catch (_e) { /* may not exist */ }
    }
  }

  let origin: ServedImage
  let contentType: string

  const haveLocalOriginal = await storeExistsBounded(origStore, origKey, storeSignal(), ctx.log, 'original') && !shouldBypassCache
  // Archive of originals whose upstream is gone. An origin, not a cache, so
  // cache-bypass flags deliberately do not skip it. An object-store outage must
  // not fail the request, so any error falls through to the normal fetch path.
  let retentionData: Buffer | undefined
  if (!haveLocalOriginal && retentionStore) {
    try {
      if (await storeExistsBounded(retentionStore, origKey, storeSignal(), ctx.log, 'retention original')) {
        const readSignal = storeSignal()
        retentionData = await readStream(retentionStore.createReadStream({ key: origKey, signal: readSignal } as any), readSignal)
      }
    } catch (err) {
      ctx.log.warn({ err: (err as Error).message, origKey }, 'retention store read failed, falling through to fetch')
    }
  }

  let localOriginal: Buffer | undefined
  if (haveLocalOriginal) {
    try {
      const readSignal = storeSignal()
      localOriginal = await readStream(origStore.createReadStream({ key: origKey, signal: readSignal } as any), readSignal)
    } catch (err) {
      // A stored original that cannot be read in time is treated like one that is
      // not there: the fetch path below is the fallback
      ctx.log.warn({ err: (err as Error).message, origKey }, 'stored original read failed, falling through to fetch')
    }
  }

  if (localOriginal) {
    ctx.tag({ store: 'original' })
    origin = realImage(localOriginal)
    contentType = await mimeMagic(origin.bytes)
  } else if (retentionData) {
    ctx.tag({ store: 'retention' })
    origin = realImage(retentionData)
    contentType = await mimeMagic(origin.bytes)
  } else {
    ctx.tag({ store: 'fetch' })
    try {
      const result = await fetchImageWithFallbacks(urlString, urlParams, ctx.get('user-agent') || 'EcencyProxy/1.0 (+https://github.com/ecency)', DefaultAvatar, ctx.log, { skipNegativeCache: !!invalidate, deadlineAt: fetchDeadlineAt })
      const res = result.res
      origin = result.isFallback
        ? fallbackImage(res.body, 'every mirror failed, default substituted')
        : realImage(res.body)
      contentType = await mimeMagic(origin.bytes)

      // A fallback here is the default avatar's bytes, not this user's image.
      // storeImage refuses to persist it under the user's key regardless; the
      // explicit check is what keeps the purge and the log honest.
      if (res.bytes <= Number.parseInt(config.get('max_image_size')) && !isFallbackImage(origin)) {
        ctx.log.debug('storing original %s', origKey)
        try {
          await storeImage(origStore, origKey, origin, storeSignal())
          // Purge Cloudflare cache for this user's avatar endpoint since we fetched a new image
          // One call, not four: purgeCache expands each URL across every service
          // hostname, so four separate calls would be eight requests to Cloudflare.
          const serviceUrl = new URL(config.get('service_url'))
          purgeCache(['', 'small', 'medium', 'large'].map(
            (size) => `${serviceUrl.origin}/u/${username}/avatar/${size}`
          ))
        } catch (err) {
          ctx.log.error({ err, origKey }, 'failed to store original avatar image')
          // Continue serving - storage failure shouldn't block response
        }
      } else {
        ctx.log.debug('not-storing original %s (bytes=%d, kind=%s)', origKey, res.bytes, origin.kind)
      }
    } catch (cause) {
      ctx.log.error(cause, 'Image fetch failed')
      throw new APIError({ cause, code: APIError.Code.InvalidImage })
    }
  }

  const { buffer: rv, contentType: finalType, isFallback } = await resizeImageWithOptions(
      origin.bytes,
      contentType,
      options,
      urlString,
      urlParams,
      ctx.get('user-agent') || '',
      DefaultAvatar,
      ctx.log,
      clientGoneSignal(ctx),
      true, // forceStill: avatars never need animation
      fetchDeadlineAt
  )
  contentType = finalType
  // A render inherits the provenance of its source; a resize that had to fall
  // back to the default is a placeholder whatever the source was
  const rendered: ServedImage = isFallback
    ? fallbackImage(rv, 'source unrenderable, default substituted')
    : derive(origin, rv)

  // A placeholder must never be persisted under the requested key: a stored copy
  // is indistinguishable from a real one on later requests and would be served
  // at the normal one-hour freshness until evicted or invalidated. storeImage
  // enforces that; a profile-lookup fallback is unaffected because it derives
  // both keys from the default image's own URL and never occupies a user's key.
  try {
    if (await storeImage(proxyStore, imageKey, rendered, storeSignal())) {
      ctx.log.debug('stored converted %s', imageKey)
    } else {
      ctx.log.debug('not-storing fallback variant %s (%s)', imageKey, (rendered as FallbackImage).reason)
    }
  } catch (err) {
    ctx.log.error({ err, imageKey }, 'failed to store converted avatar image')
    // Continue serving - storage failure shouldn't block response
  }

  // What the client asked for was this user's avatar; a real render inside a
  // substituted request is still a placeholder for that
  const response = worstOf(rendered, isProfileFallback
    ? fallbackImage(null, 'profile lookup fell back, default substituted') : undefined)

  ctx.set('Content-Type', contentType)
  // Vary on Accept header for proper content negotiation caching
  ctx.set('Vary', 'Accept')
  // If cache was bypassed, set no-cache to force revalidation, otherwise use standard cache
  if (shouldBypassCache) {
    ctx.set('Cache-Control', 'no-cache,must-revalidate')
  } else {
    ctx.set('Cache-Control', cacheControlFor(response, REAL_CACHE_CONTROL))
  }
  ctx.set('ETag', etagFor(response, imageKey, response.bytes, response.bytes.length))
  ctx.body = response.bytes
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
