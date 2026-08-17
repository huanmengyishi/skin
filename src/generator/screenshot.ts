/**
 * 跨平台无头浏览器截图（视觉验证的"渲染"步）。
 * 浏览器发现：环境变量 DSH_SKIN_CHROME_PATH → Windows 常见路径（Edge/Chrome）→ macOS → Linux。
 * 仅使用 puppeteer-core；vision-router 的 vision_html_screenshot 浏览器探测是 macOS-only，故自建。
 * @module dsh-skin/src/generator/screenshot
 */

import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import type { Page } from 'puppeteer-core'

export function findBrowserPath(): string {
  const fromEnv = process.env.DSH_SKIN_CHROME_PATH
  if (fromEnv !== undefined && existsSync(fromEnv)) return fromEnv
  const candidates = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  throw new Error('未找到 Chrome/Chromium/Edge：请安装或设置 DSH_SKIN_CHROME_PATH')
}

/** 加载 puppeteer-core（宿主运行时依赖，避免顶层导入在无依赖环境炸开）。 */
export async function loadPuppeteer(): Promise<{ launch(options: unknown): Promise<{ newPage(): Promise<Page>; close(): Promise<void> }> }> {
  return import('puppeteer-core') as never
}

/**
 * 对本地 HTML 截图（PNG），并返回渲染样式指纹：
 * 关键元素的计算样式（body/sidebar 背景、overlay 边框、作用域属性）。
 * 像素 diff 在某些无头浏览器组合下对 CSS 变化不敏感，指纹是确定性的第二判据。
 */
export async function screenshotHtml(htmlPath: string, outPath: string, width = 1200, height = 720): Promise<string> {
  const puppeteer = await loadPuppeteer()
  const executablePath = findBrowserPath()
  const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--incognito'],
  }).catch(() => {
    throw new Error('浏览器启动失败：' + executablePath)
  })
  try {
    const page = await browser.newPage()
    await page.setViewport({ width, height })
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'load', timeout: 30000 })
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    await page.screenshot({ path: outPath, type: 'png' })
    return await page.evaluate(() => {
      const styleOf = (selector: string): string | null => {
        const el = document.querySelector(selector)
        return el === null ? null : getComputedStyle(el).backgroundColor + '|' + getComputedStyle(el).borderTopColor
      }
      return JSON.stringify({
        scope: document.body.getAttribute('data-dsh-skin'),
        bodyBg: getComputedStyle(document.body).backgroundColor,
        bodyFont: getComputedStyle(document.body).fontFamily.slice(0, 48),
        sidebar: styleOf('[data-slot="sidebar"]'),
        overlay: styleOf('[data-slot="shell.overlay"] > *'),
      })
    })
  } finally {
    await browser.close()
  }
}


/**
 * 参考图 → 归一化 PNG（Q1 保真度用）：file:// 页面 + CSS object-fit cover + 整页截图。
 * 复用既有 puppeteer 栈；不走 canvas（file:// 图像会污染画布），data: 页面不能加载 file:// 子资源，
 * 因此与 screenshotHtml 同模式：临时 file 页面引用图片后截图。
 */
export async function renderImageToPng(inputPath: string, outPath: string, width = 1200, height = 720): Promise<void> {
  const { writeFileSync } = await import('node:fs')
  const { dirname, join } = await import('node:path')
  const puppeteer = await loadPuppeteer()
  const executablePath = findBrowserPath()
  const htmlPath = join(dirname(outPath), '.reference-view.html')
  const url = pathToFileURL(inputPath).href
  writeFileSync(htmlPath, '<html><head><style>html,body{margin:0;padding:0;overflow:hidden;background:#000}img{display:block;width:' + width + 'px;height:' + height + 'px;object-fit:cover}</style></head><body><img id="src" src="' + url + '"></body></html>')
  const browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox', '--disable-gpu'] })
  try {
    const page = await browser.newPage()
    await page.setViewport({ width, height })
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'load', timeout: 30000 })
    await page.waitForFunction(() => {
      const img = document.getElementById('src') as HTMLImageElement | null
      return img !== null && img.complete && img.naturalWidth > 0
    }, { timeout: 30000 })
    await page.screenshot({ path: outPath, type: 'png' })
  } finally {
    await browser.close()
    try { const { rmSync } = await import('node:fs'); rmSync(htmlPath, { force: true }) } catch { /* 清理失败无碍 */ }
  }
}
