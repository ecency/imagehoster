#!/usr/bin/env node
/**
 * Proves the custom libvips is the one actually loaded, by decoding rather than
 * by inspecting version strings.
 *
 * The Dockerfile overwrites Sharp's bundled libvips-cpp.so with a build linked
 * against libde265 and libaom. If that overwrite ever silently becomes a no-op
 * (see the guard in the build stage) the service still starts, still serves, and
 * still passes its healthcheck: HEIC sources just quietly stop transcoding and
 * fall back to original bytes.
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

  console.log(`smoke OK: HEIC(${meta.compression}) ${raw.info.width}x${raw.info.height} decoded, AVIF round-trip ${avif.length}B`)
}

main().catch((err) => { console.error('smoke FAIL:', err && err.message); process.exit(1) })
