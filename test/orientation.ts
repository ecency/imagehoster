import 'mocha'
import assert from 'assert'
import Sharp from 'sharp'

import { resizeImageWithOptions } from '../src/image-resizer'
import { applyProxyResize, OutputFormat, ProxyOptions, readExifOrientation, ScalingMode } from '../src/utils'

// A 40x20 image with four distinct quadrants, so every rotation and mirror of it
// produces different pixels.
async function plainJpeg(): Promise<Buffer> {
    const w = 40, h = 20
    const raw = Buffer.alloc(w * h * 3)
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const q = (x < w / 2 ? 0 : 1) + (y < h / 2 ? 0 : 2)
            const rgb = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0]][q]
            raw.set(rgb, (y * w + x) * 3)
        }
    }
    return Sharp(raw, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 100 }).toBuffer()
}

// A big-endian EXIF APP1 whose IFD0 holds the orientation. With `badThumbnail`
// IFD0 also carries a thumbnail pointer (0x0201/0x0202) that runs far past the
// end of the block, in the tag order some phone uploads use. libexif 0.6.24
// rejects that IFD, so libvips reports no orientation at all.
function exifApp1(orientation: number, badThumbnail: boolean): Buffer {
    const entries: Array<[number, number, number, number]> = [] // tag, type, count, value
    if (badThumbnail) {
        entries.push([0x0201, 4, 1, 401], [0x0202, 4, 1, 48807])
    }
    entries.push([0x0112, 3, 1, orientation << 16]) // SHORT, left-justified
    const tiff = Buffer.alloc(8 + 2 + entries.length * 12 + 4)
    tiff.write('MM', 0, 'latin1')
    tiff.writeUInt16BE(42, 2)
    tiff.writeUInt32BE(8, 4)
    tiff.writeUInt16BE(entries.length, 8)
    entries.forEach(([tag, type, count, value], i) => {
        const o = 10 + i * 12
        tiff.writeUInt16BE(tag, o)
        tiff.writeUInt16BE(type, o + 2)
        tiff.writeUInt32BE(count, o + 4)
        tiff.writeUInt32BE(value, o + 8)
    })
    const body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff])
    const header = Buffer.from([0xff, 0xe1, 0, 0])
    header.writeUInt16BE(body.length + 2, 2)
    return Buffer.concat([header, body])
}

function withExif(jpeg: Buffer, app1: Buffer): Buffer {
    return Buffer.concat([jpeg.subarray(0, 2), app1, jpeg.subarray(2)])
}

const options: ProxyOptions = { mode: ScalingMode.Fit, format: OutputFormat.Match, width: 0, height: 0 }

// The same steps the proxy takes: read metadata, resize, encode.
async function render(input: Buffer) {
    const metadata = await Sharp(input).metadata()
    const image = Sharp(input, { failOnError: false })
    applyProxyResize(image, metadata, options)
    return image.raw().toBuffer({ resolveWithObject: true })
}

describe('EXIF orientation', function() {
    let plain: Buffer
    before(async function() {
        plain = await plainJpeg()
    })

    it('fixture: libvips reads well-formed EXIF and loses the malformed one', async function() {
        const good = await Sharp(withExif(plain, exifApp1(6, false))).metadata()
        const bad = await Sharp(withExif(plain, exifApp1(6, true))).metadata()
        assert.strictEqual(good.orientation, 6)
        assert.strictEqual(bad.orientation, undefined)
        assert.ok(bad.exif && bad.exif.length > 0, 'the EXIF block still reaches metadata')
    })

    it('serves orientation 6 with a bad thumbnail pointer upright', async function() {
        const out = await render(withExif(plain, exifApp1(6, true)))
        assert.strictEqual(out.info.width, 20)
        assert.strictEqual(out.info.height, 40)
    })

    for (let orientation = 2; orientation <= 8; orientation++) {
        it(`renders orientation ${orientation} with a bad thumbnail pointer like the well-formed one`, async function() {
            const expected = await render(withExif(plain, exifApp1(orientation, false)))
            const actual = await render(withExif(plain, exifApp1(orientation, true)))
            assert.deepStrictEqual(
                [actual.info.width, actual.info.height],
                [expected.info.width, expected.info.height],
            )
            assert.ok(actual.data.equals(expected.data), 'pixels match the well-formed render')
        })
    }

    it('leaves images without EXIF and with orientation 1 unchanged', async function() {
        for (const input of [plain, withExif(plain, exifApp1(1, true))]) {
            const out = await render(input)
            const expected = await Sharp(plain).rotate().raw().toBuffer()
            assert.deepStrictEqual([out.info.width, out.info.height], [40, 20])
            assert.ok(out.data.equals(expected))
        }
    })

    it('serves an avatar or cover with a bad thumbnail pointer upright', async function() {
        const input = withExif(plain, exifApp1(6, true))
        for (const mode of [ScalingMode.Fit, ScalingMode.Cover]) {
            const out = await resizeImageWithOptions(input, 'image/jpeg',
                { mode, format: OutputFormat.JPEG, width: mode === ScalingMode.Cover ? 10 : 0, height: 0 },
                'https://example.invalid/a.jpg', '', 'test', 'https://example.invalid/default.png', { error() {} },
                undefined)
            const meta = await Sharp(out.buffer).metadata()
            assert.ok(meta.height! > meta.width!, `${mode}: ${meta.width}x${meta.height} is portrait`)
        }
    })

    describe('readExifOrientation', function() {
        const tiffOf = (o: number) => exifApp1(o, true).subarray(4) // drop the APP1 marker + length

        it('reads the tag with and without the Exif prefix, in both byte orders', function() {
            assert.strictEqual(readExifOrientation(tiffOf(6)), 6)
            assert.strictEqual(readExifOrientation(tiffOf(8).subarray(6)), 8)
            const le = Buffer.from('49492a00080000000100120103000100000003000000' + '00000000', 'hex')
            assert.strictEqual(readExifOrientation(le), 3)
        })

        it('returns undefined for malformed or missing input without throwing', function() {
            const full = tiffOf(6)
            const pastEnd = Buffer.from(full)
            pastEnd.writeUInt32BE(0xffff, 6 + 4) // IFD0 offset beyond the block
            const zeroCount = Buffer.from(full)
            zeroCount.writeUInt16BE(0, 6 + 8)
            const outOfRange = exifApp1(9, false).subarray(4)
            for (const input of [undefined, Buffer.alloc(0), Buffer.from('Exif\0\0XX'), full.subarray(0, 20),
                pastEnd, zeroCount, outOfRange]) {
                assert.strictEqual(readExifOrientation(input), undefined)
            }
        })
    })
})
