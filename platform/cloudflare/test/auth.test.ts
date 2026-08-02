/* eslint-disable style/max-statements-per-line */

import { describe, expect, it } from 'vitest'
import { isAuthorized, requestToken } from '../src/auth'

describe('authentication compatibility', () => {
  it.each([
    ['Bearer alpha', null],
    ['DeepL-Auth-Key alpha', null],
    [null, 'alpha'],
  ])('accepts supported token transport', (authorization, queryToken) => {
    const url = new URL('https://example.com/translate')
    if (queryToken) { url.searchParams.set('token', queryToken) }
    const headers = authorization ? { Authorization: authorization } : undefined
    const request = new Request(url, { headers })
    expect(requestToken(request)).toBe('alpha')
    expect(isAuthorized(request, 'alpha,beta')).toBe(true)
  })

  it('is open only when no token is configured', () => {
    const request = new Request('https://example.com/translate')
    expect(isAuthorized(request, undefined)).toBe(true)
    expect(isAuthorized(request, 'alpha')).toBe(false)
  })
})
