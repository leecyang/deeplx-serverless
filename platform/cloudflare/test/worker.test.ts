import { SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { withJsonHeartbeat } from '../src/index'

describe('public compatibility routes', () => {
  it('keeps the usage response shape', async () => {
    const response = await SELF.fetch('https://example.com/v2/usage')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      character_count: 0,
      character_limit: 1_000_000_000,
    })
  })

  it('rejects sync input over 3000 characters as 503, never 429', async () => {
    const response = await SELF.fetch('https://example.com/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'a'.repeat(3001), target_lang: 'ZH' }),
    })
    expect(response.status).toBe(503)
    expect(response.headers.get('retry-after')).toBe('1')
    expect(await response.json()).toEqual({
      code: 503,
      msg: 'Synchronous input is limited to 3000 characters; use POST /jobs',
      retry_after: 1,
    })
  })

  it('preserves official bad-request shape', async () => {
    const response = await SELF.fetch('https://example.com/v2/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ message: 'Bad request' })
  })

  it('starts a JSON heartbeat before a slow translation completes', async () => {
    const waits: Promise<unknown>[] = []
    const response = await withJsonHeartbeat(
      scheduler.wait(40).then(() => Response.json({ code: 200, data: '完成' })),
      { waitUntil: promise => waits.push(promise) },
      'deeplx',
      5,
      5,
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('x-deeplx-heartbeat')).toBe('1')
    const text = await response.text()
    expect(text.startsWith(' '.repeat(1024))).toBe(true)
    expect(JSON.parse(text)).toEqual({ code: 200, data: '完成' })
    await Promise.all(waits)
  })

  it('preserves an immediately available 503 response and Retry-After', async () => {
    const response = await withJsonHeartbeat(
      Promise.resolve(Response.json({ code: 503 }, { status: 503, headers: { 'Retry-After': '10' } })),
      { waitUntil: () => undefined },
      'deeplx',
      5,
      5,
    )

    expect(response.status).toBe(503)
    expect(response.headers.get('retry-after')).toBe('10')
  })
})
