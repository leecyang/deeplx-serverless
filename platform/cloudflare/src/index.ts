/* eslint-disable style/max-statements-per-line */

import { isAuthorized, ownerKey } from './auth'
import { TranslationCoordinator } from './coordinator'
import {
  batchPieces,
  normalizeSourceLanguage,
  normalizeTargetLanguage,
  type Piece,
  type ResponseType,
  splitTexts,
  type TranslateInput,
  unicodeLength,
} from './protocol'

export { TranslationCoordinator }

interface AppEnv {
  DB: D1Database
  JOB_QUEUE: Queue<{ jobId: string }>
  TRANSLATION_COORDINATOR: DurableObjectNamespace<TranslationCoordinator>
  token?: string
  UPSTREAM_RPS?: string
  UPSTREAM_BURST?: string
  UPSTREAM_CONCURRENCY?: string
  UPSTREAM_BATCH_WINDOW_MS?: string
  SYNC_DEADLINE_MS?: string
  ASYNC_DEADLINE_MS?: string
  SYNC_MAX_CHARS?: string
  ASYNC_MAX_CHARS?: string
  CACHE_TTL_SECONDS?: string
  EDGE_CACHE_TTL_SECONDS?: string
}

interface CachedSegment {
  translated_text: string
  detected_source_lang: string
}

interface TranslationResult {
  text: string
  detectedSourceLang: string
}

function chunks<T>(values: T[], size: number): T[][] {
  const result: T[][] = []
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size))
  }
  return result
}

interface JobRow {
  id: string
  owner_key: string
  response_type: ResponseType
  request_json: string
  colo: string
  status: 'pending' | 'processing' | 'succeeded' | 'failed' | 'expired'
  result_json: string | null
  error_json: string | null
  lease_token: string | null
  lease_until: number | null
  created_at: number
  deadline_at: number
  retain_until: number
}

class TemporaryFailure extends Error {
  constructor(public readonly retryAfter: number, message: string) {
    super(message)
  }
}

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json; charset=utf-8',
}

function numeric(value: string | undefined, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function json(body: unknown, status = 200, extra: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, ...Object.fromEntries(new Headers(extra)) },
  })
}

function empty(status = 200): Response {
  return new Response(null, { status, headers: CORS_HEADERS })
}

export async function withJsonHeartbeat(
  responsePromise: Promise<Response>,
  ctx: Pick<ExecutionContext, 'waitUntil'>,
  responseType: ResponseType,
  initialDelayMs = 2000,
  heartbeatMs = 1500,
): Promise<Response> {
  const ready = await Promise.race([
    responsePromise.then(response => ({ response })),
    scheduler.wait(initialDelayMs).then(() => null),
  ])
  if (ready) { return ready.response }

  const { readable, writable } = new TransformStream()
  const writer = writable.getWriter()
  const encoder = new TextEncoder()
  const pump = (async () => {
    try {
      // JSON permits leading whitespace. A full KiB makes intermediary proxies
      // flush the chunk instead of buffering a one-byte heartbeat.
      await writer.write(encoder.encode(' '.repeat(1024)))
      while (true) {
        const outcome = await Promise.race([
          responsePromise.then(response => ({ response })),
          scheduler.wait(heartbeatMs).then(() => null),
        ])
        if (outcome) {
          await writer.write(encoder.encode(await outcome.response.text()))
          break
        }
        await writer.write(encoder.encode(' '.repeat(256)))
      }
      await writer.close()
    }
    catch {
      try {
        const fallback = responseType === 'official'
          ? { message: 'DeepL is temporarily unavailable', retry_after: 10 }
          : { code: 503, msg: 'DeepL is temporarily unavailable', retry_after: 10 }
        await writer.write(encoder.encode(JSON.stringify(fallback)))
        await writer.close()
      }
      catch {
        await writer.abort()
      }
    }
  })()
  ctx.waitUntil(pump)
  return new Response(readable, {
    status: 200,
    headers: {
      ...CORS_HEADERS,
      'Cache-Control': 'no-store, no-transform',
      'Content-Encoding': 'identity',
      'X-DeepLX-Heartbeat': '1',
    },
  })
}

function temporary(responseType: ResponseType, message: string, retryAfter: number): Response {
  const seconds = Math.max(1, Math.ceil(retryAfter))
  return json(
    responseType === 'official'
      ? { message, retry_after: seconds }
      : { code: 503, msg: message, retry_after: seconds },
    503,
    { 'Retry-After': String(seconds) },
  )
}

function badRequest(responseType: ResponseType, message = 'Bad request'): Response {
  return json(responseType === 'official' ? { message } : { code: 400, msg: message }, 400)
}

function forbidden(responseType: ResponseType): Response {
  return json(
    responseType === 'official'
      ? { message: 'Authorization failure, check auth_key' }
      : { code: 403, msg: 'Request missing authentication information' },
    403,
  )
}

function getString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function normalizeBody(value: unknown): TranslateInput | null {
  if (!value || typeof value !== 'object') { return null }
  const body = value as Record<string, unknown>
  const rawText = body.text
  const texts = Array.isArray(rawText)
    ? rawText.filter((item): item is string => typeof item === 'string' && item.length > 0)
    : typeof rawText === 'string' && rawText.length > 0
      ? [rawText]
      : []
  const target = body.target_lang ?? body.to
  if (!texts.length || typeof target !== 'string' || !target.trim()) { return null }
  const source = body.source_lang ?? body.from
  return {
    texts,
    targetLang: target,
    sourceLang: typeof source === 'string' && source.trim() ? source : undefined,
  }
}

async function parseInput(request: Request): Promise<{ input: TranslateInput, bytes: number } | null> {
  const contentType = request.headers.get('content-type')?.toLowerCase() ?? ''
  if (contentType.includes('application/x-www-form-urlencoded') || contentType.includes('multipart/form-data')) {
    const form = await request.formData()
    const input = normalizeBody({
      text: form.getAll('text').filter((item): item is string => typeof item === 'string'),
      from: getString(form.get('from')),
      to: getString(form.get('to')),
      source_lang: getString(form.get('source_lang')),
      target_lang: getString(form.get('target_lang')),
    })
    if (!input) { return null }
    return { input, bytes: new TextEncoder().encode(JSON.stringify(input)).byteLength }
  }
  try {
    const raw = await request.text()
    const input = normalizeBody(JSON.parse(raw))
    return input ? { input, bytes: new TextEncoder().encode(raw).byteLength } : null
  }
  catch {
    return null
  }
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

async function segmentKey(piece: string, source: string | undefined, target: string): Promise<string> {
  return sha256(`oneshot-v3\0${source ?? ''}\0${target}\0${piece}`)
}

async function edgeKey(input: TranslateInput, responseType: ResponseType): Promise<Request> {
  const key = await sha256(JSON.stringify({
    version: 'oneshot-v3',
    responseType,
    source: normalizeSourceLanguage(input.sourceLang) ?? '',
    target: normalizeTargetLanguage(input.targetLang),
    texts: input.texts,
  }))
  return new Request(`https://deeplx-cache.invalid/${key}`, { method: 'GET' })
}

async function readSegmentCache(
  env: AppEnv,
  pieces: Piece[],
  source: string | undefined,
  target: string,
): Promise<Map<string, CachedSegment>> {
  const unique = [...new Set(pieces.filter(item => item.translatable).map(item => item.text))]
  const keys = await Promise.all(unique.map(text => segmentKey(text, source, target)))
  if (!keys.length) { return new Map() }
  const now = Date.now()
  const cache = new Map<string, CachedSegment>()
  for (let offset = 0; offset < keys.length; offset += 50) {
    const keyWindow = keys.slice(offset, offset + 50)
    const results = await env.DB.batch(keyWindow.map(key =>
      env.DB.prepare(
        'SELECT translated_text, detected_source_lang FROM translation_cache WHERE cache_key = ? AND expires_at > ?',
      ).bind(key, now),
    ))
    results.forEach((result, index) => {
      const row = result.results[0] as CachedSegment | undefined
      if (row) { cache.set(unique[offset + index], row) }
    })
  }
  return cache
}

async function writeSegmentCache(
  env: AppEnv,
  values: Array<{ sourceText: string, translatedText: string, detected: string }>,
  source: string | undefined,
  target: string,
): Promise<void> {
  if (!values.length) { return }
  const now = Date.now()
  const expires = now + numeric(env.CACHE_TTL_SECONDS, 2_592_000) * 1000
  const statements = await Promise.all(values.map(async value => env.DB.prepare(`
    INSERT INTO translation_cache
      (cache_key, source_lang, target_lang, source_text, translated_text, detected_source_lang, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(cache_key) DO UPDATE SET
      translated_text = excluded.translated_text,
      detected_source_lang = excluded.detected_source_lang,
      created_at = excluded.created_at,
      expires_at = excluded.expires_at
  `).bind(
    await segmentKey(value.sourceText, source, target),
    source ?? '',
    target,
    value.sourceText,
    value.translatedText,
    value.detected,
    now,
    expires,
  )))
  for (const statementWindow of chunks(statements, 50)) {
    await env.DB.batch(statementWindow)
  }
}

async function translate(
  env: AppEnv,
  input: TranslateInput,
  colo: string,
  deadline: number,
  heartbeat?: () => Promise<void>,
): Promise<TranslationResult[]> {
  const source = normalizeSourceLanguage(input.sourceLang)
  const target = normalizeTargetLanguage(input.targetLang)
  const pieces = splitTexts(input.texts, 1500)
  const cached = await readSegmentCache(env, pieces, source, target)
  const missingByText = new Map<string, Piece>()
  for (const piece of pieces) {
    if (piece.translatable && !cached.has(piece.text)) { missingByText.set(piece.text, piece) }
  }
  const missing = [...missingByText.values()]
  const fresh: Array<{ sourceText: string, translatedText: string, detected: string }> = []
  const coordinator = env.TRANSLATION_COORDINATOR.get(
    env.TRANSLATION_COORDINATOR.idFromName(`upstream:${colo || 'global'}`),
  )
  const batches = batchPieces(missing, 1500)
  for (let offset = 0; offset < batches.length; offset += 2) {
    const window = batches.slice(offset, offset + 2)
    const completed = await Promise.all(window.map(async (batch) => {
      if (Date.now() >= deadline) { throw new TemporaryFailure(1, 'Translation deadline exceeded') }
      const response = await coordinator.fetch('https://coordinator.internal/translate', {
        method: 'POST',
        body: JSON.stringify({
          texts: batch.map(item => item.text),
          sourceLang: source,
          targetLang: target,
          deadline,
        }),
      })
      const result = await response.json() as
        | { ok: true, translations: Array<{ text: string, detectedSourceLang: string }> }
        | { ok: false, retryAfter: number, reason: string }
      if (!result.ok) { throw new TemporaryFailure(result.retryAfter, result.reason) }
      return { batch, translations: result.translations }
    }))
    for (const { batch, translations } of completed) {
      translations.forEach((translation, index) => {
        const sourceText = batch[index].text
        const value = {
          sourceText,
          translatedText: translation.text,
          detected: translation.detectedSourceLang || (source?.toUpperCase() ?? ''),
        }
        fresh.push(value)
        cached.set(sourceText, {
          translated_text: value.translatedText,
          detected_source_lang: value.detected,
        })
      })
    }
    if (heartbeat) { await heartbeat() }
  }
  await writeSegmentCache(env, fresh, source, target)

  return input.texts.map((_text, textIndex) => {
    const selected = pieces.filter(piece => piece.textIndex === textIndex).sort((a, b) => a.order - b.order)
    let detected = source?.toUpperCase() ?? ''
    const text = selected.map((piece) => {
      if (!piece.translatable) { return piece.text }
      const value = cached.get(piece.text)
      if (!value) { throw new Error('Missing translated segment') }
      if (value.detected_source_lang) { detected = value.detected_source_lang }
      return value.translated_text
    }).join('')
    return { text, detectedSourceLang: detected }
  })
}

function formatSuccess(input: TranslateInput, results: TranslationResult[], responseType: ResponseType): unknown {
  const target = input.targetLang.toUpperCase()
  if (responseType === 'official') {
    return {
      translations: results.map((result, index) => ({
        billed_characters: unicodeLength(input.texts[index]),
        detected_source_language: result.detectedSourceLang,
        text: result.text,
      })),
    }
  }
  const values = results.map(result => ({
    code: 200,
    id: Date.now(),
    method: 'Free',
    from: result.detectedSourceLang,
    to: target,
    data: result.text,
    alternatives: [],
    source_lang: result.detectedSourceLang,
    target_lang: target,
  }))
  return values.length === 1 ? values[0] : values
}

function requestColo(request: Request): string {
  const colo = request.cf?.colo
  return typeof colo === 'string' && colo ? colo : 'global'
}

async function handleTranslate(
  request: Request,
  env: AppEnv,
  ctx: ExecutionContext,
  responseType: ResponseType,
): Promise<Response> {
  if (request.method === 'HEAD' || request.method === 'OPTIONS') { return empty() }
  if (request.method !== 'POST') { return empty(405) }
  if (!isAuthorized(request, env.token)) { return forbidden(responseType) }
  const parsed = await parseInput(request)
  if (!parsed) { return badRequest(responseType) }
  const total = parsed.input.texts.reduce((sum, text) => sum + unicodeLength(text), 0)
  if (total > numeric(env.SYNC_MAX_CHARS, 3000)) {
    return temporary(responseType, 'Synchronous input is limited to 3000 characters; use POST /jobs', 1)
  }

  const cacheKey = await edgeKey(parsed.input, responseType)
  const cached = await caches.default.match(cacheKey)
  if (cached) { return new Response(cached.body, { status: cached.status, headers: cached.headers }) }
  try {
    const deadline = Date.now() + numeric(env.SYNC_DEADLINE_MS, 5000)
    const result = formatSuccess(
      parsed.input,
      await translate(env, parsed.input, requestColo(request), deadline),
      responseType,
    )
    const response = json(result)
    const edgeResponse = response.clone()
    edgeResponse.headers.set('Cache-Control', `public, max-age=${numeric(env.EDGE_CACHE_TTL_SECONDS, 86_400)}`)
    ctx.waitUntil(caches.default.put(cacheKey, edgeResponse))
    return response
  }
  catch (error) {
    const failure = error instanceof TemporaryFailure ? error : new TemporaryFailure(10, 'Upstream unavailable')
    console.warn(JSON.stringify({
      event: 'translation_failed',
      colo: requestColo(request),
      status: 503,
      retry_after: failure.retryAfter,
      reason: failure.message,
    }))
    return temporary(responseType, 'DeepL is temporarily unavailable', failure.retryAfter)
  }
}

async function createJob(request: Request, env: AppEnv): Promise<Response> {
  const url = new URL(request.url)
  const responseType = url.searchParams.get('response_type') === 'official' ? 'official' : 'deeplx'
  if (!isAuthorized(request, env.token)) { return forbidden(responseType) }
  const parsed = await parseInput(request)
  if (!parsed) { return badRequest(responseType) }
  const total = parsed.input.texts.reduce((sum, text) => sum + unicodeLength(text), 0)
  if (total > numeric(env.ASYNC_MAX_CHARS, 100_000) || parsed.bytes > 512 * 1024) {
    return badRequest(responseType, 'Asynchronous input exceeds 100000 characters or 512 KiB')
  }
  const now = Date.now()
  const id = crypto.randomUUID()
  await env.DB.prepare(`
    INSERT INTO translation_jobs
      (id, owner_key, response_type, request_json, colo, status, created_at, deadline_at, retain_until)
    VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)
  `).bind(
    id,
    await ownerKey(request, env.token),
    responseType,
    JSON.stringify(parsed.input),
    requestColo(request),
    now,
    now + numeric(env.ASYNC_DEADLINE_MS, 60_000),
    now + 60 * 60 * 1000,
  ).run()
  await env.JOB_QUEUE.send({ jobId: id })
  return json({
    job_id: id,
    status: 'pending',
    status_url: `${url.origin}/jobs/${id}`,
    poll_after: 1,
  }, 202, { 'Retry-After': '1' })
}

async function readJob(request: Request, env: AppEnv, id: string): Promise<Response> {
  const row = await env.DB.prepare('SELECT * FROM translation_jobs WHERE id = ?').bind(id).first<JobRow>()
  if (!row) { return json({ message: 'Job not found' }, 404) }
  if (row.retain_until <= Date.now() || row.status === 'expired') { return json({ message: 'Job expired' }, 410) }
  if (!isAuthorized(request, env.token) || await ownerKey(request, env.token) !== row.owner_key) {
    return forbidden(row.response_type)
  }
  if (row.status === 'failed') {
    const error = row.error_json ? JSON.parse(row.error_json) : { message: 'Job failed', retry_after: 10 }
    return json(error, 503, { 'Retry-After': String(error.retry_after ?? 10) })
  }
  return json({
    job_id: row.id,
    status: row.status,
    ...(row.status === 'succeeded' ? { result: JSON.parse(row.result_json ?? 'null') } : {}),
    ...(row.status !== 'succeeded' ? { poll_after: 1 } : {}),
  })
}

async function processJob(env: AppEnv, jobId: string): Promise<'done' | 'retry'> {
  const now = Date.now()
  const lease = crypto.randomUUID()
  const acquired = await env.DB.prepare(`
    UPDATE translation_jobs
    SET status = 'processing', lease_token = ?, lease_until = MIN(deadline_at + 5000, ?),
        started_at = COALESCE(started_at, ?)
    WHERE id = ? AND status IN ('pending', 'processing')
      AND (lease_until IS NULL OR lease_until < ?)
      AND deadline_at > ?
  `).bind(lease, now + 20_000, now, jobId, now, now).run()
  if (!acquired.meta.changes) {
    const row = await env.DB.prepare('SELECT status, deadline_at FROM translation_jobs WHERE id = ?').bind(jobId).first<{ status: string, deadline_at: number }>()
    if (!row || row.status === 'succeeded' || row.status === 'failed') { return 'done' }
    if (row.deadline_at <= now) {
      await failJob(env, jobId, 'Job exceeded its 60 second deadline', 10)
      return 'done'
    }
    return 'retry'
  }

  const row = await env.DB.prepare('SELECT * FROM translation_jobs WHERE id = ?').bind(jobId).first<JobRow>()
  if (!row) { return 'done' }
  try {
    const input = JSON.parse(row.request_json) as TranslateInput
    const results = await translate(env, input, row.colo, row.deadline_at, async () => {
      await env.DB.prepare(`
        UPDATE translation_jobs SET lease_until = ?
        WHERE id = ? AND lease_token = ? AND status = 'processing'
      `).bind(Math.min(row.deadline_at + 5_000, Date.now() + 20_000), jobId, lease).run()
    })
    const resultJson = JSON.stringify(formatSuccess(input, results, row.response_type))
    const completed = Date.now()
    await env.DB.prepare(`
      UPDATE translation_jobs
      SET status = 'succeeded', result_json = ?, completed_at = ?, retain_until = ?,
          lease_token = NULL, lease_until = NULL
      WHERE id = ? AND lease_token = ?
    `).bind(resultJson, completed, completed + 60 * 60 * 1000, jobId, lease).run()
    return 'done'
  }
  catch (error) {
    if (Date.now() < row.deadline_at && error instanceof TemporaryFailure) {
      await env.DB.prepare(`
        UPDATE translation_jobs SET status = 'pending', lease_token = NULL, lease_until = NULL
        WHERE id = ? AND lease_token = ?
      `).bind(jobId, lease).run()
      return 'retry'
    }
    await failJob(env, jobId, 'DeepL is temporarily unavailable', error instanceof TemporaryFailure ? error.retryAfter : 10)
    return 'done'
  }
}

async function failJob(env: AppEnv, jobId: string, message: string, retryAfter: number): Promise<void> {
  const now = Date.now()
  await env.DB.prepare(`
    UPDATE translation_jobs
    SET status = 'failed', error_json = ?, completed_at = ?, retain_until = ?,
        lease_token = NULL, lease_until = NULL
    WHERE id = ? AND status NOT IN ('succeeded', 'failed')
  `).bind(
    JSON.stringify({ message, retry_after: retryAfter }),
    now,
    now + 60 * 60 * 1000,
    jobId,
  ).run()
}

async function cleanup(env: AppEnv): Promise<void> {
  const now = Date.now()
  await env.DB.prepare(`
    DELETE FROM translation_cache WHERE cache_key IN (
      SELECT cache_key FROM translation_cache WHERE expires_at <= ? ORDER BY expires_at LIMIT 500
    )
  `).bind(now).run()
  await env.DB.prepare(`
    UPDATE translation_jobs
    SET status = 'failed', error_json = ?, completed_at = ?, retain_until = ?
    WHERE id IN (
      SELECT id FROM translation_jobs
      WHERE status IN ('pending', 'processing') AND deadline_at <= ?
      ORDER BY deadline_at LIMIT 100
    )
  `).bind(
    JSON.stringify({ message: 'Job exceeded its 60 second deadline', retry_after: 10 }),
    now,
    now + 60 * 60 * 1000,
    now,
  ).run()
  await env.DB.prepare(`
    DELETE FROM translation_jobs WHERE id IN (
      SELECT id FROM translation_jobs WHERE retain_until <= ? ORDER BY retain_until LIMIT 500
    )
  `).bind(now).run()
}

export default {
  async fetch(request: Request, env: AppEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)
    if (request.method === 'OPTIONS') { return empty() }
    if (url.pathname === '/v2/usage') {
      if (request.method === 'HEAD') { return empty() }
      if (request.method !== 'GET') { return empty(405) }
      if (!isAuthorized(request, env.token)) { return forbidden('official') }
      return json({ character_count: 0, character_limit: 1_000_000_000 })
    }
    if (url.pathname === '/v2/translate') {
      return withJsonHeartbeat(handleTranslate(request, env, ctx, 'official'), ctx, 'official')
    }
    if (url.pathname === '/translate') {
      return withJsonHeartbeat(handleTranslate(request, env, ctx, 'deeplx'), ctx, 'deeplx')
    }
    if (url.pathname === '/jobs' && request.method === 'POST') { return createJob(request, env) }
    const match = url.pathname.match(/^\/jobs\/([0-9a-f-]+)$/i)
    if (match && request.method === 'GET') { return readJob(request, env, match[1]) }
    return json({ code: 404, msg: 'Not found' }, 404)
  },

  async queue(batch: MessageBatch<unknown>, env: AppEnv): Promise<void> {
    const isDeadLetter = batch.queue === 'deeplx-jobs-dlq'
    for (const message of batch.messages) {
      const body = message.body
      if (!body || typeof body !== 'object' || typeof (body as { jobId?: unknown }).jobId !== 'string') {
        message.ack()
        continue
      }
      const jobId = (body as { jobId: string }).jobId
      if (isDeadLetter) {
        await failJob(env, jobId, 'Job delivery exhausted', 10)
        message.ack()
        continue
      }
      const outcome = await processJob(env, jobId)
      if (outcome === 'retry') {
        message.retry({ delaySeconds: 5 })
      }
      else { message.ack() }
    }
  },

  async scheduled(_controller: ScheduledController, env: AppEnv): Promise<void> {
    await cleanup(env)
  },
} satisfies ExportedHandler<AppEnv>
