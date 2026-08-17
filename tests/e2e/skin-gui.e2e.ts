import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type Page } from 'playwright'

const BASE = 'http://127.0.0.1:3099'

let browser: Browser
let page: Page

async function bootPage(): Promise<Page> {
  const p = await browser.newPage({ viewport: { width: 1600, height: 950 } })
  const errors: string[] = []
  p.on('pageerror', e => errors.push(String(e).slice(0, 160)))
  await p.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await p.waitForTimeout(7000)
  // 启动完成后错误面不应出现
  const bodyText = await p.evaluate(() => document.body.innerText)
  expect(bodyText).not.toContain('Failed to load plugins')
  return p
}

async function dismissOverlays(): Promise<void> {
  // 内测声明/欢迎浮层与新会话遮罩
  const continueButton = page.getByRole('button', { name: /继续|Continue|知道了|Got it/i }).first()
  if ((await continueButton.count()) > 0) {
    await continueButton.click({ force: true }).catch(() => undefined)
    await page.waitForTimeout(500)
  }
  await page.keyboard.press('Escape')
  await page.waitForTimeout(400)
}

async function openSkinCard(): Promise<void> {
  // 关闭欢迎浮层，再打开侧栏底部设置
  await dismissOverlays()
  const settingsButton = () => page.locator('[data-slot="sidebar.settings"] button').first()
  // 未接工作区的首启会保留工作区选择遮罩：E2E 用 force 点击穿透无关产品浮层
  await settingsButton().click({ force: true })
  await page.waitForTimeout(800)
  // 新 profile 的设置为 onboarding 流程：跳过 API Key 引导后需重开设置进入常规视图
  const skip = page.getByRole('button', { name: /稍后配置|Skip|Later/i }).first()
  if ((await skip.count()) > 0) {
    await skip.click({ force: true }).catch(() => undefined)
    await page.waitForTimeout(800)
    await settingsButton().click({ force: true })
    await page.waitForTimeout(800)
  }
  // 皮肤卡在设置「插件」区
  if ((await page.locator('[data-testid^="dsh-skin-card-"]').count()) === 0) {
    await page.getByRole('button', { name: '插件' }).first().click({ force: true }).catch(() => undefined)
    await page.waitForTimeout(800)
  }
}

function skinAttr(): Promise<string | null> {
  return page.evaluate(() => document.body.getAttribute('data-dsh-skin'))
}

/** 等待按钮可用（持久化 loading 期间按钮会短暂 disabled），再 force 点击。 */
async function clickAction(testid: string): Promise<void> {
  const locator = page.locator('[data-testid="' + testid + '"]')
  await page.waitForFunction(
    tid => {
      const el = document.querySelector('[data-testid="' + tid + '"]')
      return el !== null && !(el as HTMLButtonElement).disabled
    },
    testid,
    { timeout: 20_000 },
  )
  await locator.click({ force: true })
}

describe('dsh-skin 真实 GUI 闭环', () => {
  beforeAll(async () => {
    browser = await chromium.launch({ channel: 'msedge', headless: true })
  })

  afterAll(async () => {
    await browser?.close()
  })

  it('E2E-1：插件进入 roster 并物化，皮肤注册表可见', async () => {
    page = await bootPage()
    const boot = await page.evaluate(() => {
      const win = window as unknown as {
        __DSH_BOOT__?: { entries?: { id: string }[] }
        __DSH_MODULES__?: { loadCache: Map<string, unknown> }
      }
      return {
        inRoster: win.__DSH_BOOT__?.entries?.some(e => e.id === 'dsh-skin') ?? false,
        materialized: win.__DSH_MODULES__ !== undefined && Array.from(win.__DSH_MODULES__.loadCache.keys()).includes('dsh-skin'),
      }
    })
    expect(boot.inRoster).toBe(true)
    expect(boot.materialized).toBe(true)
    const skins = await (await fetch(BASE + '/dsh-skin/api/skins')).json() as { skins: { id: string; state: string }[] }
    expect(skins.skins.map(s => s.id).sort()).toEqual(['clean', 'terminal'])
    expect(skins.skins.every(s => s.state === 'ok')).toBe(true)
    await page.close()
  })

  it('E2E-2：发现内置皮肤 → Try-on → 退出完整恢复', async () => {
    page = await bootPage()
    await openSkinCard()
    expect(await page.locator('[data-testid="dsh-skin-card-clean"]').count()).toBe(1)
    expect(await page.locator('[data-testid="dsh-skin-card-terminal"]').count()).toBe(1)
    const before = await skinAttr()
    // 选择 terminal 卡片展开详情，再试穿
    await page.locator('[data-testid="dsh-skin-card-terminal"]').click({ force: true })
    await page.waitForTimeout(400)
    await clickAction('dsh-skin-action-terminal-tryon')
    await page.waitForFunction(() => document.body.getAttribute('data-dsh-skin') === 'terminal', undefined, { timeout: 15_000 })
    expect(await page.locator('[data-skin-chrome="terminal-statusbar"]').count()).toBe(1)
    // 退出试穿：恢复先前状态（试穿不落盘由 E2E-3 的 settings.yaml 内容反证）
    await clickAction('dsh-skin-action-exit-tryon')
    await page.waitForFunction(prev => document.body.getAttribute('data-dsh-skin') === prev, before, { timeout: 15_000 })
    expect(await page.locator('[data-skin-chrome="terminal-statusbar"]').count()).toBe(0)
    await page.close()
  })

  it('E2E-3：Apply → 刷新保持 → 切换 → 恢复默认，且无残留', async () => {
    page = await bootPage()
    await openSkinCard()
    // 选择 terminal 卡片展开详情，再 Apply
    await page.locator('[data-testid="dsh-skin-card-terminal"]').click({ force: true })
    await page.waitForTimeout(400)
    await clickAction('dsh-skin-action-terminal-apply')
    await page.waitForFunction(() => document.body.getAttribute('data-dsh-skin') === 'terminal', undefined, { timeout: 15_000 })
    // 刷新后 bootstrap 恢复
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(7000)
    await page.waitForFunction(() => document.body.getAttribute('data-dsh-skin') === 'terminal', undefined, { timeout: 20_000 })
    // 持久化落盘（settings.yaml）
    const fs = await import('node:fs')
    const path = await import('node:path')
    const settingsText = fs.readFileSync(path.resolve('.dev-home', 'settings.yaml'), 'utf8')
    expect(settingsText).toContain('terminal')
    // 切换 clean
    await openSkinCard()
    await page.locator('[data-testid="dsh-skin-card-clean"]').click({ force: true })
    await page.waitForTimeout(400)
    await clickAction('dsh-skin-action-clean-apply')
    await page.waitForFunction(() => document.body.getAttribute('data-dsh-skin') === 'clean', undefined, { timeout: 15_000 })
    // 恢复默认：作用域属性消失、无任何皮肤残留
    await clickAction('dsh-skin-action-restore-default')
    await page.waitForFunction(() => document.body.getAttribute('data-dsh-skin') === null, undefined, { timeout: 15_000 })
    const leak = await page.evaluate(() => ({
      owners: document.querySelectorAll('[data-dsh-skin-owner]').length,
      chrome: document.querySelectorAll('[data-skin-chrome]').length,
      pluginStyles: document.querySelectorAll('style[data-plugin^="dsh-skin/"]').length,
    }))
    expect(leak).toEqual({ owners: 0, chrome: 0, pluginStyles: 0 })
    // 宿主功能未受影响：设置面板仍可用
    expect(await page.locator('[data-slot="settings.trigger"]').count()).toBeGreaterThan(0)
    await page.close()
  })

  it('E2E-4：Skin Center 搜索/标签/来源/排序/详情预览 + 安装与卸载', async () => {
    page = await bootPage()
    await openSkinCard()
    // 搜索过滤
    await page.locator('[data-testid="dsh-skin-search"]').fill('phosphor')
    await page.waitForTimeout(300)
    expect(await page.locator('[data-testid^="dsh-skin-card-"]').count()).toBe(1)
    expect(await page.locator('[data-testid="dsh-skin-card-terminal"]').count()).toBe(1)
    await page.locator('[data-testid="dsh-skin-search"]').fill('')
    await page.waitForTimeout(300)
    // 标签过滤（AND）
    await page.locator('[data-testid="dsh-skin-tag-retro"]').click({ force: true })
    await page.waitForTimeout(300)
    expect(await page.locator('[data-testid^="dsh-skin-card-"]').count()).toBe(1)
    expect(await page.locator('[data-testid="dsh-skin-card-terminal"]').count()).toBe(1)
    await page.locator('[data-testid="dsh-skin-tag-retro"]').click({ force: true })
    await page.waitForTimeout(300)
    // 来源过滤：本地（无）→ 内置
    await page.locator('[data-testid="dsh-skin-source-installed"]').click({ force: true })
    await page.waitForTimeout(300)
    expect(await page.locator('[data-testid^="dsh-skin-card-"]').count()).toBe(0)
    await page.locator('[data-testid="dsh-skin-source-installed"]').click({ force: true })
    await page.waitForTimeout(300)
    expect(await page.locator('[data-testid^="dsh-skin-card-"]').count()).toBe(2)
    // 排序：按版本 → clean(1.0.0) 在 terminal(0.1.0) 前
    await page.locator('[data-testid="dsh-skin-sort"]').selectOption('version')
    await page.waitForTimeout(300)
    const firstId = await page.locator('[data-testid^="dsh-skin-card-"]').first().getAttribute('data-testid')
    expect(firstId).toBe('dsh-skin-card-clean')
    // 详情 + 预览图
    await page.locator('[data-testid="dsh-skin-card-terminal"]').click({ force: true })
    await page.waitForTimeout(400)
    const detail = page.locator('[data-testid="dsh-skin-detail-terminal"]')
    expect(await detail.count()).toBe(1)
    expect(await detail.locator('img').count()).toBeGreaterThan(0)
    // 安装一个本地皮肤（经 host API），刷新后可见并可卸载
    const fs = await import('node:fs')
    const os = await import('node:os')
    const path = await import('node:path')
    const fixtureDir = path.join(os.tmpdir(), 'dsh-skin-e2e-fixture')
    fs.rmSync(fixtureDir, { recursive: true, force: true })
    fs.mkdirSync(path.join(fixtureDir, 'theme'), { recursive: true })
    fs.mkdirSync(path.join(fixtureDir, 'styles'), { recursive: true })
    fs.mkdirSync(path.join(fixtureDir, 'client'), { recursive: true })
    fs.writeFileSync(path.join(fixtureDir, 'manifest.json'), JSON.stringify({ id: 'local-demo', version: '0.9.0', name: 'Local Demo', author: 'e2e', description: 'E2E 安装演示皮肤', tags: ['e2e'], skinApiVersion: 1, preview: {} }))
    fs.writeFileSync(path.join(fixtureDir, 'theme', 'light.json'), '{}')
    fs.writeFileSync(path.join(fixtureDir, 'theme', 'dark.json'), '{}')
    fs.writeFileSync(path.join(fixtureDir, 'styles', 'theme.css'), 'body[data-dsh-skin="local-demo"]{}')
    fs.writeFileSync(path.join(fixtureDir, 'client', 'index.js'), 'window.__ModuleLoader__.load({ id: "dsh-skin/local-demo", factory: function () { return { apply: function () {} }; } });')
    const installResponse = await fetch(BASE + '/dsh-skin/api/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceDir: fixtureDir }),
    })
    expect(installResponse.status).toBe(200)
    await page.locator('[data-testid="dsh-skin-refresh"]').click({ force: true })
    await page.waitForTimeout(600)
    expect(await page.locator('[data-testid="dsh-skin-card-local-demo"]').count()).toBe(1)
    // 详情卸载
    await page.locator('[data-testid="dsh-skin-card-local-demo"]').click({ force: true })
    await page.waitForTimeout(400)
    await clickAction('dsh-skin-action-local-demo-uninstall')
    await page.waitForTimeout(800)
    expect(await page.locator('[data-testid="dsh-skin-card-local-demo"]').count()).toBe(0)
    const list = await (await fetch(BASE + '/dsh-skin/api/skins')).json() as { skins: { id: string }[] }
    expect(list.skins.some(skin => skin.id === 'local-demo')).toBe(false)
    fs.rmSync(fixtureDir, { recursive: true, force: true })
    await page.close()
  })

  it('E2E-5：从图片生成（fixture 视觉链）→ 迭代工件 → 安装 → 试穿/卸载', async () => {
    page = await bootPage()
    await openSkinCard()
    // 上传一张真实小 PNG（fixture 模式下不依赖真实视觉 API）
    const os = await import('node:os')
    const path = await import('node:path')
    const pngjs = await import('pngjs') as { PNG: { sync: { write(png: unknown): Buffer } } }
    const { PNG } = await import('pngjs') as { PNG: new (options: { width: number; height: number }) => { data: Buffer } }
    const canvas = new PNG({ width: 64, height: 64 })
    for (let i = 0; i < canvas.data.length; i += 4) {
      canvas.data[i] = 11; canvas.data[i + 1] = 18; canvas.data[i + 2] = 11; canvas.data[i + 3] = 255
    }
    const pngPath = path.join(os.tmpdir(), 'dsh-skin-e2e-ref.png')
    const nodeFsModule = await import('node:fs')
    nodeFsModule.writeFileSync(pngPath, pngjs.PNG.sync.write(canvas))
    await page.locator('[data-testid="dsh-skin-gen-file"]').setInputFiles(pngPath)
    await page.locator('[data-testid="dsh-skin-gen-name"]').fill('Fixture Glow')
    await page.locator('[data-testid="dsh-skin-gen-description"]').fill('E2E fixture 生成')
    await clickAction('dsh-skin-gen-submit')
    // 生成含 3 次真实无头截图（跨平台浏览器发现），需等待
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-testid="dsh-skin-gen-result"]')
      return el !== null && /已生成并安装/.test(el.textContent ?? '')
    }, undefined, { timeout: 180_000 })
    await clickAction('dsh-skin-refresh')
    await page.waitForTimeout(500)
    const card = page.locator('[data-testid="dsh-skin-card-fixture-glow"]')
    expect(await card.count()).toBe(1)
    // 工件落盘（generation/<run>/：input/analysis/design-spec/iteration-N/final/report）
    const fs = await import('node:fs')
    const generationRoot = path.resolve('.dev-home', 'skins', 'cache', 'generation')
    const runs = fs.readdirSync(generationRoot, { withFileTypes: true }).filter(entry => entry.isDirectory() && entry.name.startsWith('gen-')).map(entry => entry.name).sort()
    expect(runs.length).toBeGreaterThan(0)
    const lastRun = runs[runs.length - 1]
    expect(fs.existsSync(path.join(generationRoot, lastRun, 'input.png'))).toBe(true)
    expect(fs.existsSync(path.join(generationRoot, lastRun, 'analysis.json'))).toBe(true)
    expect(fs.existsSync(path.join(generationRoot, lastRun, 'design-spec.json'))).toBe(true)
    // v1.4 语义：iteration-0 五维达标 → NO_REPAIR_NEEDED 收敛（仅 iteration-0）；否则至少存在修复轮 iteration-1
    const runReport = JSON.parse(fs.readFileSync(path.join(generationRoot, lastRun, 'report.json'), 'utf8'))
    if (runReport.loopStatus === 'CONVERGED' && runReport.stopReason === 'NO_REPAIR_NEEDED') {
      expect(fs.existsSync(path.join(generationRoot, lastRun, 'iteration-0', 'screenshot.png'))).toBe(true)
    } else {
      expect(fs.existsSync(path.join(generationRoot, lastRun, 'iteration-1', 'screenshot.png'))).toBe(true)
    }
    expect(fs.existsSync(path.join(generationRoot, lastRun, 'final', 'integrity.json'))).toBe(true)
    expect(fs.existsSync(path.join(generationRoot, lastRun, 'report.json'))).toBe(true)
    // 试穿 → 退出 → 卸载（同一 Runtime，与普通皮肤无差别）
    await card.click({ force: true })
    await page.waitForTimeout(400)
    await clickAction('dsh-skin-action-fixture-glow-tryon')
    await page.waitForFunction(() => document.body.getAttribute('data-dsh-skin') === 'fixture-glow', undefined, { timeout: 20_000 })
    await clickAction('dsh-skin-action-exit-tryon')
    await page.waitForFunction(() => document.body.getAttribute('data-dsh-skin') !== 'fixture-glow', undefined, { timeout: 20_000 })
    await clickAction('dsh-skin-action-fixture-glow-uninstall')
    await page.waitForTimeout(800)
    expect(await page.locator('[data-testid="dsh-skin-card-fixture-glow"]').count()).toBe(0)
    await page.close()
  }, 300_000)

  it('E2E-6：生成皮肤生命周期（编辑 metadata/导出 zip/重新生成/卸载）', async () => {
    page = await bootPage()
    await openSkinCard()
    const os = await import('node:os')
    const path = await import('node:path')
    const pngjs = await import('pngjs') as { PNG: (new (options: { width: number; height: number }) => { data: Buffer }) & { sync: { write(png: unknown): Buffer } } }
    const { PNG } = pngjs
    const canvas = new PNG({ width: 64, height: 64 })
    for (let i = 0; i < canvas.data.length; i += 4) {
      canvas.data[i] = 11; canvas.data[i + 1] = 18; canvas.data[i + 2] = 11; canvas.data[i + 3] = 255
    }
    const pngPath = path.join(os.tmpdir(), 'dsh-skin-e2e-ref.png')
    const nodeFsModule = await import('node:fs')
    nodeFsModule.writeFileSync(pngPath, pngjs.PNG.sync.write(canvas))
    await page.locator('[data-testid="dsh-skin-gen-file"]').setInputFiles(pngPath)
    await page.locator('[data-testid="dsh-skin-gen-name"]').fill('Lifecycle Skin')
    await clickAction('dsh-skin-gen-submit')
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-testid="dsh-skin-gen-result"]')
      return el !== null && /已生成并安装/.test(el.textContent ?? '')
    }, undefined, { timeout: 300_000 })
    await clickAction('dsh-skin-refresh')
    await page.waitForTimeout(500)
    const card = page.locator('[data-testid="dsh-skin-card-lifecycle-skin"]')
    expect(await card.count()).toBe(1)
    // 详情：编辑信息（改名）→ 保存 → 列表刷新反映新名
    await card.click({ force: true })
    await page.waitForTimeout(400)
    await page.locator('[data-testid="dsh-skin-edit-open"]').click({ force: true })
    await page.waitForTimeout(300)
    await page.locator('[data-testid="dsh-skin-edit-name"]').fill('Lifecycle Skin Renamed')
    await clickAction('dsh-skin-edit-save')
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-testid="dsh-skin-lifecycle-result"]')
      return el !== null && /已保存/.test(el.textContent ?? '')
    }, undefined, { timeout: 20_000 })
    await clickAction('dsh-skin-refresh')
    await page.waitForTimeout(500)
    expect(await page.locator('[data-testid="dsh-skin-card-lifecycle-skin"]').count()).toBe(1)
    expect(await page.locator('[data-testid="dsh-skin-card-lifecycle-skin"]').innerText()).toContain('Renamed')
    // 导出 zip：PK 头 + 可解包（统一交换格式）
    const zipResponse = await fetch(BASE + '/dsh-skin/api/skins/lifecycle-skin/export')
    expect(zipResponse.status).toBe(200)
    expect(zipResponse.headers.get('content-type')).toContain('zip')
    const zipBytes = new Uint8Array(await zipResponse.arrayBuffer())
    expect(zipBytes[0]).toBe(0x50)
    expect(zipBytes[1]).toBe(0x4b)
    const { unzipSync } = await import('fflate')
    const unpacked = unzipSync(zipBytes)
    expect(Object.keys(unpacked)).toContain('manifest.json')
    expect(new TextDecoder().decode(unpacked['manifest.json'])).toContain('Renamed')
    // 重新生成（既有 spec + 覆盖安装，不带视觉依赖）
    await clickAction('dsh-skin-action-lifecycle-skin-regenerate')
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-testid="dsh-skin-lifecycle-result"]')
      return el !== null && /已重新生成/.test(el.textContent ?? '')
    }, undefined, { timeout: 300_000 })
    await clickAction('dsh-skin-refresh')
    await page.waitForTimeout(500)
    expect(await page.locator('[data-testid="dsh-skin-card-lifecycle-skin"]').count()).toBe(1)
    const list = await (await fetch(BASE + '/dsh-skin/api/skins')).json() as { skins: Array<{ id: string; source: string; name: string }> }
    const entry = list.skins.find(skin => skin.id === 'lifecycle-skin')
    expect(entry?.source).toBe('generated')
    expect(entry?.name).toBe('Lifecycle Skin Renamed')
    // 卸载
    await clickAction('dsh-skin-action-lifecycle-skin-uninstall')
    await page.waitForTimeout(800)
    expect(await page.locator('[data-testid="dsh-skin-card-lifecycle-skin"]').count()).toBe(0)
    await page.close()
  }, 300_000)

// ---------- Phase 5：本地 mock Workshop 服务器（协议 v1） ----------
async function startMockWorkshop(): Promise<{ close(): Promise<void>; uploads: Array<{ path: string; body: Record<string, unknown> }>; reports: Array<{ skinId: string; reason: string }> }> {
  const http = await import('node:http')
  const { zipSync } = await import('fflate')
  const makeZip = (version: string): Uint8Array => {
    const encoder = new TextEncoder()
    const id = 'ws-demo'
    return zipSync({
      'manifest.json': encoder.encode(JSON.stringify({ id, version, name: 'WS Demo', author: 'ws', description: 'mock 远端皮肤', tags: ['workshop'], skinApiVersion: 1, preview: {} })),
      'theme/light.json': encoder.encode('{}'),
      'theme/dark.json': encoder.encode('{}'),
      'styles/theme.css': encoder.encode('body[data-dsh-skin="ws-demo"]{}'),
      'client/index.js': encoder.encode('window.__ModuleLoader__.load({ id: "dsh-skin/ws-demo", factory: function () { return { apply: function () {} }; } });'),
      'preview/light.svg': encoder.encode('<svg/>'),
    })
  }
  const zipV1 = makeZip('1.0.0')
  const zipV2 = makeZip('2.0.0')
  const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
  const { createHash } = await import('node:crypto')
  const checksums: Record<string, string> = { '1.0.0': sha(zipV1), '2.0.0': sha(zipV2) }
  let publishedFirst = '1.0.0'
  const uploads: Array<{ path: string; body: Record<string, unknown> }> = []
  const reports: Array<{ skinId: string; reason: string }> = []
  let publishedCount = 0
  const info = (version: string) => ({
    skinId: 'ws-demo', version, name: 'WS Demo', author: 'ws', description: 'mock 远端皮肤', tags: ['workshop'], category: 'demo',
    preview: {}, downloadCount: 42, rating: 4.5, createdAt: '', updatedAt: '', harnessCompatibility: '', skinApiVersion: 1,
    license: 'MIT', checksum: checksums[version], packageSize: (version === '1.0.0' ? zipV1 : zipV2).length,
  })
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://mock')
    if (req.method === 'POST') {
      let raw = ''
      req.on('data', chunk => { raw += String(chunk) })
      req.on('end', () => {
        const body = JSON.parse(raw || '{}') as Record<string, unknown>
        if (url.pathname === '/skins') {
          uploads.push({ path: url.pathname, body })
          publishedCount += 1
          res.writeHead(200, { 'Content-Type': 'application/json' })
          return res.end(JSON.stringify({ skinId: 'publish-me', version: '0.1.' + publishedCount, checksum: String(body.packageSha256 ?? '') }))
        }
        if (url.pathname === '/skins/publish-me/versions') {
          uploads.push({ path: url.pathname, body })
          publishedCount += 1
          res.writeHead(200, { 'Content-Type': 'application/json' })
          return res.end(JSON.stringify({ skinId: 'publish-me', version: '0.1.' + publishedCount, checksum: String(body.packageSha256 ?? '') }))
        }
        if (url.pathname === '/skins/ws-demo/report') {
          reports.push({ skinId: 'ws-demo', reason: String(body.reason ?? '') })
          res.writeHead(200, { 'Content-Type': 'application/json' })
          return res.end(JSON.stringify({ ok: true }))
        }
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end('{}')
      })
      return
    }
    if (url.pathname === '/skins') {
      const q = url.searchParams.get('q') ?? ''
      const all = [info(publishedFirst), { ...info('0.5.0'), skinId: 'ws-extra', name: 'WS Extra', checksum: checksums['1.0.0'] }]
      const skins = q.length > 0 ? all.filter(skin => skin.name.includes(q) || skin.skinId.includes(q)) : all
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ skins }))
    }
    if (url.pathname === '/skins/ws-demo/versions') {
      const versions = publishedFirst === '1.0.0' ? ['1.0.0', '2.0.0'] : ['2.0.0', '1.0.0']
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ skinId: 'ws-demo', versions: versions.map(version => ({ version, checksum: checksums[version], size: 1, createdAt: '', harnessCompatibility: '', skinApiVersion: 1 })) }))
    }
    if (url.pathname.startsWith('/skins/ws-demo/download')) {
      const version = url.searchParams.get('version') ?? '1.0.0'
      const bytes = version === '2.0.0' ? zipV2 : zipV1
      publishedFirst = '2.0.0' // 模拟发布新版本
      res.writeHead(200, { 'Content-Type': 'application/zip' })
      return res.end(Buffer.from(bytes))
    }
    if (url.pathname === '/skins/ws-demo') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify(info(publishedFirst)))
    }
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end('{}')
  })
  await new Promise<void>(resolve => server.listen(3199, '127.0.0.1', resolve))
  return { close: () => new Promise<void>(resolve => server.close(() => resolve())), uploads, reports }
}

  it('E2E-7：Workshop 浏览/下载/更新/离线降级（mock 远端服务器）', async () => {
    const workshop = await startMockWorkshop()
    try {
      // 幂等前置清理：上一次失败可能残留 ws-demo 或远端配置
      await fetch(BASE + '/dsh-skin/api/remove', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'ws-demo' }) }).catch(() => undefined)
      await fetch(BASE + '/dsh-skin/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workshopUrl: '' }) }).catch(() => undefined)
      page = await bootPage()
      await openSkinCard()
      // 配置远端
      const cfg = await fetch(BASE + '/dsh-skin/api/config', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workshopUrl: 'http://127.0.0.1:3199' }),
      })
      expect(cfg.status).toBe(200)
      // 浏览
      await clickAction('dsh-skin-workshop-refresh')
      await page.waitForTimeout(800)
      expect(await page.locator('[data-testid="dsh-skin-workshop-item-ws-demo"]').count()).toBe(1)
      // 下载并安装（v1.0.0 → downloaded 来源）
      await clickAction('dsh-skin-workshop-download-ws-demo')
      await page.waitForFunction(() => {
        const el = document.querySelector('[data-testid="dsh-skin-workshop-status"]')
        return el !== null && /已下载安装/.test(el.textContent ?? '')
      }, undefined, { timeout: 60_000 })
      await clickAction('dsh-skin-refresh')
      await page.waitForTimeout(500)
      expect(await page.locator('[data-testid="dsh-skin-card-ws-demo"]').count()).toBe(1)
      const list = await (await fetch(BASE + '/dsh-skin/api/skins')).json() as { skins: Array<{ id: string; source: string; version: string }> }
      const local = list.skins.find(skin => skin.id === 'ws-demo')
      expect(local?.source).toBe('downloaded')
      expect(local?.version).toBe('1.0.0')
      // untrusted 标注（下载来源）
      expect(await page.locator('[data-testid="dsh-skin-trust-ws-demo"]').count()).toBe(1)
      // 远端发布新版本（mock 在 download 后把最新切换为 2.0.0）→ 更新
      await clickAction('dsh-skin-workshop-refresh')
      await page.waitForTimeout(800)
      await clickAction('dsh-skin-workshop-update-ws-demo')
      await page.waitForFunction(() => {
        const el = document.querySelector('[data-testid="dsh-skin-workshop-status"]')
        return el !== null && /已更新/.test(el.textContent ?? '')
      }, undefined, { timeout: 60_000 })
      await clickAction('dsh-skin-refresh')
      await page.waitForTimeout(500)
      const afterUpdate = await (await fetch(BASE + '/dsh-skin/api/skins')).json() as { skins: Array<{ id: string; version: string; source: string }> }
      const updated = afterUpdate.skins.find(skin => skin.id === 'ws-demo')
      expect(updated?.version).toBe('2.0.0')
      expect(updated?.source).toBe('downloaded')
      // 离线降级：指向不可达地址，浏览失败但本地皮肤照常
      await fetch(BASE + '/dsh-skin/api/config', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workshopUrl: 'http://127.0.0.1:3198' }),
      })
      await clickAction('dsh-skin-workshop-refresh')
      await page.waitForFunction(() => {
        const el = document.querySelector('[data-testid="dsh-skin-workshop-status"]')
        return el !== null && /离线|不可达/.test(el.textContent ?? '')
      }, undefined, { timeout: 60_000 })
      expect(await page.locator('[data-testid="dsh-skin-card-ws-demo"]').count()).toBe(1)
      expect(await page.locator('[data-testid="dsh-skin-card-terminal"]').count()).toBe(1)
      // 清理：卸载（先选卡展开详情）+ 清空配置
      await page.locator('[data-testid="dsh-skin-card-ws-demo"]').click({ force: true })
      await page.waitForTimeout(400)
      await clickAction('dsh-skin-action-ws-demo-uninstall')
      await page.waitForTimeout(600)
      await page.close()
    } finally {
      await fetch(BASE + '/dsh-skin/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workshopUrl: '' }) }).catch(() => undefined)
      await fetch(BASE + '/dsh-skin/api/remove', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'ws-demo' }) }).catch(() => undefined)
      await workshop.close()
    }
  }, 300_000)

  it('E2E-8：Workshop 发布/发布新版本/举报（mock 远端记录上传）', async () => {
    const workshop = await startMockWorkshop()
    try {
      // 前置清理 + 配置
      await fetch(BASE + '/dsh-skin/api/remove', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'publish-me' }) }).catch(() => undefined)
      await fetch(BASE + '/dsh-skin/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workshopUrl: 'http://127.0.0.1:3199' }) })
      // 安装一个本地皮肤（fixture 目录）
      const os = await import('node:os')
      const path = await import('node:path')
      const nodeFsModule = await import('node:fs')
      const fixtureDir = path.join(os.tmpdir(), 'dsh-skin-publish-fixture')
      nodeFsModule.rmSync(fixtureDir, { recursive: true, force: true })
      for (const dir of ['theme', 'styles', 'client', 'preview']) nodeFsModule.mkdirSync(path.join(fixtureDir, dir), { recursive: true })
      const encoder = new TextEncoder()
      nodeFsModule.writeFileSync(path.join(fixtureDir, 'manifest.json'), encoder.encode(JSON.stringify({ id: 'publish-me', version: '0.1.0', name: 'Publish Me', author: 'e2e', description: '发布验证', tags: ['publish'], skinApiVersion: 1, preview: {} })))
      nodeFsModule.writeFileSync(path.join(fixtureDir, 'theme', 'light.json'), encoder.encode('{}'))
      nodeFsModule.writeFileSync(path.join(fixtureDir, 'theme', 'dark.json'), encoder.encode('{}'))
      nodeFsModule.writeFileSync(path.join(fixtureDir, 'styles', 'theme.css'), encoder.encode('body[data-dsh-skin="publish-me"]{}'))
      nodeFsModule.writeFileSync(path.join(fixtureDir, 'client', 'index.js'), encoder.encode('window.__ModuleLoader__.load({ id: "dsh-skin/publish-me", factory: function () { return { apply: function () {} }; } });'))
      nodeFsModule.writeFileSync(path.join(fixtureDir, 'preview', 'light.svg'), encoder.encode('<svg/>'))
      const installed = await fetch(BASE + '/dsh-skin/api/install', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceDir: fixtureDir }),
      })
      expect(installed.status).toBe(200)
      page = await bootPage()
      await openSkinCard()
      // 发布
      await page.locator('[data-testid="dsh-skin-card-publish-me"]').click({ force: true })
      await page.waitForTimeout(400)
      await clickAction('dsh-skin-action-publish-me-publish')
      await page.waitForFunction(() => {
        const el = document.querySelector('[data-testid="dsh-skin-lifecycle-result"]')
        return el !== null && /已发布.*0\.1\.1/.test(el.textContent ?? '')
      }, undefined, { timeout: 60_000 })
      expect(workshop.uploads.length).toBe(1)
      expect(workshop.uploads[0].path).toBe('/skins')
      // 上传 zip 可解包且内容正确
      const { unzipSync } = await import('fflate')
      const uploaded = unzipSync(new Uint8Array(Buffer.from(String(workshop.uploads[0].body.packageBase64), 'base64')))
      expect(Object.keys(uploaded)).toContain('manifest.json')
      expect(new TextDecoder().decode(uploaded['manifest.json'])).toContain('publish-me')
      // 发布新版本
      await clickAction('dsh-skin-action-publish-me-publish-version')
      await page.waitForFunction(() => {
        const el = document.querySelector('[data-testid="dsh-skin-lifecycle-result"]')
        return el !== null && /已发布.*0\.1\.2/.test(el.textContent ?? '')
      }, undefined, { timeout: 60_000 })
      expect(workshop.uploads.length).toBe(2)
      expect(workshop.uploads[1].path).toBe('/skins/publish-me/versions')
      // 本地包未被上传改动（version 仍 0.1.0，state ok）
      const list = await (await fetch(BASE + '/dsh-skin/api/skins')).json() as { skins: Array<{ id: string; version: string; state: string }> }
      const local = list.skins.find(skin => skin.id === 'publish-me')
      expect(local?.version).toBe('0.1.0')
      expect(local?.state).toBe('ok')
      // 举报远端
      await clickAction('dsh-skin-workshop-refresh')
      await page.waitForTimeout(800)
      await clickAction('dsh-skin-workshop-report-ws-demo')
      await page.waitForFunction(() => {
        const el = document.querySelector('[data-testid="dsh-skin-workshop-status"]')
        return el !== null && /已举报/.test(el.textContent ?? '')
      }, undefined, { timeout: 60_000 })
      expect(workshop.reports.length).toBe(1)
      expect(workshop.reports[0].skinId).toBe('ws-demo')
      // 离线发布失败：本地零改动
      await fetch(BASE + '/dsh-skin/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workshopUrl: 'http://127.0.0.1:3198' }) })
      await clickAction('dsh-skin-action-publish-me-publish')
      await page.waitForFunction(() => {
        const el = document.querySelector('[data-testid="dsh-skin-lifecycle-result"]')
        return el !== null && /发布失败/.test(el.textContent ?? '')
      }, undefined, { timeout: 60_000 })
      const afterFail = await (await fetch(BASE + '/dsh-skin/api/skins')).json() as { skins: Array<{ id: string; version: string; state: string }> }
      expect(afterFail.skins.find(skin => skin.id === 'publish-me')?.state).toBe('ok')
      // 清理
      await clickAction('dsh-skin-action-publish-me-uninstall')
      await page.waitForTimeout(600)
      nodeFsModule.rmSync(fixtureDir, { recursive: true, force: true })
      await page.close()
    } finally {
      await fetch(BASE + '/dsh-skin/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workshopUrl: '' }) }).catch(() => undefined)
      await fetch(BASE + '/dsh-skin/api/remove', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'publish-me' }) }).catch(() => undefined)
      await workshop.close()
    }
  }, 300_000)

  it('E2E-9：AI Skin 生命周期 UI（两段式生成/取消/历史/卸载→重装/重新生成/设计编辑，fixture）', async () => {
    page = await bootPage()
    await openSkinCard()
    const os = await import('node:os')
    const path = await import('node:path')
    const nodeFsModule = await import('node:fs')
    const pngPath = path.join(os.tmpdir(), 'dsh-skin-e2e-v15.png')
    const pngjs = await import('pngjs') as { PNG: { new (options: { width: number; height: number }): { data: Buffer }; sync: { write(png: unknown): Buffer } } }
    const canvas = new pngjs.PNG({ width: 64, height: 64 })
    for (let i = 0; i < canvas.data.length; i += 4) {
      canvas.data[i] = 11; canvas.data[i + 1] = 18; canvas.data[i + 2] = 11; canvas.data[i + 3] = 255
    }
    nodeFsModule.writeFileSync(pngPath, pngjs.PNG.sync.write(canvas))
    // 1) 两段式生成 + 状态可见 + 取消（不产生皮肤）
    await page.locator('[data-testid="dsh-skin-gen-file"]').setInputFiles(pngPath)
    await page.locator('[data-testid="dsh-skin-gen-name"]').fill('Lifecycle UI')
    await clickAction('dsh-skin-gen-submit')
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-testid="dsh-skin-gen-status"]')
      return el !== null && /状态：/.test(el.textContent ?? '')
    }, undefined, { timeout: 20_000 })
    expect(await page.locator('[data-testid="dsh-skin-gen-status"]').innerText()).toMatch(/状态：/)
    await clickAction('dsh-skin-gen-cancel')
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-testid="dsh-skin-gen-result"]')
      return el !== null && /已取消/.test(el.textContent ?? '')
    }, undefined, { timeout: 60_000 })
    await clickAction('dsh-skin-refresh')
    await page.waitForTimeout(500)
    expect(await page.locator('[data-testid="dsh-skin-card-lifecycle-ui"]').count()).toBe(0)
    // 2) 再次生成至完成 → 历史块可见（含 CANCELLED + COMPLETED）
    await clickAction('dsh-skin-gen-submit')
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-testid="dsh-skin-gen-result"]')
      return el !== null && /已生成并安装/.test(el.textContent ?? '')
    }, undefined, { timeout: 300_000 })
    await clickAction('dsh-skin-refresh')
    await page.waitForTimeout(500)
    const card = page.locator('[data-testid="dsh-skin-card-lifecycle-ui"]')
    expect(await card.count()).toBe(1)
    await card.click({ force: true })
    await page.waitForTimeout(500)
    const history = page.locator('[data-testid="dsh-skin-generations-lifecycle-ui"]')
    expect(await history.count()).toBe(1)
    const historyText = await history.innerText()
    expect(historyText).toContain('CANCELLED')
    expect(historyText).toContain('COMPLETED')
    // 3) 卸载 → AI 记录面板出现「重新安装」→ 重装（不调用模型）
    await clickAction('dsh-skin-action-lifecycle-ui-uninstall')
    await page.waitForTimeout(900)
    expect(await page.locator('[data-testid="dsh-skin-card-lifecycle-ui"]').count()).toBe(0)
    const recordPanel = page.locator('[data-testid="dsh-skin-ai-record-lifecycle-ui"]')
    expect(await recordPanel.count()).toBe(1)
    await clickAction('dsh-skin-ai-reinstall-lifecycle-ui')
    await page.waitForTimeout(900)
    await clickAction('dsh-skin-refresh')
    await page.waitForTimeout(500)
    expect(await page.locator('[data-testid="dsh-skin-card-lifecycle-ui"]').count()).toBe(1)
    // 4) 重新生成 → 版本 0.1.1
    await page.locator('[data-testid="dsh-skin-card-lifecycle-ui"]').click({ force: true })
    await page.waitForTimeout(400)
    await clickAction('dsh-skin-action-lifecycle-ui-regenerate')
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-testid="dsh-skin-lifecycle-result"]')
      return el !== null && /已重新生成/.test(el.textContent ?? '')
    }, undefined, { timeout: 300_000 })
    await clickAction('dsh-skin-refresh')
    await page.waitForTimeout(500)
    let list = await (await fetch(BASE + '/dsh-skin/api/skins')).json() as { skins: Array<{ id: string; version: string; source: string }> }
    expect(list.skins.find(skin => skin.id === 'lifecycle-ui')?.version).toBe('0.1.1')
    void list
    // 5) 设计编辑 → 新版本 0.1.2
    await page.locator('[data-testid="dsh-skin-card-lifecycle-ui"]').click({ force: true })
    await page.waitForTimeout(400)
    await clickAction('dsh-skin-edit-design-open')
    await page.locator('[data-testid="dsh-skin-edit-design-json"]').fill(JSON.stringify({
      targetRegions: ['global'],
      problemAssessment: '设计编辑：视觉风格更新',
      specChanges: [{ path: 'visualStyle', newValue: 'design-edited-e2e', reason: '用户设计编辑', targetRegion: 'global', expectedEffect: '更新风格描述' }],
    }))
    await clickAction('dsh-skin-edit-design-save')
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-testid="dsh-skin-lifecycle-result"]')
      return el !== null && /设计已应用并生成新版本/.test(el.textContent ?? '')
    }, undefined, { timeout: 300_000 })
    await clickAction('dsh-skin-refresh')
    await page.waitForTimeout(500)
    list = await (await fetch(BASE + '/dsh-skin/api/skins')).json() as { skins: Array<{ id: string; version: string; source: string }> }
    expect(list.skins.find(skin => skin.id === 'lifecycle-ui')?.version).toBe('0.1.2')
    // 清理：卸载
    await page.locator('[data-testid="dsh-skin-card-lifecycle-ui"]').click({ force: true })
    await page.waitForTimeout(400)
    await clickAction('dsh-skin-action-lifecycle-ui-uninstall')
    await page.waitForTimeout(800)
    nodeFsModule.rmSync(pngPath, { force: true })
    await page.close()
  }, 600_000)
})
