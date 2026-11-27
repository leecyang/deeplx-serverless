import { getDocument, GlobalWorkerOptions } from './vendor/pdfjs/pdf.min.mjs'

const assets = new URL('./vendor/pdfjs/', import.meta.url)
GlobalWorkerOptions.workerSrc = new URL('pdf.worker.min.mjs', assets).href

export async function extractPdfText(file, maxCharacters) {
  const loadingTask = getDocument({
    data: await file.arrayBuffer(),
    cMapUrl: new URL('cmaps/', assets).href,
    standardFontDataUrl: new URL('standard_fonts/', assets).href,
    useWasm: false,
  })
  try {
    const pdf = await loadingTask.promise
    const pages = []
    let characters = 0

    for (let number = 1; number <= pdf.numPages; number++) {
      const page = await pdf.getPage(number)
      const { items } = await page.getTextContent()
      const text = items.map(item => (item.str ?? '') + (item.hasEOL ? '\n' : '')).join('').trim()
      page.cleanup()
      if (!text) { continue }

      characters += Array.from(text).length + (pages.length ? 2 : 0)
      if (characters > maxCharacters) {
        throw new RangeError('PDF 文字超过 100,000 字符，请拆分后导入。')
      }
      pages.push(text)
    }

    return { text: pages.join('\n\n'), pagesWithText: pages.length, totalPages: pdf.numPages }
  }
  finally {
    await loadingTask.destroy()
  }
}
