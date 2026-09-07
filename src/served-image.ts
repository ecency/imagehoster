import {AbstractBlobStore, BlobKey} from 'abstract-blob-store'
import etag from 'etag'

import {storeWrite} from './utils'

/**
 * Bytes together with where they came from.
 *
 * Three fixes in three weeks were one bug: the decision "is this a placeholder"
 * lived in a boolean next to the bytes, assigned in several places over a long
 * handler, and the store write, the Cache-Control header and the ETag each read
 * it independently. Any branch that produced bytes without touching the flag
 * shipped a placeholder as a real image: stored under the user's key, cached at
 * the edge for a year, or validated by the real image's ETag.
 *
 * A ServedImage carries the answer with the bytes. Rendering a fallback yields a
 * fallback (`derive`), the header and the ETag are functions of the value, and
 * the store helper refuses anything that is not real, so no call site needs to
 * remember the check.
 */
export type Provenance = 'real' | 'fallback' | 'passthrough'

export interface RealImage<T = Buffer> {
    readonly kind: 'real'
    readonly bytes: T
}

export interface FallbackImage<T = Buffer> {
    readonly kind: 'fallback'
    readonly bytes: T
    /** what the placeholder stands in for, for logs */
    readonly reason: string
}

/**
 * The source's own bytes handed through because the render, or the conversion
 * this client needed, failed (a JPEG Sharp cannot decode but a browser can; a
 * transient encode failure). Real content, but not the rendered variant and
 * possibly not what this client can display: it is never stored under the
 * variant key, it carries its own ETag so a client that cached it is not told
 * "not modified" by the real variant once a later render succeeds, and it is
 * fresh for an hour rather than a year.
 */
export interface PassthroughImage<T = Buffer> {
    readonly kind: 'passthrough'
    readonly bytes: T
    readonly reason: string
}

export type ServedImage<T = Buffer> = RealImage<T> | FallbackImage<T> | PassthroughImage<T>

export function realImage<T>(bytes: T): RealImage<T> {
    return {kind: 'real', bytes}
}

export function fallbackImage<T>(bytes: T, reason: string): FallbackImage<T> {
    return {kind: 'fallback', bytes, reason}
}

export function passthroughImage<T>(bytes: T, reason: string): PassthroughImage<T> {
    return {kind: 'passthrough', bytes, reason}
}

export function isFallbackImage<T>(image: ServedImage<T>): image is FallbackImage<T> {
    return image.kind === 'fallback'
}

export function isRealImage<T>(image: ServedImage<T>): image is RealImage<T> {
    return image.kind === 'real'
}

/**
 * New bytes, same provenance: the render of a placeholder is a placeholder, the
 * render of a real image is real. `reason` may be sharpened on the way.
 */
export function derive<T, U>(from: ServedImage<T>, bytes: U, reason?: string): ServedImage<U> {
    switch (from.kind) {
        case 'fallback': return fallbackImage(bytes, reason || from.reason)
        case 'passthrough': return passthroughImage(bytes, reason || from.reason)
        default: return realImage(bytes)
    }
}

/**
 * Whichever is worse: a real fetch inside a substituted request is still a
 * placeholder for what the client asked for.
 */
export function worstOf<T>(image: ServedImage<T>, substituted: FallbackImage<unknown> | undefined): ServedImage<T> {
    return substituted ? fallbackImage(image.bytes, substituted.reason) : image
}

/** The fallback contract: a placeholder is fresh for two minutes, never longer. */
export const FALLBACK_CACHE_CONTROL = 'public,max-age=120'
/**
 * A passthrough is genuine content but a degraded answer: the render or the
 * conversion this client needed did not happen, often transiently. An hour keeps
 * a hot source from being re-attempted on every request and still lets a fix
 * or a recovered encoder reach clients the same day, where the real variant's
 * year of immutability would pin the degraded bytes.
 */
export const PASSTHROUGH_CACHE_CONTROL = 'public,max-age=3600'

export function cacheControlFor(image: {kind: Provenance}, realPolicy: string): string {
    switch (image.kind) {
        case 'fallback': return FALLBACK_CACHE_CONTROL
        case 'passthrough': return PASSTHROUGH_CACHE_CONTROL
        default: return realPolicy
    }
}

/**
 * The real variant's ETag is derived from the key alone, so a placeholder that
 * shared it would be validated by the real image and vice versa: a cache holding
 * the placeholder asks "still the same?", the origin answers with the recovered
 * image under the same ETag, the cache in front of us collapses that into a 304,
 * and the placeholder outlives its 120s contract by as long as anyone keeps
 * asking. Deterministic, so a placeholder still revalidates as a placeholder.
 */
export function fallbackEtag(imageKey: string): string {
    return etag(imageKey + '|fallback')
}

export function passthroughEtag(imageKey: string): string {
    return etag(imageKey + '|passthrough')
}

export function etagFor(image: {kind: Provenance}, imageKey: string): string {
    switch (image.kind) {
        case 'fallback': return fallbackEtag(imageKey)
        case 'passthrough': return passthroughEtag(imageKey)
        default: return etag(imageKey)
    }
}

/**
 * Persists a rendered variant or an original, and refuses anything else.
 *
 * Stored bytes have no provenance on the way back out: a later request reads
 * them as a real variant, serves them at the real freshness and under the real
 * ETag. So the only safe rule is that only a real image enters a store under a
 * key that means "the image the client asked for": a placeholder would poison
 * the key, a passthrough would make later requests skip rendering. Returns
 * whether a write happened; the caller still owns error handling for a write
 * that fails.
 */
export async function storeImage(store: AbstractBlobStore, key: BlobKey, image: ServedImage): Promise<boolean> {
    if (!isRealImage(image)) { return false }
    await storeWrite(store, key, image.bytes)
    return true
}
