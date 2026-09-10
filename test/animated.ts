import 'mocha'
import assert from 'assert'
import * as http from 'http'
import needle from 'needle'
import sharp from 'sharp'

import {app} from './../src/app'
import {
    animatedOutputType, animatedRenderPlan, countGifFrames, countWebpFrames, renderAnimatedVariant,
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
            assert.deepEqual(plan({
                byteLength: bigGif.length,
                metadata: {pages: 8, width: 200, height: 150},
                options: fitOptions(),
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
        it('is WebP for a client that names it', function() {
            assert.equal(animatedOutputType(fitOptions(), WEBP_ACCEPT), 'image/webp')
            assert.equal(animatedOutputType(fitOptions({format: OutputFormat.WEBP}), ''), 'image/webp')
        })

        it('is WebP, never AVIF, when the client negotiated AVIF', function() {
            // libvips cannot write an animated AVIF: handed a multi-page pipeline it
            // writes the frames as one tall still.
            assert.equal(animatedOutputType(fitOptions({format: OutputFormat.AVIF}), WEBP_ACCEPT), 'image/webp')
        })

        it('is GIF for a client that named neither', function() {
            assert.equal(animatedOutputType(fitOptions(), 'image/*'), 'image/gif')
            assert.equal(animatedOutputType(fitOptions({format: OutputFormat.AVIF}), 'image/avif'), 'image/gif')
            assert.equal(animatedOutputType(fitOptions({format: OutputFormat.PNG}), 'image/png'), 'image/gif')
        })
    })

    describe('rendering keeps the animation', function() {
        const encode = (image: sharp.Sharp) => image.toBuffer()

        it('renders an animated WebP with every frame, materially smaller', async function() {
            this.timeout(20000)
            const metadata = await sharp(bigGif).metadata()
            const out = await renderAnimatedVariant({
                bytes: bigGif, metadata, options: fitOptions({width: 100}),
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
                bytes: bigGif, metadata, options: fitOptions({width: 100}), acceptHeader: WEBP_ACCEPT,
                // What a Sharp that ignored `animated: true` would hand back: the
                // first frame only. It must never be served as the variant.
                encode: (image) => sharp(bigGif).resize(100).webp({quality: 80, force: true}).toBuffer(),
                log: {warn: () => undefined, error: () => undefined, debug: () => undefined},
                onFramesDropped: (info) => dropped.push(info),
            })
            assert.equal(out, undefined)
            assert.deepEqual(dropped, [{expected: 8, got: 0, outputType: 'image/webp'}])
        })

        it('hands the source back when Sharp cannot render it', async function() {
            this.timeout(20000)
            const metadata = await sharp(bigGif).metadata()
            const out = await renderAnimatedVariant({
                bytes: bigGif, metadata, options: fitOptions({width: 100}), acceptHeader: WEBP_ACCEPT,
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
            assert.notEqual(res.headers['content-type'], 'image/avif')
            assert.equal(res.headers['content-type'], 'image/gif')
            assert.equal(countGifFrames(res.body), 8)
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
