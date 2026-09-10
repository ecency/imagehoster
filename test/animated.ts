import 'mocha'
import assert from 'assert'
import * as http from 'http'
import needle from 'needle'
import sharp from 'sharp'

import {app} from './../src/app'
import {
    animatedOutputType, animatedRenderPlan, countGifFrames, countWebpFrames, readAnimation,
    readGifAnimation, readWebpAnimation, renderAnimatedVariant,
} from './../src/animated'
import {ANIMATED_PASSTHROUGH_MAX_SIZE} from './../src/constants'
import {base58Enc, OutputFormat, ProxyOptions, ScalingMode} from './../src/utils'

import {makeAnimatedGif} from './animated-gif-fixture'

/** A source over the passthrough ceiling: 8 frames of noise, ~280KB. */
const bigGif = makeAnimatedGif({width: 200, height: 150, frames: 8, noisy: true})
/** A sticker-sized source under it: 6 flat frames, a couple of KB. */
const smallGif = makeAnimatedGif({width: 80, height: 60, frames: 6, noisy: false})

const fitOptions = (over: Partial<ProxyOptions> = {}): ProxyOptions =>
    ({mode: ScalingMode.Fit, format: OutputFormat.Match, ...over})

const WEBP_ACCEPT = 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'

/**
 * What a WebP-accepting client's options look like BY THE TIME this code runs.
 * parseOptions folds the Accept header into options.format before the render
 * path sees it — an unspecified or `match` request from such a client is already
 * AVIF or WEBP — so a unit-level fixture that passes `format: Match` plus a WebP
 * Accept describes a request the proxy never makes.
 */
const negotiatedWebp = (over: Partial<ProxyOptions> = {}): ProxyOptions =>
    fitOptions({format: OutputFormat.WEBP, ...over})

describe('animated sources', function() {

    it('the fixture really is an animation, and big enough to be worth transforming', async function() {
        const meta = await sharp(bigGif).metadata()
        assert.equal(meta.format, 'gif')
        assert.equal(meta.pages, 8)
        assert.equal(countGifFrames(bigGif), 8)
        assert.ok(bigGif.length > ANIMATED_PASSTHROUGH_MAX_SIZE,
            `fixture is ${bigGif.length} bytes, not over the ${ANIMATED_PASSTHROUGH_MAX_SIZE} ceiling`)
        assert.ok(smallGif.length < ANIMATED_PASSTHROUGH_MAX_SIZE)
        assert.equal(countGifFrames(smallGif), 6)
    })

    describe('frame counting reads the container, not the decoder', function() {
        it('counts every image descriptor in a GIF', function() {
            assert.equal(countGifFrames(makeAnimatedGif({frames: 3, noisy: false})), 3)
            assert.equal(countGifFrames(makeAnimatedGif({frames: 12, noisy: false})), 12)
        })

        it('counts frames that carry their own colour table', async function() {
            // A gifsicle-optimised GIF gives each frame a local palette; the walk
            // has to step over it to find the next block.
            const local = makeAnimatedGif({frames: 5, noisy: false, localPalette: true})
            assert.equal(countGifFrames(local), 5)
            assert.equal((await sharp(local).metadata()).pages, 5)
        })

        it('counts nothing in bytes that are not a GIF', function() {
            assert.equal(countGifFrames(Buffer.from('not an image at all')), 0)
            assert.equal(countGifFrames(Buffer.alloc(0)), 0)
        })

        it('counts ANMF chunks in an animated WebP, and nothing in a still one', async function() {
            this.timeout(10000)
            const animated = await sharp(bigGif, {animated: true}).webp({quality: 50}).toBuffer()
            assert.equal(countWebpFrames(animated), 8)
            const still = await sharp({create: {
                width: 20, height: 20, channels: 3, background: {r: 1, g: 2, b: 3},
            }}).webp().toBuffer()
            assert.equal(countWebpFrames(still), 0)
        })

        it('counts nothing in a truncated container', function() {
            assert.equal(countWebpFrames(Buffer.from('RIFF')), 0)
            assert.equal(countGifFrames(bigGif.subarray(0, 12)), 0)
        })

        it('counts no frames in a WebP that never declared itself an animation', function() {
            // Frames belong to an animation, and an animation declares itself with
            // an ANIM chunk. Without one there is no animation to preserve.
            const anmf = Buffer.concat([
                Buffer.from('ANMF', 'ascii'), Buffer.alloc(4), // an empty ANMF chunk
            ])
            const riff = Buffer.concat([
                Buffer.from('RIFF', 'ascii'), Buffer.alloc(4), Buffer.from('WEBP', 'ascii'), anmf,
            ])
            riff.writeUInt32LE(riff.length - 8, 4)
            assert.equal(countWebpFrames(riff), 0)
        })
    })

    describe('what may be transformed at all', function() {
        const plan = (over: Parameters<typeof animatedRenderPlan>[0]) => animatedRenderPlan(over)

        it('transforms a multi-page source over the ceiling', function() {
            // negotiatedWebp, not fitOptions: by the time a plan is made, parseOptions
            // has already turned a WebP-accepting client's `match` into WEBP.
            assert.deepEqual(plan({
                byteLength: bigGif.length,
                metadata: {pages: 8, width: 200, height: 150},
                options: negotiatedWebp(),
                acceptHeader: WEBP_ACCEPT,
            }), {frames: 8, outputType: 'image/webp'})
        })

        it('passes through a source libvips did not count frames for (an APNG loads as one page)', function() {
            assert.equal(plan({
                byteLength: bigGif.length,
                metadata: {pages: undefined, width: 200, height: 150},
                options: fitOptions(),
                acceptHeader: WEBP_ACCEPT,
            }), undefined)
            assert.equal(plan({
                byteLength: bigGif.length,
                metadata: {pages: 1, width: 200, height: 150},
                options: fitOptions(),
                acceptHeader: WEBP_ACCEPT,
            }), undefined)
        })

        it('passes through a source already small enough', function() {
            assert.equal(plan({
                byteLength: ANIMATED_PASSTHROUGH_MAX_SIZE,
                metadata: {pages: 8, width: 200, height: 150},
                options: fitOptions(),
                acceptHeader: WEBP_ACCEPT,
            }), undefined)
        })

        it('passes through when every frame together blows the pixel budget', function() {
            assert.equal(plan({
                byteLength: bigGif.length,
                // one frame is fine, 4000 of them are not
                metadata: {pages: 4000, width: 1000, height: 1000},
                options: fitOptions(),
                acceptHeader: WEBP_ACCEPT,
            }), undefined)
        })
    })

    describe('output format', function() {
        // parseOptions folds Accept into options.format before this runs, and the
        // variant key is built from options — so the format must be a function of
        // options ALONE. Reading Accept again here would hand two clients that
        // share a key two different formats.
        it('is WebP for a client whose negotiation landed on WebP or AVIF', function() {
            assert.equal(animatedOutputType(fitOptions({format: OutputFormat.WEBP})), 'image/webp')
            // libvips cannot write an animated AVIF, so AVIF resolves to WebP —
            // still the smaller animated format, and the same for every client
            // that reaches this key.
            assert.equal(animatedOutputType(fitOptions({format: OutputFormat.AVIF})), 'image/webp')
        })

        it('is GIF for a client that negotiated neither', function() {
            assert.equal(animatedOutputType(fitOptions()), 'image/gif')
        })

        // The case that WAS header-dependent: same key for every client, but the
        // bytes differed by Accept.
        it('is GIF for an explicit still format, whatever the client accepts', function() {
            assert.equal(animatedOutputType(fitOptions({format: OutputFormat.PNG})), 'image/gif')
            assert.equal(animatedOutputType(fitOptions({format: OutputFormat.JPEG})), 'image/gif')
        })
    })

    /**
     * The guard's real subject. What has to survive a re-encode is the animation
     * AS IT PLAYS, and libwebp reaches that by merging consecutive identical
     * frames and adding their delays together. Counting frames called those
     * correct renders failures and served multi-MB sources instead of them.
     */
    describe('reading an animation off its own container', function() {

        it('reads frames, running time and loop count from a GIF', function() {
            const gif = makeAnimatedGif({frames: 5, delay: 12, noisy: false, loop: 0})
            assert.deepEqual(readGifAnimation(gif), {frames: 5, durationMs: 600, loop: 0})
        })

        it('reads a finite loop count', function() {
            const gif = makeAnimatedGif({frames: 4, delay: 10, noisy: false, loop: 3})
            assert.equal(readGifAnimation(gif).loop, 3)
        })

        // A GIF that asks for 0 or 1 hundredths does not play that fast anywhere:
        // browsers have clamped anything under 20ms to 100ms for decades, and
        // libwebp writes that same 100ms when it re-encodes one. Reading the
        // stored value instead would call a correct re-encode a mismatch.
        it('reads a sub-20ms frame as the 100ms it actually plays at', function() {
            for (const delay of [0, 1]) {
                const gif = makeAnimatedGif({frames: 5, delay, noisy: false})
                assert.equal(readGifAnimation(gif).durationMs, 500, `delay ${delay}`)
            }
            // 2 hundredths is exactly at the boundary and is left alone
            assert.equal(readGifAnimation(makeAnimatedGif({frames: 5, delay: 2, noisy: false})).durationMs, 100)
        })

        it('reads them back off a WebP the encoder wrote', async function() {
            this.timeout(20000)
            const gif = makeAnimatedGif({width: 120, height: 90, frames: 6, delay: 10, noisy: true})
            const webp = await sharp(gif, {animated: true}).resize(60).webp({quality: 80, force: true}).toBuffer()
            const facts = readWebpAnimation(webp)
            assert.equal(facts.frames, 6)
            assert.equal(facts.durationMs, readGifAnimation(gif).durationMs)
            assert.equal(facts.loop, 0)
        })

        it('reports a still as no animation at all', async function() {
            this.timeout(20000)
            const still = await sharp({create: {width: 20, height: 20, channels: 3,
                background: {r: 1, g: 2, b: 3}}}).webp().toBuffer()
            assert.equal(readWebpAnimation(still).frames, 0)
            assert.equal(readAnimation(Buffer.from('not an image'), 'image/gif').frames, 0)
            assert.equal(readAnimation(still, 'image/jpeg').frames, 0)
        })
    })

    describe('rendering keeps the animation', function() {
        const encode = (image: sharp.Sharp) => image.toBuffer()

        it('renders an animated WebP with every frame, materially smaller', async function() {
            this.timeout(20000)
            const metadata = await sharp(bigGif).metadata()
            const out = await renderAnimatedVariant({
                bytes: bigGif, metadata, options: negotiatedWebp({width: 100}),
                acceptHeader: WEBP_ACCEPT, encode, log: console,
            })
            assert.ok(out, 'expected a render, got a passthrough')
            assert.equal(out!.contentType, 'image/webp')
            // The container says it is an animation of the same length...
            assert.equal(countWebpFrames(out!.buffer), metadata.pages)
            // ...and so does a decoder that never saw the source.
            const rendered = await sharp(out!.buffer).metadata()
            assert.equal(rendered.pages, metadata.pages)
            assert.equal(rendered.format, 'webp')
            assert.equal(rendered.width, 100)
            assert.ok(out!.buffer.length < bigGif.length / 2,
                `expected well under half of ${bigGif.length} bytes, got ${out!.buffer.length}`)
        })

        it('renders a GIF with every frame for a client that cannot take WebP', async function() {
            this.timeout(20000)
            const metadata = await sharp(bigGif).metadata()
            const out = await renderAnimatedVariant({
                bytes: bigGif, metadata, options: fitOptions({width: 100}),
                acceptHeader: 'image/*', encode, log: console,
            })
            assert.ok(out, 'expected a render, got a passthrough')
            assert.equal(out!.contentType, 'image/gif')
            assert.equal(countGifFrames(out!.buffer), metadata.pages)
            const rendered = await sharp(out!.buffer).metadata()
            assert.equal(rendered.pages, metadata.pages)
            assert.equal(rendered.format, 'gif')
            assert.equal(rendered.width, 100)
            assert.ok(out!.buffer.length < bigGif.length,
                `expected under ${bigGif.length} bytes, got ${out!.buffer.length}`)
        })

        it('keeps the frame delays and the loop count', async function() {
            this.timeout(20000)
            const metadata = await sharp(bigGif).metadata()
            const out = await renderAnimatedVariant({
                bytes: bigGif, metadata, options: fitOptions({width: 100}),
                acceptHeader: WEBP_ACCEPT, encode, log: console,
            })
            const rendered = await sharp(out!.buffer).metadata()
            assert.deepEqual(rendered.delay, metadata.delay)
            assert.equal(rendered.loop, metadata.loop)
        })

        /**
         * The regression this guard change exists for. A GIF that holds a pose
         * comes back from libwebp with fewer, longer frames: the same animation,
         * fewer container entries. Counting frames threw these away and served
         * the source, which on the GIF that started this work meant 1.5MB instead
         * of 169KB.
         */
        it('accepts a render whose frames were merged, as long as it still plays the same', async function() {
            this.timeout(20000)
            const held = makeAnimatedGif({width: 200, height: 150, frames: 32, hold: 4, delay: 10, noisy: true})
            const source = readGifAnimation(held)
            const metadata = await sharp(held).metadata()
            const out = await renderAnimatedVariant({
                bytes: held, metadata, options: negotiatedWebp({width: 100}),
                acceptHeader: WEBP_ACCEPT, encode, log: console,
            })
            assert.ok(out, 'expected a render, got a passthrough')
            const facts = readWebpAnimation(out!.buffer)
            // The merge really happened, so this is not a vacuous pass...
            assert.ok(facts.frames < source.frames,
                `expected fewer than ${source.frames} frames, got ${facts.frames}`)
            // ...and what matters survived it.
            assert.ok(facts.frames >= 2, 'still an animation')
            assert.equal(facts.durationMs, source.durationMs)
            assert.equal(facts.loop, source.loop)
            assert.ok(out!.buffer.length < held.length / 2)
        })

        it('hands the source back when the render would play for a different length of time', async function() {
            this.timeout(20000)
            const metadata = await sharp(bigGif).metadata()
            // A real animated WebP of the right shape, and the wrong duration:
            // same eight frames, each declaring five times the delay.
            const slower = makeAnimatedGif({width: 200, height: 150, frames: 8, delay: 50, noisy: true})
            const dropped: any[] = []
            const out = await renderAnimatedVariant({
                bytes: bigGif, metadata, options: negotiatedWebp({width: 100}), acceptHeader: WEBP_ACCEPT,
                encode: () => sharp(slower, {animated: true}).resize(100)
                    .webp({quality: 80, force: true}).toBuffer(),
                log: {warn: () => undefined, error: () => undefined, debug: () => undefined},
                onFramesDropped: (info) => dropped.push(info),
            })
            assert.equal(out, undefined)
            assert.equal(dropped[0].reason, 'duration')
            assert.equal(dropped[0].expectedDurationMs, readGifAnimation(bigGif).durationMs)
        })

        it('hands the source back when the render would stop looping', async function() {
            this.timeout(20000)
            const metadata = await sharp(bigGif).metadata()
            const once = makeAnimatedGif({width: 200, height: 150, frames: 8, delay: 10, noisy: true, loop: 1})
            const dropped: any[] = []
            const out = await renderAnimatedVariant({
                bytes: bigGif, metadata, options: negotiatedWebp({width: 100}), acceptHeader: WEBP_ACCEPT,
                // Same frames, same running time, plays through once instead of forever.
                encode: () => sharp(once, {animated: true}).resize(100)
                    .webp({quality: 80, force: true, loop: 1}).toBuffer(),
                log: {warn: () => undefined, error: () => undefined, debug: () => undefined},
                onFramesDropped: (info) => dropped.push(info),
            })
            assert.equal(out, undefined)
            assert.equal(dropped[0].reason, 'loop')
        })

        it('hands the source back when the render would not be smaller', async function() {
            this.timeout(20000)
            const metadata = await sharp(bigGif).metadata()
            const out = await renderAnimatedVariant({
                bytes: bigGif, metadata, options: fitOptions({width: 100}), acceptHeader: 'image/*',
                // A GIF re-encoded at its own size can quantise larger than the
                // source: the same frames, more bytes. Nothing to serve there.
                encode: () => Promise.resolve(Buffer.concat([bigGif, Buffer.alloc(1)])),
                log: {warn: () => undefined, error: () => undefined, debug: () => undefined},
            })
            assert.equal(out, undefined)
        })

        it('hands the source back when the encoder drops frames', async function() {
            this.timeout(20000)
            const metadata = await sharp(bigGif).metadata()
            const dropped: any[] = []
            const out = await renderAnimatedVariant({
                bytes: bigGif, metadata, options: negotiatedWebp({width: 100}), acceptHeader: WEBP_ACCEPT,
                // What a Sharp that ignored `animated: true` would hand back: the
                // first frame only. It must never be served as the variant.
                encode: (image) => sharp(bigGif).resize(100).webp({quality: 80, force: true}).toBuffer(),
                log: {warn: () => undefined, error: () => undefined, debug: () => undefined},
                onFramesDropped: (info) => dropped.push(info),
            })
            assert.equal(out, undefined)
            assert.equal(dropped.length, 1)
            assert.equal(dropped[0].reason, 'de-animated')
            assert.equal(dropped[0].got, 0)
            assert.equal(dropped[0].outputType, 'image/webp')
        })

        it('hands the source back when Sharp cannot render it', async function() {
            this.timeout(20000)
            const metadata = await sharp(bigGif).metadata()
            const out = await renderAnimatedVariant({
                bytes: bigGif, metadata, options: negotiatedWebp({width: 100}), acceptHeader: WEBP_ACCEPT,
                encode: () => Promise.reject(new Error('vips said no')),
                log: {warn: () => undefined, error: () => undefined, debug: () => undefined},
            })
            assert.equal(out, undefined)
        })
    })

    describe('through the proxy route', function() {
        let port: number
        let imagePort: number
        const server = http.createServer(app.callback())

        let served = bigGif
        const imageServer = http.createServer((_req, res) => {
            res.writeHead(200, {'Content-Type': 'image/gif', 'Content-Length': served.length})
            res.end(served)
        })

        before((done) => {
            server.listen(0, 'localhost', () => { port = (server.address() as any).port; done() })
        })
        before((done) => {
            imageServer.listen(0, 'localhost', () => { imagePort = (imageServer.address() as any).port; done() })
        })
        after((done) => { server.close(done) })
        after((done) => { imageServer.close(done) })
        beforeEach(() => { served = bigGif })

        const proxy = (name: string, query: string, headers: {[k: string]: string} = {}) =>
            needle('get', `http://localhost:${port}/p/${base58Enc(`http://localhost:${imagePort}/${name}`)}${query}`,
                   {headers} as any)

        it('serves a resized animated WebP to a client that takes WebP', async function() {
            this.slow(4000)
            this.timeout(20000)
            const res = await proxy('animated-webp.gif', '?width=100', {accept: WEBP_ACCEPT})
            assert.equal(res.statusCode, 200)
            assert.equal(res.headers['content-type'], 'image/webp')
            assert.equal(countWebpFrames(res.body), 8)
            const meta = await sharp(res.body).metadata()
            assert.equal(meta.pages, 8)
            assert.equal(meta.width, 100)
            assert.ok(res.body.length < bigGif.length / 2,
                `expected well under half of ${bigGif.length} bytes, got ${res.body.length}`)
        })

        it('serves the stored animated variant back on the next request', async function() {
            this.slow(4000)
            this.timeout(20000)
            const first = await proxy('animated-cached.gif', '?width=100', {accept: WEBP_ACCEPT})
            assert.equal(first.headers['content-type'], 'image/webp')
            // Second time round the variant comes out of the proxy store, whose
            // content type is sniffed from the stored bytes rather than remembered
            const second = await proxy('animated-cached.gif', '?width=100', {accept: WEBP_ACCEPT})
            assert.equal(second.statusCode, 200)
            assert.equal(second.headers['content-type'], 'image/webp')
            assert.equal(countWebpFrames(second.body), 8)
            assert.ok(second.body.equals(first.body), 'expected the stored variant, byte for byte')
        })

        it('serves a resized GIF, still animated, to a client that does not take WebP', async function() {
            this.slow(4000)
            this.timeout(20000)
            const res = await proxy('animated-gif.gif', '?width=100', {accept: 'image/*'})
            assert.equal(res.statusCode, 200)
            assert.equal(res.headers['content-type'], 'image/gif')
            assert.equal(countGifFrames(res.body), 8)
            const meta = await sharp(res.body).metadata()
            assert.equal(meta.pages, 8)
            assert.equal(meta.width, 100)
            assert.ok(res.body.length < bigGif.length,
                `expected under ${bigGif.length} bytes, got ${res.body.length}`)
        })

        it('never answers an animated source with a filmstrip AVIF', async function() {
            this.slow(4000)
            this.timeout(20000)
            const res = await proxy('animated-avif.gif', '?width=100&format=avif', {accept: '*/*'})
            assert.equal(res.statusCode, 200)
            // The point of the test: libvips writes a multi-page pipeline to AVIF
            // as one tall still, so an animated source must never answer as AVIF.
            assert.notEqual(res.headers['content-type'], 'image/avif')
            // It answers WebP, the one format libvips can both write animated and
            // every AVIF-capable client can decode. Which format it is must depend
            // on the options alone, never on this request's Accept, because the
            // variant key is built from the options.
            assert.equal(res.headers['content-type'], 'image/webp')
            assert.equal(countWebpFrames(res.body), 8)
        })

        // The variant for this key is WebP, but this client cannot decode WebP.
        // It gets the animation in its source format, and those bytes must not be
        // stored as the variant — the key belongs to the clients that asked for it.
        it('hands the source to a client that cannot take the WebP variant', async function() {
            this.slow(4000)
            this.timeout(20000)
            const res = await proxy('animated-noavif.gif', '?width=100&format=avif', {accept: 'image/avif'})
            assert.equal(res.statusCode, 200)
            assert.equal(res.headers['content-type'], 'image/gif')
            assert.equal(countGifFrames(res.body), 8)
            // Served, not stored: a WebP-capable client still gets the real variant.
            const second = await proxy('animated-noavif.gif', '?width=100&format=avif', {accept: WEBP_ACCEPT})
            assert.equal(second.headers['content-type'], 'image/webp')
        })

        // A THROWN encode is not a decision, it may be transient — so the source
        // is served but must never be stored as this key's variant, or the
        // unresized original is frozen there for every later request.
        it('does not cache the source when the encode throws', async function() {
            this.slow(4000)
            this.timeout(20000)
            const proto = sharp.prototype as unknown as {toBuffer: () => Promise<Buffer>}
            const realToBuffer = proto.toBuffer
            proto.toBuffer = () => Promise.reject(new Error('libvips exploded'))
            let res
            try {
                res = await proxy('animated-throws.gif', '?width=100', {accept: WEBP_ACCEPT})
            } finally {
                proto.toBuffer = realToBuffer
            }
            assert.equal(res!.statusCode, 200)
            assert.equal(countGifFrames(res!.body), 8, 'the animation is still served')

            // The next request must be free to try again — and succeed.
            const second = await proxy('animated-throws.gif', '?width=100', {accept: WEBP_ACCEPT})
            assert.equal(second.headers['content-type'], 'image/webp',
                'a retry produced the real variant, so the failure was not cached')
        })

        it('leaves a small animated source untouched', async function() {
            this.slow(4000)
            this.timeout(20000)
            served = smallGif
            const res = await proxy('sticker.gif', '?width=40', {accept: WEBP_ACCEPT})
            assert.equal(res.statusCode, 200)
            assert.equal(res.headers['content-type'], 'image/gif')
            assert.ok(res.body.equals(smallGif), 'expected the source bytes, untouched')
        })

        it('answers a blur placeholder from the first frame, not the whole animation', async function() {
            this.slow(4000)
            this.timeout(20000)
            const res = await proxy('animated-blur.gif', '?blur=1', {accept: WEBP_ACCEPT})
            assert.equal(res.statusCode, 200)
            assert.equal(res.headers['content-type'], 'image/jpeg')
            const meta = await sharp(res.body).metadata()
            assert.equal(meta.width, 20)
            // One frame of a 200x150 source, not eight of them stacked into a strip
            assert.equal(meta.height, 15)
            assert.ok(res.body.length < 2000, `expected an LQIP, got ${res.body.length} bytes`)
        })
    })
})
