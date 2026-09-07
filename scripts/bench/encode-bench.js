#!/usr/bin/env node
/**
 * Encoder and decoder benchmark for the codec build inside an imagehoster image.
 *
 * Runs the production pipeline shape (rotate, resize to 1280 fit, encode) over a
 * directory of source images and reports the median wall time and output size
 * per AVIF effort, WebP for reference, and the decode time of the produced AVIF
 * and of any HEIC source. Run it in two images built from different codec
 * configurations and compare the JSON.
 *
 *   docker run --rm --cpuset-cpus=<same for both> \
 *     -v <sources>:/bench/src:ro -v <this dir>:/bench/scripts:ro -v <out>:/bench/out \
 *     --entrypoint node <image> /bench/scripts/encode-bench.js /bench/src /bench/out/<name>.json
 *
 * sharp.concurrency() is left at its default, which is 1 on glibc, the same as
 * production, so a run measures one encode at a time as the service does.
 */
const fs = require('fs')
const path = require('path')
const sharp = require('/app/node_modules/sharp')

const [srcDir, outFile] = process.argv.slice(2)
const RUNS = Number(process.env.BENCH_RUNS || 5)
const EFFORTS = (process.env.BENCH_EFFORTS || '1,2,3,4').split(',').map(Number)
const QUALITY = 50

if (!srcDir || !outFile) {
  console.error('usage: encode-bench.js <srcDir> <out.json>')
  process.exit(2)
}

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)] }
const now = () => Number(process.hrtime.bigint()) / 1e6

async function timed(fn, runs = RUNS) {
  const times = []
  let result
  for (let i = 0; i < runs; i++) {
    const t0 = now()
    result = await fn()
    times.push(now() - t0)
  }
  return { ms: Math.round(median(times) * 10) / 10, min: Math.round(Math.min(...times) * 10) / 10, result }
}

const pipeline = (buf) => sharp(buf, { limitInputPixels: 268402689 })
  .rotate().resize(1280, 1280, { fit: 'inside', withoutEnlargement: true })

async function main() {
  const report = {
    versions: sharp.versions,
    concurrency: sharp.concurrency(),
    runs: RUNS,
    quality: QUALITY,
    sources: [],
  }
  const files = fs.readdirSync(srcDir).filter((f) => /\.(jpe?g|png|webp|heic|avif)$/i.test(f)).sort()
  for (const f of files) {
    const buf = fs.readFileSync(path.join(srcDir, f))
    const meta = await sharp(buf).metadata()
    const entry = {
      file: f, format: meta.format, width: meta.width, height: meta.height, bytes: buf.length,
      decodeResizeMs: null, avif: {}, webp: null, avifDecodeMs: {}, sourceDecodeMs: null,
    }
    // decode + resize alone, so encode cost can be separated
    entry.decodeResizeMs = (await timed(() => pipeline(buf).raw().toBuffer())).ms
    // full-size decode of the source itself (HEIC on libde265, AVIF on the AV1 decoder)
    if (meta.format === 'heif') {
      entry.sourceDecodeMs = (await timed(() => sharp(buf).raw().toBuffer())).ms
    }
    for (const effort of EFFORTS) {
      const r = await timed(() => pipeline(buf).avif({ quality: QUALITY, effort, force: true }).toBuffer())
      entry.avif[effort] = { ms: r.ms, min: r.min, bytes: r.result.length }
      // decode the produced AVIF at full size: this is the AV1 decoder's cost
      const d = await timed(() => sharp(r.result).raw().toBuffer())
      entry.avifDecodeMs[effort] = d.ms
    }
    const w = await timed(() => pipeline(buf).webp({ quality: 80, alphaQuality: 80, force: true }).toBuffer())
    entry.webp = { ms: w.ms, min: w.min, bytes: w.result.length }
    report.sources.push(entry)
    console.error(`${f}: decode+resize ${entry.decodeResizeMs}ms, avif e2 ${entry.avif[2] ? entry.avif[2].ms + 'ms/' + entry.avif[2].bytes + 'B' : 'n/a'}, webp ${w.ms}ms/${w.result.length}B`)
  }
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2))
  console.error(`wrote ${outFile}`)
}

main().catch((err) => { console.error('bench failed:', err && err.message); process.exit(1) })
