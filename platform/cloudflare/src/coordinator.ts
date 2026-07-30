/* eslint-disable style/max-statements-per-line */

import { DurableObject } from 'cloudflare:workers'
import { buildOneshotBody, parseOneshotResponse } from './protocol'

interface CoordinatorRequest {
  texts: string[]
  sourceLang?: string
  targetLang: string
  deadline: number
}

type CoordinatorResult =
  | { ok: true, translations: Array<{ text: string, detectedSourceLang: string }> }
  | { ok: false, retryAfter: number, reason: string }

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

  private async state(): Promise<CoordinatorState> {
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
  }

  private async warmCookies(state: CoordinatorState, deadline: number): Promise<void> {
    if (state.cookies || Date.now() >= deadline) { return }
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
        await this.ctx.storage.put('state', state)
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

  async fetch(request: Request): Promise<Response> {
    const payload = await request.json<CoordinatorRequest>()
    const state = await this.state()
    const now = Date.now()
    if (now < state.circuitUntil) {
      return Response.json({ ok: false, retryAfter: Math.ceil((state.circuitUntil - now) / 1000), reason: 'circuit_open' } satisfies CoordinatorResult)
    }
    if (state.halfOpen && now >= state.circuitUntil) { state.circuitUntil = 0 }
    const wait = await this.acquire(state, payload.deadline)
    if (wait > 0) {
      return Response.json({ ok: false, retryAfter: wait, reason: 'overloaded' } satisfies CoordinatorResult)
    }

    await this.warmCookies(state, payload.deadline)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), Math.max(1, payload.deadline - Date.now()))
    try {
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
        body: JSON.stringify(buildOneshotBody(payload.texts, payload.targetLang, payload.sourceLang, state.instanceId)),
        signal: controller.signal,
      })
      if (response.status === 429) {
        const fallback = Math.min(300, 30 * (2 ** Math.min(state.failures, 3)))
        const seconds = retrySeconds(response, fallback)
        await this.openCircuit(state, seconds)
        return Response.json({ ok: false, retryAfter: seconds, reason: 'upstream_429' } satisfies CoordinatorResult)
      }
      if (response.status >= 500) {
        await this.openCircuit(state, 10)
        return Response.json({ ok: false, retryAfter: 10, reason: 'upstream_5xx' } satisfies CoordinatorResult)
      }
      if (!response.ok) {
        await this.openCircuit(state, 5)
        return Response.json({ ok: false, retryAfter: 5, reason: 'upstream_error' } satisfies CoordinatorResult)
      }
      let responseBody: unknown
      try {
        responseBody = await response.json()
      }
      catch {
        await this.openCircuit(state, 10)
        return Response.json({ ok: false, retryAfter: 10, reason: 'invalid_json' } satisfies CoordinatorResult)
      }
      const parsed = parseOneshotResponse(responseBody, payload.texts.length)
      if (!parsed) {
        await this.openCircuit(state, 10)
        return Response.json({ ok: false, retryAfter: 10, reason: 'invalid_json' } satisfies CoordinatorResult)
      }
      state.failures = 0
      state.halfOpen = false
      state.circuitUntil = 0
      await this.ctx.storage.put('state', state)
      return Response.json({ ok: true, translations: parsed } satisfies CoordinatorResult)
    }
    catch {
      await this.openCircuit(state, 10)
      return Response.json({ ok: false, retryAfter: 10, reason: 'timeout' } satisfies CoordinatorResult)
    }
    finally {
      clearTimeout(timer)
      this.active = Math.max(0, this.active - 1)
    }
  }
}
