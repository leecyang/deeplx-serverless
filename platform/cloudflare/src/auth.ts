/* eslint-disable style/max-statements-per-line */

function tokens(value?: string): string[] {
  return (value ?? '').split(',').map(item => item.trim()).filter(Boolean)
}
export function requestToken(request: Request): string | null {
  const authorization = request.headers.get('authorization')?.trim()
  if (authorization) {
    const value = authorization.replace(/^(?:Bearer|DeepL-Auth-Key)\s+/i, '').trim()
    if (value && !/\s/u.test(value)) { return value }
  }
  return new URL(request.url).searchParams.get('token')
}

export function isAuthorized(request: Request, configured?: string): boolean {
  const allowed = tokens(configured)
  if (!allowed.length) { return true }
  const candidate = requestToken(request)
  return candidate !== null && allowed.includes(candidate)
}

export async function ownerKey(request: Request, configured?: string): Promise<string> {
  if (!tokens(configured).length) { return 'anonymous' }
  const value = requestToken(request) ?? ''
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}
