/* eslint-disable style/max-statements-per-line */

export type ResponseType = 'deeplx' | 'official'

export interface TranslateInput {
  texts: string[]
  sourceLang?: string
  targetLang: string
}

export interface Piece {
  textIndex: number
  order: number
  text: string
  translatable: boolean
}

export interface UpstreamTranslation {
  text: string
  detectedSourceLang: string
}

const TARGET_ALIASES: Record<string, string> = {
  'EN': 'en-US',
  'EN-US': 'en-US',
  'EN-GB': 'en-GB',
  'PT': 'pt-BR',
  'PT-BR': 'pt-BR',
  'PT-PT': 'pt-PT',
  'ZH': 'zh-Hans',
  'ZH-CN': 'zh-Hans',
  'ZH-HANS': 'zh-Hans',
  'ZH-TW': 'zh-Hant',
  'ZH-HANT': 'zh-Hant',
}

const SOURCE_ALIASES: Record<string, string> = {
  'ZH': 'zh-Hans',
  'ZH-CN': 'zh-Hans',
  'ZH-TW': 'zh-Hant',
  'ZH-HANS': 'zh-Hans',
  'ZH-HANT': 'zh-Hant',
  'EN': 'en',
  'EN-US': 'en-US',
  'EN-GB': 'en-GB',
  'PT': 'pt',
  'PT-BR': 'pt-BR',
  'PT-PT': 'pt-PT',
}

export function unicodeLength(value: string): number {
  return Array.from(value).length
}

export function normalizeTargetLanguage(value: string): string {
  const upper = value.trim().replace(/_/g, '-').toUpperCase()
  return TARGET_ALIASES[upper] ?? upper.toLowerCase()
}

export function normalizeSourceLanguage(value?: string): string | undefined {
  if (!value || value.toLowerCase() === 'auto') {
    return undefined
  }
  const upper = value.trim().replace(/_/g, '-').toUpperCase()
  return SOURCE_ALIASES[upper] ?? upper.toLowerCase()
}

function hardSplit(value: string, limit: number): string[] {
  const chars = Array.from(value)
  const result: string[] = []
  for (let index = 0; index < chars.length; index += limit) {
    result.push(chars.slice(index, index + limit).join(''))
  }
  return result
}

function safeSplit(value: string, limit: number): string[] {
  if (unicodeLength(value) <= limit) {
    return [value]
  }

  const result: string[] = []
  let remaining = value
  while (unicodeLength(remaining) > limit) {
    const chars = Array.from(remaining)
    const window = chars.slice(0, limit).join('')
    const candidates = [
      window.lastIndexOf('\n\n'),
      window.lastIndexOf('\n'),
      Math.max(window.lastIndexOf('。'), window.lastIndexOf('！'), window.lastIndexOf('？')),
      Math.max(window.lastIndexOf('. '), window.lastIndexOf('! '), window.lastIndexOf('? ')),
      Math.max(window.lastIndexOf(' '), window.lastIndexOf('\t')),
    ]
    const charBoundary = Math.max(...candidates)
    const splitAt = charBoundary > 0 ? Array.from(window.slice(0, charBoundary + 1)).length : limit
    result.push(chars.slice(0, splitAt).join(''))
    remaining = chars.slice(splitAt).join('')
  }
  if (remaining) {
    result.push(remaining)
  }
  return result.flatMap(item => unicodeLength(item) > limit ? hardSplit(item, limit) : [item])
}

export function splitTexts(texts: string[], limit = 1500): Piece[] {
  const pieces: Piece[] = []
  texts.forEach((text, textIndex) => {
    let order = 0
    for (const token of text.split(/(\r?\n+)/u)) {
      if (!token) { continue }
      if (/^\r?\n+$/u.test(token)) {
        pieces.push({ textIndex, order: order++, text: token, translatable: false })
        continue
      }
      for (const part of safeSplit(token, limit)) {
        const leading = part.match(/^\s+/u)?.[0] ?? ''
        const withoutLeading = part.slice(leading.length)
        const trailing = withoutLeading.match(/\s+$/u)?.[0] ?? ''
        const core = withoutLeading.slice(0, withoutLeading.length - trailing.length)
        if (leading) { pieces.push({ textIndex, order: order++, text: leading, translatable: false }) }
        if (core) { pieces.push({ textIndex, order: order++, text: core, translatable: true }) }
        if (trailing) { pieces.push({ textIndex, order: order++, text: trailing, translatable: false }) }
      }
    }
  })
  return pieces
}

export function batchPieces(pieces: Piece[], limit = 1500, maxItems = 50): Piece[][] {
  const batches: Piece[][] = []
  let current: Piece[] = []
  let count = 0
  for (const piece of pieces.filter(item => item.translatable)) {
    const size = unicodeLength(piece.text)
    if (current.length > 0 && (count + size > limit || current.length >= maxItems)) {
      batches.push(current)
      current = []
      count = 0
    }
    current.push(piece)
    count += size
  }
  if (current.length) { batches.push(current) }
  return batches
}

export function buildOneshotBody(
  texts: string[],
  targetLang: string,
  sourceLang: string | undefined,
  instanceId: string,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    text: texts,
    target_lang: normalizeTargetLanguage(targetLang),
  }
  const normalizedSource = normalizeSourceLanguage(sourceLang)
  if (normalizedSource) { body.source_lang = normalizedSource }
  body.usage_type = 'Translate'
  body.app_information = {
    os: 'brex_macOS',
    os_version: 'brex_chrome_120.0.0.0',
    app_version: '1.86.0',
    app_build: 'chrome_web_store',
    instance_id: instanceId,
  }
  return body
}

export function parseOneshotResponse(value: unknown, expected: number): UpstreamTranslation[] | null {
  if (!value || typeof value !== 'object') { return null }
  const root = value as Record<string, unknown>
  const raw = Array.isArray(root.translations)
    ? root.translations
    : Array.isArray(root.texts)
      ? root.texts
      : null
  if (!raw || raw.length !== expected) { return null }
  const translations: UpstreamTranslation[] = []
  for (const item of raw) {
    if (typeof item === 'string') {
      translations.push({ text: item, detectedSourceLang: '' })
      continue
    }
    if (!item || typeof item !== 'object') { return null }
    const record = item as Record<string, unknown>
    const text = record.text ?? record.translation
    if (typeof text !== 'string') { return null }
    const detected = record.detected_source_language ?? record.detected_source_lang ?? root.detected_source_language
    translations.push({ text, detectedSourceLang: typeof detected === 'string' ? detected.toUpperCase() : '' })
  }
  return translations
}
