#!/usr/bin/env node
/**
 * Proves the custom libvips is the one actually loaded, by decoding rather than
 * by inspecting version strings.
 *
 * The Dockerfile compiles Sharp's binding against the libvips built in the image,
 * linked against libde265 and libaom. If the service ever came up on a stock
 * libvips instead (see the guard in the build stage) it would still start, still
 * serve, and still pass its healthcheck: HEIC sources would just quietly stop
 * transcoding and fall back to original bytes.
 *
 * With a binding built against a global libvips, sharp.versions.vips is read from
 * the loaded library rather than from a static file, so when SMOKE_VIPS_VERSION is
 * set (the Dockerfile passes the version it built) this also asserts that the
 * library sharp actually loaded is that build.
 *
 * Reading metadata is NOT a sufficient check. The stock library parses the HEIF
 * container happily and reports dimensions and compression. Only a pixel decode
 * reaches libde265, so that is what this forces.
 *
 * Run inside the built image. From a dev checkout with the stock bundled library
 * it is EXPECTED to fail, with "No decoding plugin installed for this compression
 * format" — that failure is the check working.
 */
const path = require('path')
const fs = require('fs')

const root = process.env.SMOKE_ROOT || '/app'
const sharp = require(path.join(root, 'node_modules', 'sharp'))
const fixture = path.join(root, 'test', 'test.heic')

async function main() {
  if (!fs.existsSync(fixture)) {
    console.error(`smoke FAIL: fixture missing at ${fixture}`)
    process.exit(1)
  }
  const buf = fs.readFileSync(fixture)

  const expectedVips = process.env.SMOKE_VIPS_VERSION
  if (expectedVips && sharp.versions.vips !== expectedVips) {
    console.error(`smoke FAIL: sharp loaded libvips ${sharp.versions.vips}, the image built ${expectedVips}`)
    process.exit(1)
  }

  const meta = await sharp(buf).metadata()
  if (meta.compression !== 'hevc') {
    console.error(`smoke FAIL: expected an HEVC-compressed HEIC fixture, got compression=${meta.compression}`)
    process.exit(1)
  }

  // The discriminating step: this is what needs libde265.
  let raw
  try {
    raw = await sharp(buf).raw().toBuffer({ resolveWithObject: true })
  } catch (err) {
    console.error('smoke FAIL: HEIC pixel decode failed, so the custom libvips is NOT loaded')
    console.error(`  ${err && err.message}`)
    process.exit(1)
  }
  const expected = raw.info.width * raw.info.height * raw.info.channels
  if (raw.data.length !== expected) {
    console.error(`smoke FAIL: decoded ${raw.data.length} bytes, expected ${expected}`)
    process.exit(1)
  }

  // Capability check for the encode side the service actually serves.
  const avif = await sharp(buf).resize(64, 64, { fit: 'inside' })
    .avif({ quality: 50, effort: 2, force: true }).toBuffer()
  const back = await sharp(avif).metadata()
  if (back.format !== 'heif') {
    console.error(`smoke FAIL: AVIF round-trip decoded as ${back.format}`)
    process.exit(1)
  }

  // SVG sources are rasterised by librsvg, which comes from the distro rather
  // than from this image's own build. Prove it loads and renders: a 4x4 red square.
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4" fill="#f00"/></svg>')
  let px
  try {
    px = await sharp(svg).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  } catch (err) {
    console.error('smoke FAIL: SVG rasterise failed, librsvg is not usable')
    console.error(`  ${err && err.message}`)
    process.exit(1)
  }
  if (px.info.width !== 4 || px.info.height !== 4 || px.data[0] !== 255 || px.data[1] !== 0 || px.data[2] !== 0) {
    console.error(`smoke FAIL: SVG rendered ${px.info.width}x${px.info.height} rgb(${px.data[0]},${px.data[1]},${px.data[2]}), expected 4x4 red`)
    process.exit(1)
  }

  console.log(`smoke OK: HEIC(${meta.compression}) ${raw.info.width}x${raw.info.height} decoded, AVIF round-trip ${avif.length}B, SVG rasterised`)
}

main().catch((err) => { console.error('smoke FAIL:', err && err.message); process.exit(1) })
