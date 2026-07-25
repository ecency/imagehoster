# imagehoster

Production-ready Hive blockchain-powered image hosting and proxying service with authentication, rate limiting, and content moderation.

## Features

- **Blockchain Authentication** - Hive signature verification and HiveSigner OAuth support
- **Smart Image Processing** - Automatic resizing, format conversion, AVIF/WebP content negotiation with full HDR AVIF support
- **Multi-Level Caching** - HTTP caching, in-memory, storage-backed with CDN integration
- **Intelligent Fallbacks** - Multi-source image fetching with automatic retry
- **Rate Limiting** - Redis-backed per-account upload quotas
- **Content Moderation** - Dynamic DMCA blacklist system with remote updates
- **Production Scale** - Cluster mode, Docker deployment, S3-compatible storage

## Quick Start

### Development

```bash
# Install dependencies and start hot-reloading server
make devserver

# Run tests
make test

# Run linter
make lint

# Generate coverage report
make coverage
```

### Production Deployment

```bash
# Using Docker Compose (recommended)
docker-compose up -d

# Manual deployment with PM2
pm2 start ecosystem.config.js
```

## Architecture

### Core Components

- **Framework:** Koa 2 + TypeScript
- **Image Processing:** Sharp (libvips)
- **Blockchain:** Hive (@ecency/sdk)
- **Storage:** S3-compatible via AWS SDK v3 (Backblaze B2, MinIO, AWS S3, DigitalOcean Spaces)
- **Cache:** Redis (rate limiting) + node-cache (RPC data) + LRU-cache (metadata)
- **Logging:** Bunyan structured logging

### Storage Architecture

**Three-tier Storage System:**
- **Upload Store** - Long-term S3 storage for user uploads (immutable)
- **Proxy Store** - Ephemeral filesystem/S3 cache for proxied images
- **Retention Store** (optional) - S3 archive for originals whose upstream origin is dead, so the proxy store can stay freely prunable. Consulted on a proxy-store miss, before the network fetch fallback

The upload and retention stores are **origins, not caches**: cache-bypass flags never skip them and nothing auto-deletes from them. Only the proxy store is safe to LRU-prune.

**What a proxy miss writes:** the rendered variant, plus the untouched original when it is small enough. The original exists only so a later request for a *different* size or format can re-render without a second upstream fetch. Because large originals dominate the cache by volume while being a small share of files, they are skipped above `max_cached_original_size` (default 1MB, `0` disables). Avatar and cover originals are exempt from that cap: they are a bounded, frequently re-read set, and one original feeds up to nine rendered variants.

Images are content-addressed using multihash:
- Upload keys: `D{base58(sha256(image_data))}`
- Proxy keys: `U{base58(multihash(sha1(url)))}`
- Resized keys: `{key}_{mode}_{format}_{width}_{height}`

## API Endpoints

### Health Checks

```
GET /                          Health check with version info
GET /.well-known/healthcheck.json
GET /healthcheck
```

### Upload Images

```
POST /:username/:signature     Upload with Hive account signature
POST /hs/:accesstoken          Upload with HiveSigner token
```

**Requirements:**
- Hive account in good standing (minimum reputation: 10)
- Valid signature or HiveSigner token
- Image size ≤20MB
- Account not blacklisted
- Within rate limit quota (700 uploads/week default)

**Response:**
```json
{
  "url": "https://images.ecency.com/DQmZi174Xz96UrRVBMNRHb6A2FfU3z1HRPwPPQCgSMgdiUT/example.jpg"
}
```

### Serve Images

```
GET /:hash/:filename?          Serve uploaded image (filename optional)
```

Images are immutable and cached for 1 year. Falls back to Hive/Steemit instances if not found locally.

### Proxy & Resize

```
GET /p/:url?width=W&height=H&mode=M&format=F
```

**Parameters:**
- `url` - Base58-encoded image URL
- `width` - Target width (0 = auto, max 2000px)
- `height` - Target height (0 = auto, max 2000px)
- `mode` - Scaling mode:
  - `cover` (default) - Center-crop to exact dimensions
  - `fit` - Aspect-preserved resize (no crop)
- `format` - Output format:
  - `match` (default) - Automatic based on Accept header (prefers AVIF > WebP > original)
  - `jpeg`, `png`, `webp`, `avif` - Force specific format

**Cache Control:**
- `ignorecache=1` - Bypass cache for this request
- `invalidate=1` - Purge cache and refetch
  - Requires header `X-Invalidate-Key` matching configured `invalidate_token`

**Examples:**

Proxy as-is:
```
https://images.ecency.com/p/46aP2QbqUqBqwzwxM6L1P6uLNceBDDCM9ZJdv282fpHyc9Wgcz1FduB11aVXtczv9TiCSHF1eEmnRSSdQWQEXA5krJNq
```

Center-cropped 512x512 avatar/image:
```
https://images.ecency.com/p/{url}?width=512&height=512&mode=cover
```

Aspect-fit 200x500 container:
```
https://images.ecency.com/p/{url}?width=200&height=500&mode=fit
```

Variable width, 100px height:
```
https://images.ecency.com/p/{url}?height=100
```

### User Profiles

```
GET /u/:username/avatar/:size?   User avatar (small/medium/large, default 256px)
GET /u/:username/cover           User cover (1344x240)
```

Avatar sizes: `small` (64px), `medium` (128px), `large` (512px)

Returns default image if user hasn't set custom avatar/cover.

### Legacy Endpoints (Deprecated)

```
GET /:widthx:height/:url         Legacy proxy (redirects to /p/)
GET /webp/*                      Legacy WebP routes (redirect to modern endpoints)
```

These redirect with 301 status to modern endpoints for backward compatibility. Legacy proxy requests are served but **not stored** to prevent abuse of the open proxy as free image hosting.

## Configuration

Configuration uses TOML files with environment variable overrides.

**Load order:** `env vars` > `config/$NODE_ENV.toml` > `config/default.toml`

### Core Settings

```toml
# Basic server settings
port = 8800
num_workers = 0              # 0 = CPU count
proxy = true                 # Behind reverse proxy
name = 'imagehoster'
log_level = 'error'          # debug, info, error
log_output = 'stdout'

# Hive blockchain
rpc_node = 'https://api.hive.blog'

# Service URL (used for self-referential URLs)
service_url = 'https://i.ecency.com'

# Image limits
max_image_size = 20000000    # 20MB
max_image_width = 1280
max_image_height = 1280
max_custom_image_width = 2000
max_custom_image_height = 2000
max_input_pixels = 100000000 # decompression-bomb guard (width*height)

# Largest original the proxy cache keeps a copy of. Rendered variants are always
# cached; this only bounds the untouched originals kept to avoid a refetch when a
# different size/format of the same source is requested. 0 disables entirely.
max_cached_original_size = 1000000  # 1MB

# Default images
default_avatar = 'https://i.ecency.com/DQm.../avatar.png'
default_cover = 'https://i.ecency.com/DQm.../cover.png'
```

### S3 Storage

Works with any S3-compatible provider (AWS S3, Backblaze B2, MinIO, DigitalOcean Spaces, Wasabi, Cloudflare R2).

```toml
S3_ACCESS_KEY_ID = ''
S3_SECRET_ACCESS_KEY = ''
S3_ENDPOINT = 's3.us-west-000.backblazeb2.com'  # https:// auto-prepended if missing
S3_REGION = 'us-west-000'

[upload_store]
type = 's3'                  # or 'fs' for filesystem
s3_bucket = 'eupload-bucket'

[proxy_store]
type = 'fs'                  # or 's3' for S3 storage
s3_bucket = 'eproxy-bucket'
```

### Rate Limiting

```toml
redis_url = 'redis://localhost'
redis_password = ''          # Optional

[upload_limits]
duration = 604800000         # 1 week in ms
max = 700                    # Max uploads per week
reputation = 10              # Minimum Hive reputation
app_account = 'ecency.app'
app_posting_wif = ''         # HiveSigner app key
```

### Blacklist (DMCA/Content Moderation)

```toml
[blacklist]
cache_ttl = 300000           # 5 minutes
images_url = 'https://ecency.com/dmca/dmca-images.json'
accounts_url = 'https://ecency.com/dmca/dmca-accounts.json'
```

Blacklists are fetched from remote URLs and cached. Falls back to local JSON files on failure.

### Cloudflare (Optional)

```toml
cloudflare_token = ''        # API token
cloudflare_zone = ''         # Zone ID
```

Enables cache purging for avatars/covers when updated.

## Authentication

### Hive Signature Upload

Create signature with posting key:

```javascript
const crypto = require('crypto')
const { PrivateKey } = require('@ecency/sdk')

const imageData = fs.readFileSync('image.jpg')
const imageHash = crypto.createHash('sha256')
    .update('ImageSigningChallenge')
    .update(imageData)
    .digest()

const key = PrivateKey.fromString(wif)
const signature = key.sign(imageHash).toString()
```

Upload:
```bash
curl -X POST https://images.ecency.com/username/signature \
  -F "image=@image.jpg"
```

### HiveSigner Upload

Get access token from HiveSigner OAuth flow, then:

```bash
curl -X POST https://images.ecency.com/hs/ACCESS_TOKEN \
  -F "image=@image.jpg"
```

Token format (base64url-encoded JSON):
```json
{
  "signed_message": {"type": "posting", "app": "ecency"},
  "authors": ["username"],
  "signatures": ["signature"],
  "timestamp": "2024-01-28T00:00:00Z"
}
```

## Features in Detail

### AVIF/WebP Content Negotiation

Service automatically serves the best format based on the client's `Accept` header, preferring AVIF > WebP > original format. No need for separate format-specific endpoints.

```bash
# Modern browser automatically gets AVIF or WebP
curl -H "Accept: image/avif,image/webp,*/*" https://images.ecency.com/u/username/avatar

# Older browser gets original format
curl https://images.ecency.com/u/username/avatar
```

Response includes `Vary: Accept` header for proper CDN caching.

### HDR AVIF Support

The Docker image builds libvips from source with dav1d (AV1 decoder) for full AVIF support, including HDR gain map images (MA1A brand) commonly produced by modern cameras. Sharp's bundled libvips uses libaom which cannot decode these bitstreams.

### Fallback System

When primary source fails, tries multiple mirrors in order:

1. Original URL
2. `images.hive.blog/p/` (base58, preserves query params)
3. `steemitimages.com/p/` (base58, preserves query params)
4. `images.hive.blog/0x0/` (for URLs without query params)
5. `steemitimages.com/0x0/`
6. `img.leopedia.io/0x0/`
7. `wsrv.nl` (third-party proxy, URL-encoded)
8. Default fallback image

Each attempt has 10-second timeout. First successful response is returned.

**Fallback results are never persisted.** If every mirror fails and the default image is served, neither the original nor the rendered variant is written to the store, in any handler. A stored fallback would be indistinguishable from a real image on later requests and would be served at the normal 1 hour freshness rather than the fallback's 120 seconds, so a brief upstream outage would look like a permanently broken image until the entry was evicted or manually invalidated. Repeat cost is bounded by the negative cache (10 minutes for a dead URL, 60 seconds for a transient failure), so a broken source is retried at most once per TTL rather than once per request.

### URL Replacements

Automatic domain migrations:
- `img.3speakcontent.online` → `img.3speakcontent.co`
- `img.inleo.io` → `img.leopedia.io`
- `esteem.ws` → `steemitimages.com`

### ETag Support

All responses include ETag headers. Clients can use `If-None-Match` for 304 responses to save bandwidth.

### Cluster Mode

Supports multi-process deployment with automatic CPU count detection:

```toml
num_workers = 4              # Or 0 for auto-detect
```

Workers share Redis rate limiter state and coordinate via node.js cluster module.

## Docker Deployment

Multi-stage Dockerfile optimized for production:

**Stage 1 (vips-builder):** Builds libvips from source with dav1d (AV1 decoder), libaom (AV1 encoder), and libheif for full AVIF/HEIF support including HDR gain map images
**Stage 2 (build):** Node 20 with app compilation, replaces Sharp's bundled libvips with custom build
**Stage 3 (runtime):** Node 20 slim with minimal runtime dependencies

```bash
# Build image
docker build -t imagehoster .

# Run with docker-compose (recommended)
docker-compose up -d

# Manual run
docker run -p 8800:8800 \
  -e S3_ACCESS_KEY_ID=xxx \
  -e S3_SECRET_ACCESS_KEY=xxx \
  imagehoster
```

**Docker Compose features:**
- 4 replicas for high availability
- Rolling updates (start-first strategy)
- 2GB memory limit per replica
- 0.9 CPU limit per replica
- Automatic health checks every 20s

## Error Handling

All errors return JSON with consistent format:

```json
{
  "error": {
    "name": "error_code",
    "info": {"optional": "metadata"}
  }
}
```

**Common status codes:**
- `400` - Invalid parameters or signature
- `403` - Low reputation (`deplorable`)
- `404` - Account or image not found (`no_such_account`, `not_found`)
- `413` - Image too large (`payload_too_large`)
- `429` - Rate limit exceeded (`quota_exceeded`)
- `451` - Blacklisted (`blacklisted`)
- `500` - Server error (`internal_error`)

## Monitoring & Logging

**Structured logging with Bunyan:**
```json
{
  "name": "imagehoster",
  "hostname": "server-1",
  "pid": 12345,
  "level": 30,
  "msg": "request completed",
  "req_id": "abc123",
  "method": "GET",
  "path": "/u/username/avatar",
  "status": 200,
  "ms": 45,
  "time": "2024-01-28T00:00:00Z"
}
```

**Metrics tracked:**
- Request duration (high-precision hrtime)
- Cache hit/miss rates
- Fallback usage frequency
- Error classification

## Development

### Project Structure

```
src/
  app.ts              - Koa application setup
  routes.ts           - Route definitions
  common.ts           - Hive RPC, storage, Redis clients
  upload.ts           - Upload handlers with auth
  proxy.ts            - Image proxying and resizing
  image-resizer.ts    - Sharp processing pipeline
  avatar.ts           - User avatar endpoint
  cover.ts            - User cover endpoint
  serve.ts            - Upload serving
  fallback.ts         - Fallback image building and serving
  fetch-image.ts      - Fallback fetch logic
  sentry.ts           - Sentry error tracking integration
  s3-store.ts         - S3 blob store (AWS SDK v3)
  blacklist.ts        - Blacklist file loading
  blacklist-service.ts - Dynamic blacklist fetching
  utils.ts            - Helpers (base58, MIME, etc.)
  constants.ts        - URL patterns, replacements
  error.ts            - Error definitions
  logger.ts           - Bunyan logger setup
  cache.ts            - Node-cache instance
```

### Testing

```bash
# Run all tests
make test

# Run specific test
make test grep="upload"

# Run with coverage
make coverage

# CI test suite (audit + lint + coverage)
make ci-test
```

### Code Quality

```bash
# Auto-fix linting issues
make lint

# Type checking (via tsc)
make lib
```

**Linter:** ESLint
**TypeScript:** 5.7

## Production Checklist

- [ ] Configure S3 credentials (`S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`)
- [ ] Set up Redis for rate limiting (`redis_url`, `redis_password`)
- [ ] Configure HiveSigner app key (`app_posting_wif`)
- [ ] Set service URL (`service_url`)
- [ ] Configure Cloudflare tokens (optional, for CDN purging)
- [ ] Set up log aggregation (Bunyan JSON output)
- [ ] Configure monitoring/alerting
- [ ] Test upload authentication
- [ ] Verify blacklist URLs are accessible
- [ ] Set appropriate `num_workers` for your CPU count
- [ ] Configure reverse proxy (nginx/Cloudflare)
- [ ] Set up SSL/TLS certificates
- [ ] Test failover (simulate RPC node failure)

## Security Considerations

- **Rate limiting** - Prevents abuse via Redis-backed quotas
- **Reputation checks** - Minimum 10 reputation required for uploads
- **Signature verification** - All uploads require valid Hive account signature
- **Blacklist system** - Dynamic DMCA compliance with remote updates
- **Input validation** - All parameters validated before processing
- **Size limits** - 20MB max upload, 2000x2000 max dimensions
- **Safe fallbacks** - Malformed URLs return default images, not errors
- **Content-Type detection** - Server-side validation via file-type
- **No arbitrary code execution** - All image processing via Sharp (sandboxed)

## Performance Tips

1. **Tune worker count** - Start with CPU count, adjust based on load
2. **Monitor memory usage** - Sharp can use significant RAM for large images (full buffering, no streaming)
3. **AVIF/WebP content negotiation** - Automatic via Accept header, 30-50% bandwidth savings

## License

See LICENSE.md

## Support

- GitHub Issues: https://github.com/ecency/imagehoster/issues
- Hive: https://ecency.com/@ecency
