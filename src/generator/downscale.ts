/**
 * 视觉输入像素预算（Q5）：超预算时保持纵横比降采样（cover 不变形），不无条件缩小正常图片；
 * 复用既有 puppeteer 栈（file 页读取自然尺寸 + object-fit 截图），不新增依赖。
 * @module dsh-skin/src/generator/downscale
 */

import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { findBrowserPath, loadPuppeteer } from './screenshot.ts'

export const DEFAULT_PIXEL_BUDGET = 4_000_000

export interface DownscaleMeta {
  original: { width: number; height: number }
  processed: { width: number; height: number }
  pixelBudget: number
  downscaled: boolean
  path: string
}

/** 纯函数：预算内原样；超预算按 sqrt 比例缩放（保持纵横比）。 */
export function computeTargetDims(width: number, height: number, budget: number): { width: number; height: number; downscaled: boolean } {
  if (width * height <= budget) return { width, height, downscaled: false }
  const scale = Math.sqrt(budget / (width * height))
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), downscaled: true }
}

/** 归一化：读自然尺寸 → 超预算则输出缩样 PNG；否则原路径直通。元数据始终返回。 */
export async function normalizeImageForVision(inputPath: string, outPath: string, budget: number = DEFAULT_PIXEL_BUDGET): Promise<DownscaleMeta> {
  const puppeteer = await loadPuppeteer()
  const executablePath = findBrowserPath()
  const browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox', '--disable-gpu'] })
  try {
    const page = await browser.newPage()
    const htmlPath = outPath.replace(/\.png$/, '.dims.html')
    const { writeFileSync, rmSync } = await import('node:fs')
    writeFileSync(htmlPath, '<html><body><img id="src" src="' + pathToFileURL(inputPath).href + '"></body></html>')
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'load', timeout: 30000 })
    const dims = await page.waitForFunction(() => {
      const img = document.getElementById('src') as HTMLImageElement | null
      return img !== null && img.complete && img.naturalWidth > 0 ? { width: img.naturalWidth, height: img.naturalHeight } : null
    }, { timeout: 30000 })
    const natural = (await dims.jsonValue()) as { width: number; height: number } | null
    rmSync(htmlPath, { force: true })
    if (natural === null) throw new Error('无法读取图片自然尺寸（INVALID_INPUT）')
    const target = computeTargetDims(natural.width, natural.height, budget)
    if (!target.downscaled) {
      return { original: natural, processed: { width: natural.width, height: natural.height }, pixelBudget: budget, downscaled: false, path: inputPath }
    }
    await page.setViewport({ width: target.width, height: target.height })
    const html2 = outPath.replace(/\.png$/, '.view.html')
    writeFileSync(html2, '<html><head><style>html,body{margin:0;overflow:hidden;background:#000}img{display:block;width:' + target.width + 'px;height:' + target.height + 'px;object-fit:cover}</style></head><body><img id="src" src="' + pathToFileURL(inputPath).href + '"></body></html>')
    await page.goto(pathToFileURL(html2).href, { waitUntil: 'load', timeout: 30000 })
    await page.waitForFunction(() => {
      const img = document.getElementById('src') as HTMLImageElement | null
      return img !== null && img.complete && img.naturalWidth > 0
    }, { timeout: 30000 })
    await page.screenshot({ path: outPath, type: 'png' })
    rmSync(html2, { force: true })
    return { original: natural, processed: { width: target.width, height: target.height }, pixelBudget: budget, downscaled: true, path: outPath }
  } finally {
    await browser.close()
  }
}

