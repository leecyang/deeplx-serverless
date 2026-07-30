/* eslint-disable style/max-statements-per-line */

import { DurableObject } from 'cloudflare:workers'
import { buildOneshotBody, parseOneshotResponse, unicodeLength } from './protocol'

export interface CoordinatorRequest {
  texts: string[]
  sourceLang?: string
  targetLang: string
  deadline: number
}

export type CoordinatorResult =
  | { ok: true, translations: Array<{ text: string, detectedSourceLang: string }> }
  | { ok: false, retryAfter: number, reason: string }

interface PendingRequest {
  payload: CoordinatorRequest
  resolve: (result: CoordinatorResult) => void
}

interface CoordinatorState {
  instanceId: string
  cookies: string
  tokens: number
  lastRefill: number
  circuitUntil: number
  failures: number
  halfOpen: boolean
}

const UPSTREAM = 'https://oneshot-free.www.deepl.com/v1/translate'
const WARMUP = 'https://www.deepl.com/translator'
const MAX_BATCH_CHARS = 1500
const MAX_BATCH_ITEMS = 50

function numberVar(value: string | undefined, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function retrySeconds(response: Response, fallback: number): number {
  const raw = response.headers.get('retry-after')
  if (!raw) { return fallback }
  const seconds = Number(raw)
  if (Number.isFinite(seconds)) { return Math.max(1, Math.ceil(seconds)) }
  const timestamp = Date.parse(raw)
  return Number.isFinite(timestamp) ? Math.max(1, Math.ceil((timestamp - Date.now()) / 1000)) : fallback
}

export class TranslationCoordinator extends DurableObject<Env> {
  private active = 0
  private pending: PendingRequest[] = []
  private flushTimer: ReturnType<typeof setTimeout> | undefined
  private flushing = false
  private statePromise: Promise<CoordinatorState> | undefined
  private warmupPromise: Promise<void> | undefined

  private async state(): Promise<CoordinatorState> {
    this.statePromise ??= (async () => {
      const current = await this.ctx.storage.get<CoordinatorState>('state')
      if (current) { return current }
      const created: CoordinatorState = {
        instanceId: crypto.randomUUID(),
        cookies: '',
        tokens: numberVar(this.env.UPSTREAM_BURST, 4),
        lastRefill: Date.now(),
        circuitUntil: 0,
        failures: 0,
        halfOpen: false,
      }
      await this.ctx.storage.put('state', created)
      return created
    })()
    return this.statePromise
  }

  private async warmCookies(state: CoordinatorState, deadline: number): Promise<void> {
    if (state.cookies || Date.now() >= deadline) { return }
    if (this.warmupPromise) {
      await this.warmupPromise
      return
    }
    this.warmupPromise = this.performWarmup(state, deadline)
    try {
      await this.warmupPromise
    }
    finally {
      this.warmupPromise = undefined
    }
  }

  private async performWarmup(state: CoordinatorState, deadline: number): Promise<void> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), Math.min(750, Math.max(1, deadline - Date.now())))
    try {
      const response = await fetch(WARMUP, {
        headers: { 'User-Agent': 'Mozilla/5.0 Chrome/120.0.0.0 Safari/537.36' },
        signal: controller.signal,
      })
      const values = response.headers.getSetCookie()
      state.cookies = values.map(value => value.split(';', 1)[0]).join('; ')
      await this.ctx.storage.put('state', state)
    }
    catch {
      // Translation can still succeed without a warm cookie.
    }
    finally {
      clearTimeout(timer)
    }
  }

  private async acquire(state: CoordinatorState, deadline: number): Promise<number> {
    const rate = numberVar(this.env.UPSTREAM_RPS, 2)
    const burst = numberVar(this.env.UPSTREAM_BURST, 4)
    const concurrency = numberVar(this.env.UPSTREAM_CONCURRENCY, 2)
    while (Date.now() < deadline) {
      const now = Date.now()
      state.tokens = Math.min(burst, state.tokens + ((now - state.lastRefill) / 1000) * rate)
      state.lastRefill = now
      if (now < state.circuitUntil) { return Math.ceil((state.circuitUntil - now) / 1000) }
      if (state.halfOpen && this.active > 0) { return 1 }
      if (state.tokens >= 1 && this.active < concurrency) {
        state.tokens -= 1
        this.active += 1
        try {
          await this.ctx.storage.put('state', state)
        }
        catch (error) {
          this.active = Math.max(0, this.active - 1)
          throw error
        }
        return 0
      }
      await scheduler.wait(Math.min(50, Math.max(1, deadline - now)))
    }
    return 1
  }

  private async openCircuit(state: CoordinatorState, seconds: number): Promise<void> {
    state.failures += 1
    state.circuitUntil = Date.now() + seconds * 1000
    state.halfOpen = true
    await this.ctx.storage.put('state', state)
  }

  private compatible(candidate: CoordinatorRequest, first: CoordinatorRequest): boolean {
    return (candidate.sourceLang ?? '') === (first.sourceLang ?? '')
      && candidate.targetLang === first.targetLang
  }

  private takeBatch(): PendingRequest[] {
    const first = this.pending.shift()
    if (!first) { return [] }
    const selected = [first]
    let chars = first.payload.texts.reduce((sum, text) => sum + unicodeLength(text), 0)
    let items = first.payload.texts.length
    for (let index = 0; index < this.pending.length;) {
      const candidate = this.pending[index]
      const candidateChars = candidate.payload.texts.reduce((sum, text) => sum + unicodeLength(text), 0)
      const candidateItems = candidate.payload.texts.length
      if (
        this.compatible(candidate.payload, first.payload)
        && chars + candidateChars <= MAX_BATCH_CHARS
        && items + candidateItems <= MAX_BATCH_ITEMS
      ) {
        selected.push(candidate)
        this.pending.splice(index, 1)
        chars += candidateChars
        items += candidateItems
      }
      else {
        index += 1
      }
    }
    return selected
  }

  private resolveExpired(): void {
    const now = Date.now()
    const fresh: PendingRequest[] = []
    for (const request of this.pending) {
      if (request.payload.deadline <= now) {
        request.resolve({ ok: false, retryAfter: 1, reason: 'overloaded' })
      }
      else {
        fresh.push(request)
      }
    }
    this.pending = fresh
  }

  private async executeBatch(batch: PendingRequest[]): Promise<void> {
    const first = batch[0].payload
    const texts = batch.flatMap(request => request.payload.texts)
    const deadline = Math.min(...batch.map(request => request.payload.deadline))
    const state = await this.state()
    const now = Date.now()
    if (now < state.circuitUntil) {
      const result = {
        ok: false,
        retryAfter: Math.ceil((state.circuitUntil - now) / 1000),
        reason: 'circuit_open',
      } satisfies CoordinatorResult
      batch.forEach(request => request.resolve(result))
      return
    }
    if (state.halfOpen && now >= state.circuitUntil) { state.circuitUntil = 0 }
    const wait = await this.acquire(state, deadline)
    if (wait > 0) {
      const result = { ok: false, retryAfter: wait, reason: 'overloaded' } satisfies CoordinatorResult
      batch.forEach(request => request.resolve(result))
      return
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), Math.max(1, deadline - Date.now()))
    try {
      await this.warmCookies(state, deadline)
      const headers = new Headers({
        'Authorization': 'None',
        'Accept': '*/*',
        'Content-Type': 'application/json',
        'Origin': 'chrome-extension://cofdbpoegempjloogbagkncekinflcnj',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'cross-site',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
      })
      if (state.cookies) { headers.set('Cookie', state.cookies) }
      const response = await fetch(UPSTREAM, {
        method: 'POST',
        headers,
        body: JSON.stringify(buildOneshotBody(texts, first.targetLang, first.sourceLang, state.instanceId)),
        signal: controller.signal,
      })
      if (response.status === 429) {
        const fallback = Math.min(300, 30 * (2 ** Math.min(state.failures, 3)))
        const seconds = retrySeconds(response, fallback)
        await this.openCircuit(state, seconds)
        const result = { ok: false, retryAfter: seconds, reason: 'upstream_429' } satisfies CoordinatorResult
        batch.forEach(request => request.resolve(result))
        return
      }
      if (response.status >= 500) {
        await this.openCircuit(state, 10)
        const result = { ok: false, retryAfter: 10, reason: 'upstream_5xx' } satisfies CoordinatorResult
        batch.forEach(request => request.resolve(result))
        return
      }
      if (!response.ok) {
        await this.openCircuit(state, 5)
        const result = { ok: false, retryAfter: 5, reason: 'upstream_error' } satisfies CoordinatorResult
        batch.forEach(request => request.resolve(result))
        return
      }
      let responseBody: unknown
      try {
        responseBody = await response.json()
      }
      catch {
        await this.openCircuit(state, 10)
        const result = { ok: false, retryAfter: 10, reason: 'invalid_json' } satisfies CoordinatorResult
        batch.forEach(request => request.resolve(result))
        return
      }
      const parsed = parseOneshotResponse(responseBody, texts.length)
      if (!parsed) {
        await this.openCircuit(state, 10)
        const result = { ok: false, retryAfter: 10, reason: 'invalid_json' } satisfies CoordinatorResult
        batch.forEach(request => request.resolve(result))
        return
      }
      state.failures = 0
      state.halfOpen = false
      state.circuitUntil = 0
      await this.ctx.storage.put('state', state)
      let offset = 0
      for (const request of batch) {
        const length = request.payload.texts.length
        request.resolve({ ok: true, translations: parsed.slice(offset, offset + length) })
        offset += length
      }
    }
    catch {
      await this.openCircuit(state, 10)
      const result = { ok: false, retryAfter: 10, reason: 'timeout' } satisfies CoordinatorResult
      batch.forEach(request => request.resolve(result))
    }
    finally {
      clearTimeout(timer)
      this.active = Math.max(0, this.active - 1)
    }
  }

  private async flush(): Promise<void> {
    if (this.flushing) { return }
    this.flushing = true
    try {
      while (this.pending.length) {
        this.resolveExpired()
        if (!this.pending.length) { break }
        const concurrency = Math.max(1, Math.floor(numberVar(this.env.UPSTREAM_CONCURRENCY, 2)))
        const batches: PendingRequest[][] = []
        while (this.pending.length && batches.length < concurrency) {
          batches.push(this.takeBatch())
        }
        await Promise.all(batches.map(async (batch) => {
          try {
            await this.executeBatch(batch)
          }
          catch {
            const result = { ok: false, retryAfter: 10, reason: 'coordinator_error' } satisfies CoordinatorResult
            batch.forEach(request => request.resolve(result))
          }
        }))
      }
    }
    finally {
      this.flushing = false
      if (this.pending.length) { this.scheduleFlush() }
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer || this.flushing) { return }
    const windowMs = Math.min(100, numberVar(this.env.UPSTREAM_BATCH_WINDOW_MS, 20))
    const earliestDeadline = Math.min(...this.pending.map(request => request.payload.deadline))
    const delay = Math.max(0, Math.min(windowMs, earliestDeadline - Date.now() - 1))
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined
      this.ctx.waitUntil(this.flush())
    }, delay)
  }

  async fetch(request: Request): Promise<Response> {
    const payload = await request.json<CoordinatorRequest>()
    if (
      !Array.isArray(payload.texts)
      || !payload.texts.length
      || payload.texts.length > MAX_BATCH_ITEMS
      || payload.texts.some(text => typeof text !== 'string' || !text.length)
      || typeof payload.targetLang !== 'string'
      || !payload.targetLang.length
      || (payload.sourceLang !== undefined && typeof payload.sourceLang !== 'string')
      || !Number.isFinite(payload.deadline)
    ) {
      return Response.json({ ok: false, retryAfter: 1, reason: 'invalid_request' } satisfies CoordinatorResult)
    }
    const chars = payload.texts.reduce((sum, text) => sum + unicodeLength(text), 0)
    if (chars > MAX_BATCH_CHARS) {
      return Response.json({ ok: false, retryAfter: 1, reason: 'invalid_request' } satisfies CoordinatorResult)
    }
    const result = await new Promise<CoordinatorResult>((resolve) => {
      this.pending.push({ payload, resolve })
      this.scheduleFlush()
    })
    return Response.json(result)
  }
}
