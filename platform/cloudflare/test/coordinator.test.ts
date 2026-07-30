import type { CoordinatorRequest, CoordinatorResult } from '../src/coordinator'
import { env } from 'cloudflare:test'
import { afterEach, describe, expect, it, vi } from 'vitest'

const UPSTREAM = 'https://oneshot-free.www.deepl.com/v1/translate'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('translation coordinator micro-batching', () => {
  it('combines a burst of same-language blocks and returns aligned results', async () => {
    const upstreamBodies: Array<{ text: string[] }> = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url !== UPSTREAM) {
        return new Response('', { status: 200 })
      }
      const body = JSON.parse(String(init?.body)) as { text: string[] }
      upstreamBodies.push(body)
      return Response.json({
        translations: body.text.map(text => ({
          text: `zh:${text}`,
          detected_source_language: 'EN',
        })),
      })
    })

    const id = env.TRANSLATION_COORDINATOR.idFromName(`micro-batch-${crypto.randomUUID()}`)
    const stub = env.TRANSLATION_COORDINATOR.get(id)
    const requests = Array.from({ length: 20 }, (_, index) => {
      const payload: CoordinatorRequest = {
        texts: [`web-block-${index}`],
        sourceLang: 'en',
        targetLang: 'zh-Hans',
        deadline: Date.now() + 5000,
      }
      return stub.fetch('https://coordinator.internal/translate', {
        method: 'POST',
        body: JSON.stringify(payload),
      }).then(response => response.json<CoordinatorResult>())
    })

    const results = await Promise.all(requests)

    expect(upstreamBodies).toHaveLength(1)
    expect(upstreamBodies[0].text).toEqual(Array.from({ length: 20 }, (_, index) => `web-block-${index}`))
    results.forEach((result, index) => {
      expect(result).toEqual({
        ok: true,
        translations: [{ text: `zh:web-block-${index}`, detectedSourceLang: 'EN' }],
      })
    })
  })

  it('does not combine different language directions', async () => {
    const upstreamBodies: Array<{ target_lang: string, text: string[] }> = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url !== UPSTREAM) {
        return new Response('', { status: 200 })
      }
      const body = JSON.parse(String(init?.body)) as { target_lang: string, text: string[] }
      upstreamBodies.push(body)
      return Response.json({
        translations: body.text.map(text => ({
          text,
          detected_source_language: 'EN',
        })),
      })
    })

    const id = env.TRANSLATION_COORDINATOR.idFromName(`language-split-${crypto.randomUUID()}`)
    const stub = env.TRANSLATION_COORDINATOR.get(id)
    const makeRequest = (targetLang: string) => stub.fetch('https://coordinator.internal/translate', {
      method: 'POST',
      body: JSON.stringify({
        texts: [targetLang],
        sourceLang: 'en',
        targetLang,
        deadline: Date.now() + 5000,
      } satisfies CoordinatorRequest),
    })

    await Promise.all([makeRequest('zh-Hans'), makeRequest('de')])

    expect(upstreamBodies).toHaveLength(2)
    expect(upstreamBodies.map(body => body.target_lang).sort()).toEqual(['de', 'zh-Hans'])
  })

  it('fills the second upstream slot when more blocks arrive during the first request', async () => {
    const upstreamBodies: Array<{ text: string[] }> = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url !== UPSTREAM) {
        return new Response('', { status: 200 })
      }
      const body = JSON.parse(String(init?.body)) as { text: string[] }
      upstreamBodies.push(body)
      await scheduler.wait(100)
      return Response.json({
        translations: body.text.map(text => ({
          text: `zh:${text}`,
          detected_source_language: 'EN',
        })),
      })
    })

    const id = env.TRANSLATION_COORDINATOR.idFromName(`continuous-pump-${crypto.randomUUID()}`)
    const stub = env.TRANSLATION_COORDINATOR.get(id)
    const send = (text: string) => stub.fetch('https://coordinator.internal/translate', {
      method: 'POST',
      body: JSON.stringify({
        texts: [text],
        sourceLang: 'en',
        targetLang: 'zh-Hans',
        deadline: Date.now() + 5000,
      } satisfies CoordinatorRequest),
    }).then(response => response.json<CoordinatorResult>())

    const first = send('first')
    await scheduler.wait(40)
    const later = Array.from({ length: 10 }, (_, index) => send(`later-${index}`))
    const results = await Promise.all([first, ...later])

    expect(results.every(result => result.ok)).toBe(true)
    expect(upstreamBodies).toHaveLength(2)
    expect(upstreamBodies[0].text).toEqual(['first'])
    expect(upstreamBodies[1].text).toEqual(Array.from({ length: 10 }, (_, index) => `later-${index}`))
  })
})
