import { SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

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
})
