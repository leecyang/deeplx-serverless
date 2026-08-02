import { describe, expect, it } from 'vitest'
import {
  batchPieces,
  buildOneshotBody,
  normalizeSourceLanguage,
  normalizeTargetLanguage,
  parseOneshotResponse,
  splitTexts,
  unicodeLength,
} from '../src/protocol'

describe('oneshot protocol', () => {
  it('counts Unicode code points rather than UTF-16 units', () => {
    expect(unicodeLength('A😀中')).toBe(3)
  })

  it('uses DLX field order and extension metadata', () => {
    const body = buildOneshotBody(['hello'], 'EN', 'ZH', 'stable-id')
    expect(Object.keys(body)).toEqual([
      'text',
      'target_lang',
      'source_lang',
      'usage_type',
      'app_information',
    ])
    expect(body).toEqual({
      text: ['hello'],
      target_lang: 'en-US',
      source_lang: 'zh-Hans',
      usage_type: 'Translate',
      app_information: {
        os: 'brex_macOS',
        os_version: 'brex_chrome_120.0.0.0',
        app_version: '1.86.0',
        app_build: 'chrome_web_store',
        instance_id: 'stable-id',
      },
    })
  })

  it('maps regional language aliases', () => {
    expect(normalizeTargetLanguage('zh_TW')).toBe('zh-Hant')
    expect(normalizeTargetLanguage('pt')).toBe('pt-BR')
    expect(normalizeSourceLanguage('EN-GB')).toBe('en-GB')
    expect(normalizeSourceLanguage('auto')).toBeUndefined()
  })

  it('splits and batches without exceeding 1500 code points', () => {
    const pieces = splitTexts([`${'😀'.repeat(1499)} ${'中'.repeat(1501)}`])
    const batches = batchPieces(pieces)
    expect(batches.length).toBe(3)
    for (const batch of batches) {
      expect(batch.reduce((sum, piece) => sum + unicodeLength(piece.text), 0)).toBeLessThanOrEqual(1500)
    }
    expect(pieces.map(piece => piece.text).join('')).toBe(`${'😀'.repeat(1499)} ${'中'.repeat(1501)}`)
  })

  it('keeps ordinary sentences together for translation context', () => {
    const pieces = splitTexts(['One shot verification keeps context.\nSecond line.'])
    expect(pieces).toEqual([
      {
        textIndex: 0,
        order: 0,
        text: 'One shot verification keeps context.',
        translatable: true,
      },
      { textIndex: 0, order: 1, text: '\n', translatable: false },
      { textIndex: 0, order: 2, text: 'Second line.', translatable: true },
    ])
  })

  it('validates translation array length', () => {
    expect(parseOneshotResponse({
      translations: [{ text: '你好', detected_source_language: 'EN' }],
    }, 1)).toEqual([{ text: '你好', detectedSourceLang: 'EN' }])
    expect(parseOneshotResponse({ translations: [] }, 1)).toBeNull()
  })
})
