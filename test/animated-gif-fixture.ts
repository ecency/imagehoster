/**
 * A real animated GIF89a, built here rather than committed as a binary.
 *
 * The animation tests need a source with a known frame count that is big enough
 * to be worth transforming, and the sharp/libvips this repo pins cannot write
 * one: it has no way to set a page height on a raw input, so anything it encodes
 * from scratch is a single-page image. So the container is written by hand,
 * LZW and all. Frames are drawn either as flat bands (compresses like a sticker)
 * or as noise (compresses like a photographic GIF, which is what the multi-MB
 * ones in post bodies are).
 */

/** GIF-variant LZW: emits a clear code, then codes of a width that grows with the table. */
function lzwEncode(minCodeSize: number, indices: Buffer): Buffer {
    const clearCode = 1 << minCodeSize
    const eoiCode = clearCode + 1
    let codeSize = minCodeSize + 1
    let nextCode = eoiCode + 1
    let table = new Map<number, number>()
    const out: number[] = []
    let pending = 0
    let pendingBits = 0
    const emit = (code: number) => {
        pending |= code << pendingBits
        pendingBits += codeSize
        while (pendingBits >= 8) {
            out.push(pending & 0xff)
            pending >>>= 8
            pendingBits -= 8
        }
    }

    emit(clearCode)
    let prefix = indices[0]
    for (let i = 1; i < indices.length; i++) {
        const k = indices[i]
        const key = prefix * 4096 + k
        const known = table.get(key)
        if (known !== undefined) {
            prefix = known
            continue
        }
        emit(prefix)
        if (nextCode === 4096) {
            emit(clearCode)
            nextCode = eoiCode + 1
            codeSize = minCodeSize + 1
            table = new Map<number, number>()
        } else {
            if (nextCode >= (1 << codeSize)) { codeSize++ }
            table.set(key, nextCode++)
        }
        prefix = k
    }
    emit(prefix)
    emit(eoiCode)
    if (pendingBits > 0) { out.push(pending & 0xff) }
    return Buffer.from(out)
}

/** Wrap payload bytes in GIF sub-blocks of at most 255 bytes, terminated by an empty one. */
function subBlocks(data: Buffer): Buffer {
    const parts: Buffer[] = []
    for (let i = 0; i < data.length; i += 255) {
        const chunk = data.subarray(i, Math.min(i + 255, data.length))
        parts.push(Buffer.from([chunk.length]), chunk)
    }
    parts.push(Buffer.from([0]))
    return Buffer.concat(parts)
}

export interface AnimatedGifOptions {
    width?: number
    height?: number
    frames?: number
    /** Frame delay in hundredths of a second, as GIF stores it. */
    delay?: number
    /** Noisy frames make a big, barely-compressible GIF; flat ones make a tiny one. */
    noisy?: boolean
    /**
     * Give every frame its own colour table instead of sharing the global one,
     * which is what a gifsicle-optimised GIF from a post body looks like.
     */
    localPalette?: boolean
    /**
     * Repeat each drawn pose this many times, so the GIF holds still between
     * moves. Real animations do this constantly (a talking head between words, a
     * loop that pauses on its punchline) and it is what makes an encoder merge
     * frames: libwebp writes one frame carrying the whole held delay.
     */
    hold?: number
    /** Times to play the animation, as the NETSCAPE2.0 block stores it; 0 is forever. */
    loop?: number
}

export function makeAnimatedGif(options: AnimatedGifOptions = {}): Buffer {
    const width = options.width ?? 200
    const height = options.height ?? 150
    const frames = options.frames ?? 8
    const delay = options.delay ?? 10
    const noisy = options.noisy ?? true
    const localPalette = options.localPalette ?? false
    const hold = Math.max(1, options.hold ?? 1)
    const loop = options.loop ?? 0

    const palette = Buffer.alloc(256 * 3)
    for (let i = 0; i < 256; i++) {
        palette[i * 3] = i
        palette[i * 3 + 1] = (i * 5) & 0xff
        palette[i * 3 + 2] = 255 - i
    }

    const parts: Buffer[] = [Buffer.from('GIF89a', 'ascii')]

    const screen = Buffer.alloc(7)
    screen.writeUInt16LE(width, 0)
    screen.writeUInt16LE(height, 2)
    screen[4] = 0x80 | (7 << 4) | 7  // global colour table, 8-bit colour, 256 entries
    parts.push(screen, palette)

    // NETSCAPE2.0 application extension: how many times to play, 0 being forever
    const netscape = Buffer.from([0x03, 0x01, 0x00, 0x00, 0x00])
    netscape.writeUInt16LE(loop, 2)
    parts.push(Buffer.from([0x21, 0xff, 0x0b]), Buffer.from('NETSCAPE2.0', 'ascii'), netscape)

    const poses = Math.ceil(frames / hold)
    for (let f = 0; f < frames; f++) {
        // Frames within one hold are drawn identically, byte for byte.
        const pose = Math.floor(f / hold)
        const pixels = Buffer.alloc(width * height)
        for (let y = 0; y < height; y++) {
            const row = y * width
            if (noisy) {
                for (let x = 0; x < width; x++) {
                    pixels[row + x] = (((x * 7919 + y * 104729 + pose * 15485863) ^ (x * y)) >>> 3) & 0xff
                }
            } else {
                pixels.fill(((y >> 4) * 16) & 0xff, row, row + width)
            }
        }
        // A block that moves between poses, so the poses differ from each other
        const blockSize = Math.max(4, Math.floor(Math.min(width, height) / 5))
        const left = Math.floor((pose / poses) * (width - blockSize))
        const top = Math.floor(height / 3)
        for (let y = top; y < Math.min(top + blockSize, height); y++) {
            pixels.fill(200, y * width + left, y * width + left + blockSize)
        }

        const control = Buffer.alloc(8)
        control[0] = 0x21
        control[1] = 0xf9
        control[2] = 0x04
        control[3] = 0x04                     // disposal method: do not dispose
        control.writeUInt16LE(delay, 4)
        parts.push(control)

        const descriptor = Buffer.alloc(10)
        descriptor[0] = 0x2c
        descriptor.writeUInt16LE(width, 5)
        descriptor.writeUInt16LE(height, 7)
        if (localPalette) { descriptor[9] = 0x80 | 7 }   // local colour table, 256 entries
        parts.push(descriptor)
        if (localPalette) { parts.push(palette) }
        parts.push(Buffer.from([8]), subBlocks(lzwEncode(8, pixels)))
    }

    parts.push(Buffer.from([0x3b]))           // trailer
    return Buffer.concat(parts)
}
