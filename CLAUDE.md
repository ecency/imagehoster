# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Hive-powered image hosting and proxying service built with TypeScript, Koa, and Sharp. Provides authenticated image uploads via Hive blockchain signatures and image proxying/resizing capabilities with fallback support. Deployed at `images.ecency.com` behind Cloudflare CDN, with `img.ecency.com` as a non-CDN direct origin (manual user opt-in only, not for automatic fallback).

## Development Commands

### Setup and Development
```bash
make devserver           # Start hot-reloading development server with bunyan logging
yarn install             # Install dependencies (also: make node_modules)
```

### Building
```bash
make lib                 # Compile TypeScript to lib/ directory
make                     # Same as make lib
```

### Testing and Quality
```bash
make test                # Run unit tests (optionally: make test grep='pattern')
make ci-test             # Run full CI test suite (audit, lint, coverage)
make coverage            # Run tests with HTML coverage report in reports/coverage
make lint                # Auto-fix linting issues with tslint
```

### Running Single Test
```bash
NODE_ENV=test mocha --require ts-node/register test/[filename].ts --grep 'test pattern'
```

## Architecture

### Core Application Structure

**Entry Point** (src/app.ts)
- Koa application setup with cluster support for multi-worker deployment
- Worker count configurable via `num_workers` (0 = auto-detect CPU count)
- CORS enabled for GET/POST/OPTIONS with wildcard origin
- Error handling middleware logs API errors (>=500) vs handled errors (<500)

**Routing** (src/routes.ts)
- `/` - Healthcheck endpoint with version info
- `POST /:username/:signature` - Upload with Hive signature verification
- `POST /hs/:accesstoken` - Upload with HiveSigner token
- `GET /:hash/:filename?` - Serve uploaded images from upload store
- `GET /p/:url` - Proxy and resize with query params (width, height, mode, format)
- `GET /:width(\\d+)x:height(\\d+)/:url(.*)` - Legacy proxy (deprecated, redirects to `/p/` with `_src=legacy`)
- `GET /u/:username/avatar/:size?` - User avatars (small=64px, medium=128px, large=512px)
- `GET /u/:username/cover` - User cover images
- `/webp/*` variants for WebP format output (deprecated, format auto-detected via Accept header)

### Key Components

**Image Processing** (src/proxy.ts, src/image-resizer.ts)
- Sharp-based pipeline for resizing/format conversion
- Scaling modes: `cover` (center-crop) and `fit` (aspect-preserve)
- Output formats: `match`, `jpeg`, `png`, `webp`, `avif`
- Format auto-negotiation: prefers AVIF > WebP > match based on Accept header
- AVIF encoding: quality 50, effort 2 (`AVIF_EFFORT` in constants.ts). Measured on five real proxy images: effort 2 is 1.6-2.3x faster than effort 3 at the same size or smaller (92-100% of its bytes). Do not lower further — effort 1 is not reliably faster and effort 0 is ~8% larger; effort 4 is ~6x slower than 3 for <1% size reduction
- Max dimensions enforced: standard (1280x1280) and custom (2000x2000)
- Fallback system: attempts multiple mirror URLs if primary source fails
- Animated GIF/APNG: bypasses Sharp pipeline entirely to preserve animation (Sharp strips frames)
- Sharp toBuffer failures: serves original unprocessed bytes for all three paths (upload, cached, fetched) — browsers are more lenient than Sharp at decoding images

**Upload System** (src/upload.ts)
- Hive signature verification: `secp256k1_sign(sha256('ImageSigningChallenge'+image_data))`
- Rate limiting via Redis (700 uploads per week default)
- Reputation threshold check (min 10 reputation)
- Max image size: 30MB (configurable)
- Multipart parsing with Busboy, single file per request
- Content hash stored as multihash identifier

**Storage Abstraction** (src/common.ts, src/s3-store.ts)
- Upload store: S3-compatible (Hetzner/B2 object storage) — holds user uploads (irreplaceable originals)
- Proxy store: Sharded filesystem (src/sharded-fs-store.ts) — distributes files into subdirectories by the first 6 chars of the key (`SHARD_LEN`), backwards-compatible with flat layout via automatic migration. This is the resize/proxy cache and is safe to LRU-prune
- Retention store (optional): S3-compatible archive for originals whose upstream origin is dead, migrated off local disk so the proxy store can stay prunable. On a proxy-store miss the read handlers (`proxy.ts`, `cover.ts`, `avatar.ts`) consult upload store then retention store **before** the network fetch fallback; a retention hit is served by byte-sniffing (`mimeMagic`), not the stored S3 content-type. Configured via `retention_store`; absent → `retentionStore` is `undefined` and every read site null-checks
- `isArchiveStore()` marks the upload and retention stores as **origins, not caches**: cache-bypass flags never skip them and the corrupt-content recovery path never deletes from them (they hold the only copy)
- Configurable via `upload_store`, `proxy_store`, and `retention_store` in config
- Custom S3 store implementation using @aws-sdk/client-s3 v3
- Migration script: `scripts/migrate-to-shards.sh` for bulk migration of flat proxy store to sharded layout

**Hive Integration** (src/common.ts)
- RPC client with failover across multiple Hive API nodes
- Account/profile fetching cached in Redis (300s TTL), shared across all workers
- Negative cache: failed RPC lookups cached as null for 30s to prevent thundering herd
- Signature verification against blockchain account posting authority (uses cached account data)

**Fallback System** (src/fallback.ts, src/fetch-image.ts)
- Multiple mirror attempt strategy for failed image fetches
- HTTPS upgrade: http:// URLs are tried as https:// first (many servers block HTTP but serve HTTPS fine, e.g. hivebuzz.me)
- Mirror chain: HTTPS upgrade → original URL → images.hive.blog/p/ → steemitimages.com/p/ → images.hive.blog/0x0/ → steemitimages.com/0x0/ → img.leopedia.io/0x0/ → wsrv.nl
- URLs with query params: /p/ routes (base58) tried first (preserves params), /0x0/ routes tried last (lose params)
- Serves default fallback image if all mirrors fail
- Cache-Control: 2 minutes (max-age=120) for fallback images, 1 hour for successful avatars/covers, 1 year immutable for proxy images
- Default/fallback images are never stored persistently
- Sentry tracking: `captureImageFailure()` reports all_fallbacks_failed, unsupported_content_type, metadata_extraction_failed, sharp_tobuffer_failed, all_mirrors_exhausted

**Blacklisting** (src/blacklist.ts)
- Account blacklist for upload blocking
- Image URL blacklist for serving (redirects to default avatar)
- DMCA blacklist checked on every proxy request before cache lookup

**Error Tracking** (src/sentry.ts)
- Sentry integration for production error tracking
- `captureImageFailure()` captures image processing failures with context (URL, content type, error details)
- Optional via config — service works without Sentry configured

### Proxy Storage Protection

Legacy proxy routes (`/{W}x{H}/{url}`) redirect to `/p/{base58}` with a `_src=legacy` query param. The proxy handler skips all `storeWrite` calls for legacy requests — images are still fetched, processed, and served, but not persisted to storage. This prevents abuse of the open proxy as free image storage, since the legacy URL format is trivially constructed by anyone.

Modern `/p/{base58}` route (used by Ecency frontends via `proxifyImageSrc()`) stores images normally. Both vision-next and ecency-mobile exclusively use the `/p/` base58 format for proxy URLs.

### Related Projects

**vision-next** — Ecency web frontend
- Uses `@ecency/render-helper` package for image proxification
- `proxifyImageSrc()` constructs all proxy URLs as `/p/{base58}?format=match&mode=fit`
- User can manually select image server in preferences (images.ecency.com, images.hive.blog, img.ecency.com)
- No automatic fallback to img.ecency.com (removed — caused CPU exhaustion on non-CDN origin)

**ecency-mobile** — Ecency mobile app
- Uses same `@ecency/render-helper` for proxy URL construction
- Avatar/cover URLs use `/u/{username}/avatar|cover` format directly
- All other images go through `proxifyImageSrc()` → `/p/{base58}` format

**Hive ecosystem context**
- images.hive.blog — Hive's official image proxy, adding domain whitelist + proxy-auth token support (condenser MR #443)
- proxy-whitelist — HAF app that indexes image URLs from Hive blockchain posts into a PostgreSQL whitelist; images.hive.blog uses it internally (not publicly exposed)
- Condenser proxy-auth tokens are preview-only; published posts use standard proxy URLs without tokens

## Configuration

Configuration uses the `config` module with TOML files in `config/`:
- `default.toml` - Base configuration
- `local-development.toml` - Local dev overrides
- `test.toml` - Test environment config
- Load order: env vars > `config/$NODE_ENV.toml` > `config/default.toml`

Key configuration sections:
- `port`, `num_workers`, `proxy` - Server settings
- `rpc_node` - Hive API endpoint
- `B2_ACCESS_KEY_ID`, `B2_SECRET_ACCESS_KEY`, `b2_url` - B2 storage
- `MINIO_ACCESS_KEY_ID`, `MINIO_SECRET_ACCESS_KEY`, `minio_url` - MinIO storage
- `redis_url` - Redis for rate limiting and shared profile/account cache
- `upload_limits` - Rate limit config (duration, max, reputation, app credentials)
- `upload_store`, `proxy_store` - Blob store configurations
- `max_image_size`, `max_image_width`, `max_image_height` - Size limits
- `default_avatar`, `default_cover` - Fallback images
- `sentry_dsn` - Optional Sentry DSN for error tracking
- `invalidate_token` - Optional token for cache invalidation API
- `cloudflare_token`, `cloudflare_zone` - Cloudflare cache purging

Environment variables can override TOML values (see config module docs).

## Deployment

### Docker
Multi-stage Dockerfile with vips/heif/aom dependencies for image processing:
- Build stage: Node 20 with native build tools
- Runtime stage: Node 20-slim with runtime libraries only (libvips42, libdav1d7)
- Healthcheck: GET /healthcheck every 20s
- Default port: 8800

### Varnish
VCL template at `config/varnish-user.vcl`.
- Caches only /u/* (avatars/covers) and ?blur= URLs
- Passes proxy images and uploads through (cached by Cloudflare instead)
- Fallback avatars detected by max-age=120, cached only 2 minutes
- After deploys: ban avatar cache to prevent stale fallbacks

### Cloudflare
- Page rule: `cache_everything` for the image domain
- Tiered cache enabled, Polish off, sort query string on, strong ETags on
- After deploys: purge avatar prefix to clear stale fallbacks

Docker Compose configured for 4 replicas with rolling updates and resource limits.

## Testing

Tests in `test/` directory use Mocha + ts-node (181 tests). Key test files:
- `test/upload.ts` - Upload signature verification
- `test/proxy.ts` - Image proxying, resizing, and storage behavior
- `test/proxy-formats.ts` - Format conversion (AVIF, WebP, JPEG, PNG)
- `test/avatar.ts` - Avatar endpoint
- `test/cover.ts` - Cover image endpoint
- `test/serve.ts` - Direct image serving
- `test/legacy-proxy.ts` - Legacy proxy redirect behavior
- `test/utils.ts` - Utility function tests
- `test/store.ts` - Blob store operations
- `test/ratelimit.ts` - Rate limiting
- `test/s3-store.ts` - S3 store implementation

Coverage reports generated with nyc (Istanbul) in `reports/coverage/`.

Note: `--exit` flag kept on Mocha as a safety net against any hanging sockets. All test files use port 0 with dynamic assignment.

## Important Implementation Notes

- All image operations use Sharp for performance
- Base58 encoding used for proxy URLs (see `base58Enc`/`base58Dec` in utils)
- ETag support for caching (src/serve.ts)
- Image metadata validation via `getSharpMetadataWithRetry` for robustness
- Cloudflare cache purging support via API (src/utils.ts)
- TypeScript 5.7 with `noImplicitAny: false`
- Compiled output in `lib/`, version.js auto-generated with git hash + timestamp
- Redis v4 in native mode (no legacyMode), fail-closed on disconnect
- ESM-only packages (file-type, multihashes, stream-head) kept on CJS-compatible versions

## Known Issues and Gotchas

- Sharp cannot process some valid images (unusual JPEG encodings, truncated files) that browsers render fine — proxy serves original bytes as fallback (intentional, not a bug)
- GIF/APNG resizing delegated to frontend CSS — proxy passes through at original dimensions to preserve animation (intentional trade-off)
- Images are fully buffered in memory (up to 60MB+ per request) — no streaming pipeline
- Proxy and avatar/cover use different key formats for the same store (multihash base58 vs hex) — by design, not worth unifying (tiny overlap, different invalidation patterns, migration risk)
- `ignorecache` query param is unauthenticated — anyone can force cache bypass and re-fetch/re-process. `invalidate` is protected by `x-invalidate-key` header
