# imagehoster

Production-ready Hive blockchain-powered image hosting and proxying service with authentication, rate limiting, and content moderation.

## Features

- **Blockchain Authentication** - Hive signature verification and HiveSigner OAuth support
- **Smart Image Processing** - Automatic resizing, format conversion, WebP content negotiation
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
- **Blockchain:** Hive (@hiveio/dhive)
- **Storage:** S3-compatible (Backblaze B2, MinIO, AWS S3, DigitalOcean Spaces)
- **Cache:** Redis (rate limiting) + node-cache (RPC data) + LRU-cache (metadata)
- **Logging:** Bunyan structured logging

### Storage Architecture

**Dual Storage System:**
- **Upload Store** - Long-term S3 storage for user uploads (immutable)
- **Proxy Store** - Ephemeral filesystem/S3 cache for proxied images

Images are content-addressed using multihash:
- Upload keys: `D{base58(sha256(image_data))}`
- Proxy keys: `U{base58(sha1(url))}`
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
- Image size ≤30MB
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
  - `match` (default) - Automatic based on Accept header
  - `jpeg`, `png`, `webp` - Force specific format

**Cache Control:**
- `ignorecache=1` - Bypass cache for this request
- `invalidate=1` - Purge cache and refetch
- `refetch=1` - Force upstream fetch

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

These redirect with 301 status to modern endpoints for backward compatibility.

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
service_url = 'https://images.ecency.com'

# Image limits
max_image_size = 30000000    # 30MB
max_image_width = 1280
max_image_height = 1280
max_custom_image_width = 2000
max_custom_image_height = 2000

# Default images
default_avatar = 'https://images.ecency.com/DQm.../avatar.png'
default_cover = 'https://images.ecency.com/DQm.../cover.png'
```

### S3 Storage

Works with any S3-compatible provider (AWS S3, Backblaze B2, MinIO, DigitalOcean Spaces, Wasabi, Cloudflare R2).

```toml
S3_ACCESS_KEY_ID = ''
S3_SECRET_ACCESS_KEY = ''
S3_ENDPOINT = 's3.us-west-000.backblazeb2.com'
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
const { PrivateKey } = require('@hiveio/dhive')

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

### WebP Content Negotiation

Service automatically serves WebP format when client sends `Accept: image/webp` header. No need for separate `/webp/` endpoints.

```bash
# Modern browser automatically gets WebP
curl -H "Accept: image/webp,*/*" https://images.ecency.com/u/username/avatar

# Older browser gets original format
curl https://images.ecency.com/u/username/avatar
```

Response includes `Vary: Accept` header for proper CDN caching.

### Fallback System

When primary source fails, tries multiple mirrors in order:

1. Original URL
2. `images.hive.blog`
3. `steemitimages.com`
4. `wsrv.nl` (third-party proxy)
5. `img.leopedia.io`
6. Default fallback image

Each attempt has 5-second timeout. First successful response is returned.

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

**Build stage:** Installs libvips, libheif, libaom for image processing
**Runtime stage:** Slim image with only runtime dependencies

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
  fetch-image.ts      - Fallback fetch logic
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

**Linter:** TSLint (TODO: migrate to ESLint)
**TypeScript:** 2.7.1 (TODO: upgrade to 5.x)

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
- **Size limits** - 30MB max upload, 2000x2000 max dimensions
- **Safe fallbacks** - Malformed URLs return default images, not errors
- **Content-Type detection** - Server-side validation via libmagic
- **No arbitrary code execution** - All image processing via Sharp (sandboxed)

## Performance Tips

1. **Use Cloudflare or CDN** - Cache at edge for 99%+ hit rate
2. **Enable Redis caching** - Reduces Hive RPC load
3. **Increase LRU cache size** - Edit `max: 500` in utils.ts
4. **Use S3 for proxy store** - Better than filesystem for large scale
5. **Tune worker count** - Start with CPU count, adjust based on load
6. **Monitor memory usage** - Sharp can use significant RAM for large images
7. **Set longer account cache TTL** - Increase from 30s to 5 minutes
8. **Use WebP content negotiation** - 30-50% bandwidth savings

## License

See LICENSE.md

## Support

- GitHub Issues: https://github.com/ecency/imagehoster/issues
- Hive: https://ecency.com/@ecency
