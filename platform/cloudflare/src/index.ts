import type { IEnv } from './types'
import deeplxServerless from 'deeplx-serverless'

const METHODS = ['GET', 'HEAD', 'POST', 'OPTIONS']
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': METHODS.join(', '),
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json; charset=utf-8',
}

interface ITranslateBody {
  text?: string | string[]
  from?: string
  to?: string
  source_lang?: string
  target_lang?: string
}

interface INormalizedTranslateBody {
  texts: string[]
  sourceLang?: string
  targetLang: string
}

interface ITranslateResult {
  code?: number
  msg?: string
  error?: string
  data?: string
  from?: string
  source_lang?: string
  target_lang?: string
  alternatives?: string[]
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: CORS_HEADERS,
  })
}

function emptyResponse(status = 200): Response {
  return new Response(null, {
    status,
    headers: CORS_HEADERS,
  })
}

function parseTokens(token: string | undefined): string[] {
  return (token || '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean)
}

function extractAuthorizationToken(authorization: string | null): string | null {
  if (!authorization) {
    return null
  }

  const value = authorization.trim()
  if (!value) {
    return null
  }

  const normalizedValue = value.replace(/^DeepL-Auth-Key\s+/i, '').replace(/^Bearer\s+/i, '').trim()
  if (!normalizedValue || /\s/.test(normalizedValue)) {
    return null
  }

  return normalizedValue
}

function normalizeAuthorization(authorization: string | null): string | null {
  const token = extractAuthorizationToken(authorization)
  return token ? `Bearer ${token}` : null
}

function isAuthorized(request: Request, token: string | undefined): boolean {
  const tokens = parseTokens(token)
  if (!tokens.length) {
    return true
  }

  const authorizationToken = extractAuthorizationToken(request.headers.get('authorization'))
  if (authorizationToken && tokens.includes(authorizationToken)) {
    return true
  }

  const queryToken = new URL(request.url).searchParams.get('token')
  return Boolean(queryToken && tokens.includes(queryToken))
}

function rewriteRequestAuthorization(request: Request): Request {
  const normalizedAuthorization = normalizeAuthorization(request.headers.get('authorization'))
  if (!normalizedAuthorization || normalizedAuthorization === request.headers.get('authorization')) {
    return request
  }

  const headers = new Headers(request.headers)
  headers.set('authorization', normalizedAuthorization)
  return new Request(request, { headers })
}

function getStringValue(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }

  const normalizedValue = value.trim()
  return normalizedValue || undefined
}

function getTextValues(values: unknown[]): string[] {
  return values.filter((item): item is string => typeof item === 'string' && item.length > 0)
}

function normalizeTexts(text: ITranslateBody['text']): string[] {
  if (Array.isArray(text)) {
    return text.filter((item): item is string => typeof item === 'string' && item.length > 0)
  }

  if (typeof text === 'string' && text.length > 0) {
    return [text]
  }

  return []
}

function normalizeTranslateBody(body: ITranslateBody): INormalizedTranslateBody | null {
  const texts = normalizeTexts(body.text)
  const targetLang = body.target_lang || body.to
  if (!targetLang || texts.length === 0) {
    return null
  }

  return {
    texts,
    sourceLang: body.source_lang || body.from,
    targetLang,
  }
}

async function parseTranslateBody(request: Request): Promise<INormalizedTranslateBody | null> {
  const contentType = request.headers.get('content-type')?.toLowerCase() || ''

  if (contentType.includes('application/x-www-form-urlencoded') || contentType.includes('multipart/form-data')) {
    const formData = await request.clone().formData()
    return normalizeTranslateBody({
      text: getTextValues(formData.getAll('text')),
      from: getStringValue(formData.get('from')),
      to: getStringValue(formData.get('to')),
      source_lang: getStringValue(formData.get('source_lang')),
      target_lang: getStringValue(formData.get('target_lang')),
    })
  }

  try {
    const body = await request.clone().json() as ITranslateBody
    return normalizeTranslateBody(body)
  }
  catch {
    return null
  }
}

function createTranslateRequest(request: Request, payload: { text: string, sourceLang?: string, targetLang: string }): Request {
  const url = new URL(request.url)
  url.pathname = '/translate'

  const headers = new Headers(request.headers)
  headers.set('content-type', 'application/json')

  const normalizedAuthorization = normalizeAuthorization(request.headers.get('authorization'))
  if (normalizedAuthorization) {
    headers.set('authorization', normalizedAuthorization)
  }

  return new Request(url.toString(), {
    method: 'POST',
    headers,
    body: JSON.stringify({
      text: payload.text,
      source_lang: payload.sourceLang,
      target_lang: payload.targetLang,
    }),
  })
}

function deeplxErrorResponse(status: number, msg: string): Response {
  return jsonResponse({ code: status, msg }, status)
}

function officialErrorResponse(status: number, message: string): Response {
  return jsonResponse({ message }, status)
}

async function translateTexts(request: Request, token: string | undefined, payload: INormalizedTranslateBody): Promise<{
  results?: ITranslateResult[]
  status?: number
  message?: string
}> {
  const results: ITranslateResult[] = []

  for (const text of payload.texts) {
    const translateRequest = createTranslateRequest(request, {
      text,
      sourceLang: payload.sourceLang,
      targetLang: payload.targetLang,
    })
    const response = await deeplxServerless({ request: translateRequest, token })
    const result = await response.json() as ITranslateResult

    if (!response.ok || typeof result.data !== 'string') {
      return {
        status: response.status || 500,
        message: result.msg || result.error || 'Translation failed',
      }
    }

    results.push(result)
  }

  return { results }
}

async function handleTranslate(request: Request, token: string | undefined, responseType: 'deeplx' | 'official'): Promise<Response> {
  if (request.method === 'HEAD') {
    return emptyResponse(200)
  }

  if (request.method === 'OPTIONS') {
    return emptyResponse(200)
  }

  if (request.method !== 'POST') {
    return emptyResponse(405)
  }

  if (!isAuthorized(request, token)) {
    return responseType === 'official'
      ? officialErrorResponse(403, 'Authorization failure, check auth_key')
      : deeplxErrorResponse(403, 'Request missing authentication information')
  }

  const payload = await parseTranslateBody(request)
  if (!payload) {
    return responseType === 'official'
      ? officialErrorResponse(400, 'Bad request')
      : deeplxErrorResponse(400, 'Bad request')
  }

  const translated = await translateTexts(request, token, payload)
  if (!translated.results) {
    const status = translated.status || 500
    const message = translated.message || 'Translation failed'
    return responseType === 'official'
      ? officialErrorResponse(status, message)
      : deeplxErrorResponse(status, message)
  }

  if (responseType === 'official') {
    return jsonResponse({
      translations: translated.results.map((result, index) => ({
        billed_characters: payload.texts[index].length,
        detected_source_language: result.source_lang || result.from || payload.sourceLang || '',
        text: result.data,
      })),
    }, 200)
  }

  if (translated.results.length === 1) {
    const result = translated.results[0]
    return jsonResponse(result, result.code || 200)
  }

  return jsonResponse(translated.results, 200)
}

export default {
  async fetch(request, env, _ctx): Promise<Response> {
    const url = new URL(request.url)
    const token = env.token

    if (url.pathname === '/v2/usage') {
      if (request.method === 'HEAD') {
        return emptyResponse(200)
      }

      if (request.method === 'OPTIONS') {
        return emptyResponse(200)
      }

      if (request.method !== 'GET') {
        return emptyResponse(405)
      }

      if (!isAuthorized(request, token)) {
        return jsonResponse({ message: 'Authorization failure, check auth_key' }, 403)
      }

      return jsonResponse({
        character_count: 0,
        character_limit: 1000000000,
      }, 200)
    }

    if (url.pathname === '/v2/translate') {
      return handleTranslate(request, token, 'official')
    }

    if (url.pathname === '/translate') {
      return handleTranslate(request, token, 'deeplx')
    }

    return deeplxServerless({ request: rewriteRequestAuthorization(request), token })
  },
} satisfies ExportedHandler<IEnv>
