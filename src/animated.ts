/**
 * Making an animated source smaller without losing its animation.
 *
 * Every animated GIF used to be handed back untouched at every size, because a
 * Sharp resize that forgets `animated: true` silently renders the first frame
 * and ships a still. Passthrough is safe, and it is also why the LCP element of
 * a feed page could be a 1.5MB GIF that `?width=320` did nothing to.
 *
 * With the sharp/libvips this repo pins (sharp 0.33.5, libvips 8.15.3) an
 * animated resize does keep every frame, for the two formats libvips can both
 * read and write as animations: GIF and WebP. Everything else in this file is
 * there to make sure that is the only path we ever take.
 *
 *  - libvips must have counted the frames itself (`pages > 1`). It does not read
 *    APNG animation at all: an APNG loads as a single page, so a transform would
 *    silently de-animate it. APNG keeps the passthrough.
 *  - The output format must be able to hold an animation. AVIF, PNG and JPEG
 *    cannot: handed a multi-page pipeline they write the frames as one tall
 *    "filmstrip" still. An animated source is therefore only ever encoded to
 *    animated WebP (for a client that takes WebP) or back to GIF.
 *  - The bytes we are about to serve must carry the same number of frames as the
 *    source, counted off the output container itself, and must be smaller than
 *    the source. Either check failing hands the original bytes back.
 *
 * The frame count is read from the container rather than from a second libvips
 * decode on purpose: the thing being guarded against is libvips dropping frames,
 * so asking libvips whether it dropped any is not an independent answer.
 */

import Sharp from 'sharp'

import {ANIMATED_PASSTHROUGH_MAX_SIZE, MAX_INPUT_PIXELS} from './constants'
import {isEncodeAborted} from './encode-limit'
import {applyProxyResize, buildSharpPipeline, OutputFormat, ProxyOptions, supportsWebP} from './utils'

/** The only output types that can carry an animation here. */
export type AnimatedOutputType = 'image/webp' | 'image/gif'

/**
 * Frames declared by a GIF's own container: one per image descriptor.
 *
 * The walk skips extension blocks and each frame's LZW sub-blocks by their
 * length bytes, so it costs a handful of jumps per frame, not a decode. Anything
 * it cannot follow ends the walk and reports what it counted so far, which
 * fails the equality check at the call site rather than passing on a guess.
 */
export function countGifFrames(buffer: Buffer): number {
    if (buffer.length < 13 || buffer.toString('ascii', 0, 3) !== 'GIF') { return 0 }
    const packed = buffer[10]
    let p = 13
    // Global colour table, when the screen descriptor says there is one
    if (packed & 0x80) { p += 3 * (1 << ((packed & 0x07) + 1)) }
    const skipSubBlocks = () => {
        while (p < buffer.length && buffer[p] !== 0) { p += buffer[p] + 1 }
        p++
    }
    let frames = 0
    while (p < buffer.length) {
        const block = buffer[p]
        if (block === 0x3b) { break }           // trailer
        if (block === 0x21) {                   // extension: label + sub-blocks
            p += 2
            skipSubBlocks()
            continue
        }
        if (block === 0x2c) {                   // image descriptor: one frame
            frames++
            const localPacked = buffer[p + 9]
            p += 10
            if (localPacked & 0x80) { p += 3 * (1 << ((localPacked & 0x07) + 1)) }
            p += 1                              // LZW minimum code size
            skipSubBlocks()
            continue
        }
        break                                   // not a block boundary any more
    }
    return frames
}

/**
 * Frames declared by a WebP's own RIFF container: one per ANMF chunk, and only
 * when the ANIM chunk that makes the file an animation is present.
 */
export function countWebpFrames(buffer: Buffer): number {
    if (buffer.length < 16 ||
        buffer.toString('ascii', 0, 4) !== 'RIFF' ||
        buffer.toString('ascii', 8, 12) !== 'WEBP') { return 0 }
    let p = 12
    let frames = 0
    let isAnimation = false
    while (p + 8 <= buffer.length) {
        const tag = buffer.toString('ascii', p, p + 4)
        const size = buffer.readUInt32LE(p + 4)
        if (tag === 'ANIM') { isAnimation = true }
        if (tag === 'ANMF') { frames++ }
        p += 8 + size + (size % 2)              // chunks are padded to even length
    }
    return isAnimation ? frames : 0
}

/** Frames the given bytes declare, for the output types we encode animations to. */
export function countAnimationFrames(buffer: Buffer, contentType: string): number {
    switch (contentType) {
        case 'image/gif': return countGifFrames(buffer)
        case 'image/webp': return countWebpFrames(buffer)
        default: return 0
    }
}

/**
 * The animated output type for this request, or undefined when the source must
 * be passed through untouched.
 *
 * WebP is worth about three times the saving of a re-encoded GIF, so it is used
 * whenever the client will take it: either it asked for WebP outright, or it
 * negotiated AVIF/WebP through Accept (an animated AVIF is not something libvips
 * can write, so an AVIF request that also accepts WebP is served WebP). A client
 * that named neither gets its GIF back, resized.
 */
export function animatedOutputType(options: ProxyOptions): AnimatedOutputType {
    // Decided by options alone, never by the Accept header directly. parseOptions
    // has ALREADY folded Accept into options.format (an unspecified or `match`
    // request becomes AVIF or WEBP for a client that takes them), and the variant
    // key is built from options — so reading Accept a second time here could hand
    // two clients that share a key two different formats. That is what happened
    // for an explicit ?format=png or ?format=jpeg: same key for everyone, but WebP
    // bytes for a WebP-accepting client and GIF bytes for the next one.
    //
    // AVIF maps to WebP rather than to itself because libvips cannot write an
    // animated AVIF: handed a multi-page pipeline it writes the frames as one
    // tall still. A negotiated AVIF client still gets the smaller animated
    // format, and the key it read AVIF from stays consistent for every client
    // that resolves to it.
    if (options.format === OutputFormat.WEBP || options.format === OutputFormat.AVIF) {
        return 'image/webp'
    }
    return 'image/gif'
}

/**
 * Whether this source can be re-rendered as an animation at all, and how many
 * frames the result has to have. Undefined means "serve the original bytes".
 */
export function animatedRenderPlan(input: {
    byteLength: number,
    metadata: {pages?: number, width?: number, height?: number},
    options: ProxyOptions,
    acceptHeader: string,
}): {frames: number, outputType: AnimatedOutputType} | undefined {
    const {pages, width, height} = input.metadata
    // libvips has to have seen the frames: an APNG, which it loads as a single
    // page, must never reach an encoder that would write that page as a still.
    if (typeof pages !== 'number' || pages < 2 || !width || !height) { return undefined }
    // Not worth the encode. A sticker is already small and a re-encode of one
    // saves a few KB at the price of a full multi-frame decode.
    if (input.byteLength <= ANIMATED_PASSTHROUGH_MAX_SIZE) { return undefined }
    // An animated decode is the whole "toilet roll" of frames at once, so the
    // pixel budget applies to every frame together. Past it there is no safe
    // render, and the passthrough is what the request already got yesterday.
    if (pages * width * height > MAX_INPUT_PIXELS) { return undefined }
    return {frames: pages, outputType: animatedOutputType(input.options)}
}

/**
 * Re-render an animated source at the requested size, or return undefined to
 * say the original bytes should be served.
 *
 * `encode` is the caller's encode runner (the request path passes the gated,
 * abortable one) so this stays out of the business of queueing and deadlines. An
 * abandoned encode propagates; anything else Sharp raises is a reason to fall
 * back to the source, not to fail the request.
 */
export async function renderAnimatedVariant(input: {
    bytes: Buffer,
    metadata: Sharp.Metadata,
    options: ProxyOptions,
    acceptHeader: string,
    encode: (image: Sharp.Sharp) => Promise<Buffer>,
    log: any,
    onFramesDropped?: (info: {expected: number, got: number, outputType: AnimatedOutputType}) => void,
}): Promise<{buffer: Buffer, contentType: AnimatedOutputType} | undefined> {
    const plan = animatedRenderPlan({
        byteLength: input.bytes.length,
        metadata: input.metadata,
        options: input.options,
        acceptHeader: input.acceptHeader,
    })
    if (!plan) { return undefined }

    let buffer: Buffer
    try {
        const image = buildSharpPipeline(input.bytes, true)
        applyProxyResize(image, input.metadata, input.options)
        if (plan.outputType === 'image/webp') {
            // Same quality as the still WebP path, and libvips carries the
            // source's frame delays and loop count across on its own.
            image.webp({quality: 80, alphaQuality: 80, force: true})
        } else {
            image.gif()
        }
        buffer = await input.encode(image)
    } catch (err) {
        if (isEncodeAborted(err)) { throw err }
        input.log.warn({err, outputType: plan.outputType}, 'animated render failed, serving source untouched')
        return undefined
    }

    const frames = countAnimationFrames(buffer, plan.outputType)
    if (frames !== plan.frames) {
        // The one outcome this whole path exists to prevent. Serve the source and
        // tell someone: it means this libvips no longer round-trips animation.
        input.log.error({expected: plan.frames, got: frames, outputType: plan.outputType},
            'animated render lost frames, serving source untouched')
        if (input.onFramesDropped) {
            input.onFramesDropped({expected: plan.frames, got: frames, outputType: plan.outputType})
        }
        return undefined
    }

    if (buffer.length >= input.bytes.length) {
        // Re-encoding a GIF at its own size can quantise it larger than it was.
        // Nothing to gain, and the source is the better-quality copy.
        input.log.debug({bytes: buffer.length, sourceBytes: input.bytes.length, outputType: plan.outputType},
            'animated render is not smaller, serving source untouched')
        return undefined
    }

    return {buffer, contentType: plan.outputType}
}
