#!/usr/bin/env node
/**
 * Encoder and decoder benchmark for the codec build inside an imagehoster image.
 *
 * Encode side: runs the production pipeline shape (rotate, resize to 1280 fit,
 * encode) over a directory of source images and reports median wall time, output
 * size and a PSNR fidelity proxy per AVIF effort, plus WebP for reference.
 *
 * Decode side: BENCH_DECODE_DIR names a directory of encoded files (AVIF, HEIC)
 * that is decoded as-is, with metadata and full-decode timings and the sha256 of
 * every input, so two images can be compared on IDENTICAL bytes. Build that corpus
 * once from the baseline image with BENCH_SAVE_DIR, then point both runs at it.
 * Decoding what each image itself just encoded would change the bitstream and the
 * decoder at the same time and attribute nothing.
 *
 *   docker run --rm --cpuset-cpus=<same for both> \
 *     -v <sources>:/bench/src:ro -v <this dir>:/bench/scripts:ro -v <out>:/bench/out \
 *     -e BENCH_DECODE_DIR=/bench/out/corpus [-e BENCH_SAVE_DIR=/bench/out/corpus] \
 *     --entrypoint node <image> /bench/scripts/encode-bench.js /bench/src /bench/out/<name>.json
 *
 * sharp.concurrency() is left at its default, which is 1 on glibc, the same as
 * production, so a run measures one encode at a time as the service does.
 */
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const sharp = require('/app/node_modules/sharp')

const [srcDir, outFile] = process.argv.slice(2)
const RUNS = Number(process.env.BENCH_RUNS || 5)
const EFFORTS = (process.env.BENCH_EFFORTS || '1,2,3,4').split(',').map(Number)
const QUALITY = 50
const SAVE_DIR = process.env.BENCH_SAVE_DIR
const DECODE_DIR = process.env.BENCH_DECODE_DIR

if (!srcDir || !outFile) {
  console.error('usage: encode-bench.js <srcDir> <out.json>')
  process.exit(2)
}

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)] }
const now = () => Number(process.hrtime.bigint()) / 1e6
const round1 = (x) => Math.round(x * 10) / 10
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex')

async function timed(fn, runs = RUNS) {
  const times = []
  let result
  for (let i = 0; i < runs; i++) {
    const t0 = now()
    result = await fn()
    times.push(now() - t0)
  }
  return { ms: round1(median(times)), min: round1(Math.min(...times)), result }
}

const pipeline = (buf) => sharp(buf, { limitInputPixels: 268402689 })
  .rotate().resize(1280, 1280, { fit: 'inside', withoutEnlargement: true })

/**
 * PSNR of an encoded output against the resized source, both decoded to 8-bit
 * sRGB without alpha. An objective fidelity proxy, not a perceptual metric: it
 * says whether two encoders at the same nominal quality landed in the same
 * neighbourhood, which is what makes their size and time comparable.
 */
async function psnr(referenceRaw, encoded) {
  const out = await sharp(encoded).toColourspace('srgb').removeAlpha().raw().toBuffer({ resolveWithObject: true })
  if (out.info.width !== referenceRaw.info.width || out.info.height !== referenceRaw.info.height
    || out.info.channels !== referenceRaw.info.channels) { return null }
  const a = referenceRaw.data, b = out.data
  let se = 0
  for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; se += d * d }
  const mse = se / a.length
  return mse === 0 ? Infinity : round1(10 * Math.log10((255 * 255) / mse))
}

async function encodeSide(report) {
  const files = fs.readdirSync(srcDir).filter((f) => /\.(jpe?g|png|webp|heic|avif)$/i.test(f)).sort()
  for (const f of files) {
    const buf = fs.readFileSync(path.join(srcDir, f))
    const meta = await sharp(buf).metadata()
    const entry = {
      file: f, format: meta.format, width: meta.width, height: meta.height, bytes: buf.length,
      metadataMs: null, decodeResizeMs: null, avif: {}, webp: null,
    }
    entry.metadataMs = (await timed(() => sharp(buf).metadata())).ms
    // decode + resize alone, so encode cost can be separated; also the PSNR reference
    const ref = await timed(() => pipeline(buf).toColourspace('srgb').removeAlpha().raw().toBuffer({ resolveWithObject: true }))
    entry.decodeResizeMs = ref.ms
    for (const effort of EFFORTS) {
      const r = await timed(() => pipeline(buf).avif({ quality: QUALITY, effort, force: true }).toBuffer())
      entry.avif[effort] = { ms: r.ms, min: r.min, bytes: r.result.length, psnr: await psnr(ref.result, r.result) }
      if (SAVE_DIR && effort === 2) {
        fs.mkdirSync(SAVE_DIR, { recursive: true })
        fs.writeFileSync(path.join(SAVE_DIR, `${ f }.e${ effort }.avif`), r.result)
      }
    }
    const w = await timed(() => pipeline(buf).webp({ quality: 80, alphaQuality: 80, force: true }).toBuffer())
    entry.webp = { ms: w.ms, min: w.min, bytes: w.result.length, psnr: await psnr(ref.result, w.result) }
    report.sources.push(entry)
    console.error(`${ f }: meta ${ entry.metadataMs }ms, decode+resize ${ entry.decodeResizeMs }ms, avif e2 ${ entry.avif[2] ? entry.avif[2].ms + 'ms/' + entry.avif[2].bytes + 'B/psnr ' + entry.avif[2].psnr : 'n/a' }`)
  }
}

async function decodeSide(report) {
  const files = fs.readdirSync(DECODE_DIR).filter((f) => /\.(avif|heic|heif)$/i.test(f)).sort()
  for (const f of files) {
    const buf = fs.readFileSync(path.join(DECODE_DIR, f))
    const meta = await sharp(buf).metadata()
    const entry = {
      file: f, sha256: sha256(buf), bytes: buf.length, format: meta.format, compression: meta.compression,
      width: meta.width, height: meta.height,
      metadataMs: (await timed(() => sharp(buf).metadata())).ms,
      decodeMs: (await timed(() => sharp(buf).raw().toBuffer())).ms,
    }
    report.decode.push(entry)
    console.error(`decode ${ f }: meta ${ entry.metadataMs }ms, full ${ entry.decodeMs }ms`)
  }
}

async function main() {
  const report = {
    versions: sharp.versions, concurrency: sharp.concurrency(), runs: RUNS, quality: QUALITY,
    sources: [], decode: [],
  }
  await encodeSide(report)
  if (DECODE_DIR && fs.existsSync(DECODE_DIR)) { await decodeSide(report) }
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2))
  console.error(`wrote ${ outFile }`)
}

main().catch((err) => { console.error('bench failed:', err && err.message); process.exit(1) })
