import { fetchUrl, NeedleResponse } from './utils'

const fallbackDomains = [
    '', // original
    'https://images.hive.blog/0x0/',
    'https://steemitimages.com/0x0/',
    'https://wsrv.nl/?url=',
    'https://img.leopedia.io/0x0/',
    'https://images.hive.blog/p/',
    'https://steemitimages.com/p/',
]

const buildFallbackUrls = (urlString: string, urlParams: string): string[] => {
    return fallbackDomains.map((domain) => {
        if (!domain) { return urlString }
        if (domain.endsWith('/p/')) { return domain + urlParams }
        return domain + urlString
    })
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

    throw new Error('All fallbacks failed, including default image')
}
