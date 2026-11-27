import { cp, mkdir } from 'node:fs/promises'

const source = new URL('./', import.meta.resolve('pdfjs-dist/package.json'))
const target = new URL('../public/vendor/pdfjs/', import.meta.url)

await mkdir(target, { recursive: true })
for (const path of ['build/pdf.min.mjs', 'build/pdf.worker.min.mjs', 'cmaps', 'standard_fonts', 'LICENSE']) {
  await cp(new URL(path, source), new URL(path.split('/').at(-1), target), { recursive: true })
}
