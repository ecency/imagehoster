import { URL } from 'url'
import { assertPublicUrl, fetchUrl, NeedleResponse } from './utils'
import { captureImageFailure } from './sentry'

const buildFallbackUrls = (urlString: string, urlParams: string): string[] => {
    const hasQuery = urlString.indexOf('?') !== -1
    const urls: string[] = [
        urlString, // original URL first
        // /p/ routes use base58 encoding — safely preserves query params
        'https://images.hive.blog/p/' + urlParams,
        'https://steemitimages.com/p/' + urlParams,
    ]
    // 0x0/ routes embed the URL in the path — query params get stripped
    // by the receiving proxy's router, so only useful for URLs without query params
    if (!hasQuery) {
        urls.push(
            'https://images.hive.blog/0x0/' + urlString,
            'https://steemitimages.com/0x0/' + urlString,
            'https://img.leopedia.io/0x0/' + urlString,
        )
    }
    // wsrv.nl needs URL-encoded value to preserve query params
    urls.push('https://wsrv.nl/?url=' + encodeURIComponent(urlString))
    // Add 0x0/ routes last as extra attempts for URLs with query params
    // (they'll lose the params but might still work for non-authenticated URLs)
    if (hasQuery) {
        urls.push(
            'https://images.hive.blog/0x0/' + urlString,
            'https://steemitimages.com/0x0/' + urlString,
            'https://img.leopedia.io/0x0/' + urlString,
        )
    }
    return urls
}

export async function fetchImageWithFallbacks(
    urlString: string,
    urlParams: string,
    userAgent: string,
    defaultUrl: string,
    ctxLog: any,
    options: { timeout?: number; skipUrls?: string[] } = {}
): Promise<{ res: NeedleResponse; isFallback: boolean }> {
    const timeout = options.timeout !== undefined && options.timeout !== null ? options.timeout : 10000
    const skipUrls = (options.skipUrls !== undefined && options.skipUrls !== null) ? options.skipUrls : []

    const urls = buildFallbackUrls(urlString, urlParams).filter((url) => {
        return !skipUrls.includes(url.trim())
    })

    for (const candidate of urls) {
        if (process.env.NODE_ENV !== 'test') {
            try {
                assertPublicUrl(new URL(candidate))
            } catch (e) {
                ctxLog.warn({ candidate }, 'Skipping private URL in fallback chain')
                continue
            }
        }
        try {
            ctxLog.info({ candidate }, 'Trying fallback fetch')
            const res = await fetchUrl(candidate, {
                parse_response: false,
                follow_max: 5,
                open_timeout: timeout,
                response_timeout: timeout,
                read_timeout: timeout,
                user_agent: userAgent,
            } as any)

            if (
                res &&
                res.statusCode &&
                Math.floor(res.statusCode / 100) === 2 &&
                Buffer.isBuffer(res.body)
            ) {
                ctxLog.info({ candidate }, 'Fetch succeeded')
                return { res, isFallback: false }
            }

            ctxLog.warn({ candidate, code: res && res.statusCode }, 'Fetch failed status')
        } catch (e) {
            ctxLog.error(e, `Fetch error at ${candidate}`)
        }
    }

    // Final fallback: default image (avatar or cover)
    try {
        ctxLog.info('Trying final fallback: default image')
        const def = await fetchUrl(defaultUrl, {
            parse_response: false,
            follow_max: 5,
            open_timeout: timeout,
            response_timeout: timeout,
            read_timeout: timeout,
            user_agent: userAgent,
        } as any)

        if (
            def &&
            def.statusCode &&
            Math.floor(def.statusCode / 100) === 2 &&
            Buffer.isBuffer(def.body)
        ) {
            return { res: def, isFallback: true }
        }

        ctxLog.warn({ code: def && def.statusCode }, 'Default image fetch failed')
    } catch (e) {
        ctxLog.error(e, 'Failed to fetch default fallback image')
    }

    captureImageFailure('all_mirrors_exhausted', {}, { urlString, urlParams, triedUrls: buildFallbackUrls(urlString, urlParams).length })
    throw new Error('All fallbacks failed, including default image')
}
