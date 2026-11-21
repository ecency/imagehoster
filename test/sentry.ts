import 'mocha'
import assert from 'assert'

import {scrubSentryEvent, sentryInitOptions} from './../src/sentry'
import {logger} from './../src/logger'

const TOKEN = 'eyJzZWNyZXQiOiJ0b2tlbiJ9'

describe('sentry scrubbing', function() {
    it('drops the authorization header in any case and keeps the others', function() {
        const event: any = {request: {headers: {Authorization: `Bearer ${ TOKEN }`, authorization: 'x', Accept: 'a'}}}
        const out: any = scrubSentryEvent(event)
        assert.deepEqual(out.request.headers, {Accept: 'a'})
        assert.ok(!JSON.stringify(out).includes(TOKEN))
    })

    it('redacts the path token in url, transaction name, spans and breadcrumbs', function() {
        const event: any = {
            transaction: `POST /hs/${ TOKEN }`,
            request: {url: `https://i.ecency.com/webp/hs/${ TOKEN }?x=1`},
            breadcrumbs: [{data: {url: `/hs/${ TOKEN }`}, message: `POST /hs/${ TOKEN }`}],
            spans: [{description: `POST /hs/${ TOKEN }`, data: {'http.url': `http://h/hs/${ TOKEN }`, 'url.path': `/hs/${ TOKEN }`}}],
            contexts: {trace: {data: {'http.target': `/hs/${ TOKEN }`}}},
        }
        const out: any = scrubSentryEvent(event)
        assert.ok(!JSON.stringify(out).includes(TOKEN), JSON.stringify(out))
        assert.equal(out.transaction, 'POST /hs/[redacted]')
        assert.equal(out.request.url, 'https://i.ecency.com/webp/hs/[redacted]?x=1')
    })

    it('leaves unrelated urls and events without a request alone', function() {
        const event: any = {transaction: 'GET /p/abc', request: {url: 'https://i.ecency.com/hs'}, message: 'x'}
        assert.deepEqual(scrubSentryEvent(event), {transaction: 'GET /p/abc', request: {url: 'https://i.ecency.com/hs'}, message: 'x'})
        assert.deepEqual(scrubSentryEvent({message: 'x'} as any), {message: 'x'})
    })

    it('wires the scrubber into both beforeSend and beforeSendTransaction', function() {
        const options: any = sentryInitOptions('https://abc@example.invalid/1')
        for (const hook of ['beforeSend', 'beforeSendTransaction']) {
            const out = options[hook]({request: {headers: {authorization: 'Bearer x'}}, transaction: `POST /hs/${ TOKEN }`})
            assert.deepEqual(out.request.headers, {})
            assert.equal(out.transaction, 'POST /hs/[redacted]')
        }
    })

    it('scrubs an event holding getter-only or cyclic objects without throwing', function() {
        const meta: any = {}
        Object.defineProperty(meta, '$', {get: () => 'x', enumerable: true})
        const event: any = {transaction: `POST /hs/${ TOKEN }`, sdkProcessingMetadata: meta, extra: {}}
        event.extra.self = event.extra
        const out = scrubSentryEvent(event)
        assert.equal(out.transaction, 'POST /hs/[redacted]')
    })

    it('scrubs a breadcrumb before it is recorded', function() {
        const options: any = sentryInitOptions('https://abc@example.invalid/1')
        const crumb = options.beforeBreadcrumb({category: 'http', data: {url: `https://i.ecency.com/hs/${ TOKEN }?x=1`}})
        assert.equal(crumb.data.url, 'https://i.ecency.com/hs/[redacted]?x=1')
    })
})

describe('logger request serializer', function() {
    it('redacts the authorization header and keeps the rest', function() {
        const req = {method: 'POST', url: '/hs', headers: {authorization: `Bearer ${ TOKEN }`, host: 'h'}, connection: {}}
        const out: any = (logger as any).serializers.req(req)
        assert.equal(out.headers.authorization, '[redacted]')
        assert.equal(out.headers.host, 'h')
        assert.ok(!JSON.stringify(out).includes(TOKEN))
        assert.equal(req.headers.authorization, `Bearer ${ TOKEN }`, 'the live request is not mutated')
    })
})
