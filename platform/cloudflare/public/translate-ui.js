const MAX_CHARACTERS = 3000
const MAX_PDF_CHARACTERS = 100000
const MAX_PDF_BYTES = 20 * 1024 * 1024
const MAX_JOB_BYTES = 512 * 1024
const languages = new Map([
  ['ZH', '简体中文'], ['ZH-HANT', '繁體中文'], ['EN', '英语'], ['JA', '日语'],
  ['KO', '韩语'], ['FR', '法语'], ['DE', '德语'], ['ES', '西班牙语'],
  ['IT', '意大利语'], ['PT', '葡萄牙语'], ['RU', '俄语'], ['AR', '阿拉伯语'],
])

const form = document.querySelector('#translator')
const source = document.querySelector('#source')
const sourceLanguage = document.querySelector('#source-language')
const targetLanguage = document.querySelector('#target-language')
const translation = document.querySelector('#translation')
const detected = document.querySelector('#detected')
const count = document.querySelector('#count')
const clear = document.querySelector('#clear')
const copy = document.querySelector('#copy')
const submit = document.querySelector('#submit')
const status = document.querySelector('#status')
const auth = document.querySelector('#auth')
const token = document.querySelector('#token')
const importPdf = document.querySelector('#import-pdf')
const pdfFile = document.querySelector('#pdf-file')
const pdfName = document.querySelector('#pdf-name')

for (const [code, label] of languages) {
  sourceLanguage.add(new Option(label, code))
  targetLanguage.add(new Option(label, code))
}

function showStatus(message, error = false) {
  status.textContent = message
  status.classList.toggle('error', error)
}

let pending = false
let pdfLoaded = false
let sourceLength = 0

function setPending(active) {
  pending = active
  source.readOnly = active
  sourceLanguage.disabled = active
  targetLanguage.disabled = active
  importPdf.disabled = active
  syncControls()
}

function syncControls() {
  sourceLength = Array.from(source.value).length
  const limit = pdfLoaded ? MAX_PDF_CHARACTERS : MAX_CHARACTERS
  const tooLong = sourceLength > limit
  count.textContent = `${sourceLength} / ${limit}`
  count.classList.toggle('invalid', tooLong)
  if (tooLong) { source.setAttribute('aria-invalid', 'true') }
  else { source.removeAttribute('aria-invalid') }
  submit.disabled = pending || tooLong || !source.value.trim()
  clear.disabled = pending || (!sourceLength && !pdfLoaded)
  copy.disabled = pending || !translation.value
}

function clearResult() {
  translation.value = ''
  detected.textContent = ''
}

function updateInput() {
  clearResult()
  showStatus('')
  syncControls()
}

source.addEventListener('input', updateInput)
sourceLanguage.addEventListener('change', updateInput)
targetLanguage.addEventListener('change', updateInput)
clear.addEventListener('click', () => {
  source.value = ''
  pdfLoaded = false
  pdfName.textContent = ''
  updateInput()
  source.focus()
})

importPdf.addEventListener('click', () => pdfFile.click())
pdfFile.addEventListener('change', async () => {
  const [file] = pdfFile.files
  pdfFile.value = ''
  if (!file || pending) { return }
  if (file.size > MAX_PDF_BYTES) {
    showStatus('请选择 20 MB 以内的 PDF。', true)
    return
  }

  setPending(true)
  showStatus('正在读取 PDF…')
  try {
    const { extractPdfText } = await import('./pdf-text.js')
    const { text, pagesWithText, totalPages } = await extractPdfText(file, MAX_PDF_CHARACTERS)
    if (!text) {
      showStatus('这个 PDF 没有可提取的文字。扫描件需要先做 OCR。', true)
      return
    }

    pdfLoaded = true
    source.value = text
    pdfName.textContent = file.name
    clearResult()
    showStatus(pagesWithText === totalPages
      ? `已读取 ${totalPages} 页，点击翻译开始。`
      : `已读取 ${pagesWithText} / ${totalPages} 页，其余页面没有可提取的文字。`)
  }
  catch (error) {
    const message = error.name === 'PasswordException'
      ? '请先解除 PDF 的密码保护再导入。'
      : '无法读取 PDF，请检查文件后重试。'
    showStatus(error instanceof RangeError ? error.message : message, true)
  }
  finally {
    setPending(false)
  }
})

copy.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(translation.value)
    showStatus('已复制译文')
  }
  catch {
    translation.select()
    showStatus('请使用系统快捷键复制已选中的译文。', true)
  }
})

function errorMessage(code) {
  if (code === 401 || code === 403) {
    auth.hidden = false
    token.focus()
    return '请输入有效的 API 密钥后重试。'
  }
  if (code === 429 || code === 503) {
    return '翻译服务暂时繁忙，请稍后重试。'
  }
  return '翻译失败，请检查原文和语言后重试。'
}

async function requestJson(path, options, signal) {
  const response = await fetch(path, { ...options, signal })
  const data = await response.json().catch(() => null)
  return { data, status: response.status, ok: response.ok }
}

async function translateDocument(headers, body) {
  const signal = AbortSignal.timeout(75000)
  const job = await requestJson('/jobs', { method: 'POST', headers, body }, signal)
  if (!job.ok) { return job }
  const id = job.data?.job_id
  if (job.status !== 202 || typeof id !== 'string' || !/^[a-f0-9-]{36}$/i.test(id)) {
    return { ok: false, status: 502 }
  }

  const path = `/jobs/${id}`
  for (let attempt = 0; attempt < 74; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 1000))
    const poll = await requestJson(path, { headers, cache: 'no-store' }, signal)
    if (!poll.ok) { return poll }
    if (poll.data?.status === 'succeeded') { return { ...poll, data: poll.data.result } }
    if (!['pending', 'processing'].includes(poll.data?.status)) {
      return { ok: false, status: 502 }
    }
  }
  return { ok: false, status: 503 }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault()
  if (submit.disabled) { return }

  const body = { text: source.value, target_lang: targetLanguage.value }
  if (sourceLanguage.value) { body.source_lang = sourceLanguage.value }
  const headers = new Headers({ 'Content-Type': 'application/json' })
  if (token.value.trim()) { headers.set('Authorization', `Bearer ${token.value.trim()}`) }

  const payload = JSON.stringify(body)
  const useJob = sourceLength > MAX_CHARACTERS
  if (useJob && new TextEncoder().encode(payload).byteLength > MAX_JOB_BYTES) {
    showStatus('文字数据超过 512 KB，请分批翻译。', true)
    return
  }

  clearResult()
  setPending(true)
  showStatus(useJob ? '正在翻译文档，最长约需一分钟…' : '正在翻译…')

  try {
    const response = useJob
      ? await translateDocument(headers, payload)
      : await requestJson('/translate', { method: 'POST', headers, body: payload }, AbortSignal.timeout(20000))
    const result = response.data
    if (!response.ok || result?.code !== 200 || typeof result.data !== 'string') {
      showStatus(errorMessage(response.ok ? result?.code : response.status), true)
      return
    }
    translation.lang = ({ ZH: 'zh-Hans', 'ZH-HANT': 'zh-Hant' })[body.target_lang]
      ?? body.target_lang.toLowerCase()
    translation.value = result.data
    if (!body.source_lang && result.source_lang) {
      const code = result.source_lang.toUpperCase()
      detected.textContent = `检测到${languages.get(code) ?? code}`
    }
    showStatus('翻译完成')
  }
  catch {
    showStatus('翻译服务连接失败或超时，请重试。', true)
  }
  finally {
    setPending(false)
  }
})

source.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.isComposing) {
    event.preventDefault()
    form.requestSubmit()
  }
})

syncControls()
