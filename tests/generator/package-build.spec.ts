/**
 * v1.3 Deterministic Package Builder 单元矩阵：
 * manifest 映射 / package builder / CSS 输出 / 资产管道 / integrity（自引用排除）/ 确定性排序 /
 * 路径规范化 / 版本 / 时间戳与随机性 / 产物校验器反例矩阵。
 */
import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { nodeFs } from '../../src/repository/fs.ts'
import {
  buildSkinPackage, writeSkinPackage, validateBuiltPackage, sealPackage, absolutePathIssues, assetPathIssues,
  fatalCssIssues, DEFAULT_BUILD_CONFIG, PACKAGE_BUILDER_VERSION, DEFAULT_PACKAGE_VERSION,
} from '../../src/generator/package-build.ts'
import { validateManifest } from '../../src/core/manifest.ts'
import { hashPackage, verifyPackage } from '../../src/core/integrity.ts'
import type { SkinDesignSpec } from '../../src/core/spec.ts'

function validSpec(): SkinDesignSpec {
  return {
    visualStyle: 'fixture-terminal',
    colorPalette: [
      { hex: '#0b120b', role: 'bg-base', share: 0.5 },
      { hex: '#101a10', role: 'bg-layer', share: 0.2 },
      { hex: '#33ff66', role: 'brand', share: 0.1 },
      { hex: '#b8ffc8', role: 'label', share: 0.08 },
      { hex: '#1e3a1e', role: 'border', share: 0.07 },
      { hex: '#66ff99', role: 'accent', share: 0.05 },
    ],
    typography: { family: '"Cascadia Mono", Consolas, monospace', mono: '"Cascadia Mono", Consolas, monospace' },
    spacing: { density: 'comfortable', radius: 2 },
    shapeLanguage: 'border-radius: 2px;',
    borderStyle: 'border: 1px solid var(--dsw-alias-border-l2);',
    shadowStyle: 'box-shadow: 0 0 12px rgba(51,255,102,0.25);',
    backgroundStyle: 'background: radial-gradient(ellipse at 50% -20%, rgba(51,255,102,0.12), transparent 60%), var(--dsw-alias-bg-base);',
    headerStyle: 'border-bottom: 1px solid var(--dsw-alias-border-l1);',
    sidebarStyle: 'background: var(--dsw-specific-sidebar-fill);',
    messageStyle: '',
    inputStyle: 'background: var(--dsw-alias-bg-layer-1);',
    buttonStyle: 'background: var(--dsw-alias-bg-layer-2);',
    cardStyle: 'background: var(--dsw-alias-bg-layer-1);',
    iconStyle: '',
    chromeElements: ['scanlines'],
    decorativeElements: ['glow'],
    assetCandidates: [],
  }
}

const naming = { id: 'demo-skin', name: 'Demo Skin', author: 'tester', description: 'v1.3 确定性构建测试', tags: ['determinism'] }

const EXPECTED_FILES = ['manifest.json', 'theme/light.json', 'theme/dark.json', 'styles/theme.css', 'client/index.js', 'preview/light.svg', 'preview/dark.svg']

function tempRoot(): string {
  const dir = join(tmpdir(), 'dsh-skin-pkg-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6))
  mkdirSync(dir, { recursive: true })
  return dir
}

function collectTree(dir: string): Record<string, Uint8Array> {
  const out: Record<string, Uint8Array> = {}
  const walk = (current: string, prefix: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = prefix.length === 0 ? entry.name : prefix + '/' + entry.name
      const full = join(current, entry.name)
      if (entry.isDirectory()) walk(full, rel)
      else out[rel] = new Uint8Array(readFileSync(full))
    }
  }
  walk(dir, '')
  return out
}

describe('buildSkinPackage（manifest 映射 + 确定性）', () => {
  it('A1/A2：Spec+Naming+Config → manifest 映射确定（version 来自 BuildConfig）', async () => {
    const root = tempRoot()
    const result = await buildSkinPackage(nodeFs(), join(root, 'build'), validSpec(), naming, { packageVersion: '1.2.3', generatorVersion: PACKAGE_BUILDER_VERSION, previewMode: 'svg' })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.issues.join(';'))
    for (const rel of EXPECTED_FILES) expect(existsSync(join(root, 'build', rel)), rel).toBe(true)
    const manifest = JSON.parse(readFileSync(join(root, 'build', 'manifest.json'), 'utf8'))
    expect(validateManifest(manifest).ok).toBe(true)
    expect(manifest.version).toBe('1.2.3')
    expect(manifest.id).toBe('demo-skin')
    expect(manifest.skinApiVersion).toBe(1)
    expect(manifest.preview).toEqual({ light: 'preview/light.svg', dark: 'preview/dark.svg' })
    // mapping 证据：colorPalette[role=brand] → --dsw-alias-brand-primary；未渲染字段显式标注
    const mapping = result.buildManifest.mapping
    const brandEntry = mapping.find(entry => entry.specField.includes('role=brand'))
    expect(brandEntry?.outputField).toBe('--dsw-alias-brand-primary')
    expect(mapping.some(entry => entry.specField === 'spacing.density' && entry.outputFile === '(未渲染)')).toBe(true)
    expect(mapping.some(entry => entry.specField === 'naming.id' && entry.outputField === '$.id')).toBe(true)
    // 文件列表确定排序
    expect(result.files).toEqual([...EXPECTED_FILES].sort())
    rmSync(root, { recursive: true, force: true })
  })

  it('B1/B4/B5/B6：同 Spec+Config 双构建（不同目录）→ 全文件 byte-identical + buildManifest 一致', async () => {
    const root = tempRoot()
    const a = await buildSkinPackage(nodeFs(), join(root, 'dir-a', 'pkg'), validSpec(), naming)
    const b = await buildSkinPackage(nodeFs(), join(root, 'dir-b', 'pkg'), validSpec(), naming)
    expect(a.ok && b.ok).toBe(true)
    if (!a.ok || !b.ok) throw new Error([...(!a.ok ? a.issues : []), ...(!b.ok ? b.issues : [])].join(';'))
    const treeA = collectTree(join(root, 'dir-a', 'pkg'))
    const treeB = collectTree(join(root, 'dir-b', 'pkg'))
    expect(Object.keys(treeA).sort()).toEqual(Object.keys(treeB).sort())
    for (const rel of Object.keys(treeA)) {
      expect(Buffer.from(treeA[rel]).equals(Buffer.from(treeB[rel])), rel).toBe(true)
    }
    expect(a.buildManifest).toEqual(b.buildManifest)
    // css 确定性：逐字节同源（B6）
    const css = readFileSync(join(root, 'dir-a', 'pkg', 'styles', 'theme.css'), 'utf8')
    expect(css).toContain('body[data-dsh-skin="demo-skin"]')
    rmSync(root, { recursive: true, force: true })
  })

  it('B3/B4：包内无时间戳/随机内容（ISO 时间、runId 模式均不出现）', async () => {
    const root = tempRoot()
    const result = await buildSkinPackage(nodeFs(), join(root, 'build'), validSpec(), naming)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.issues.join(';'))
    for (const rel of EXPECTED_FILES) {
      const text = readFileSync(join(root, 'build', rel), 'utf8')
      expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T/)
      expect(text).not.toMatch(/gen-\d/)
      expect(text).not.toMatch(/Math\.random|randomBytes|uuid/)
    }
    rmSync(root, { recursive: true, force: true })
  })

  it('MANIFEST_BUILD：非法命名/版本/previewMode 拒绝', async () => {
    const root = tempRoot()
    const badId = await buildSkinPackage(nodeFs(), join(root, 'b1'), validSpec(), { ...naming, id: 'Bad ID!' })
    expect(badId.ok).toBe(false)
    if (!badId.ok) expect(badId.failureDomain).toBe('MANIFEST_BUILD')
    const badVer = await buildSkinPackage(nodeFs(), join(root, 'b2'), validSpec(), naming, { ...DEFAULT_BUILD_CONFIG, packageVersion: '1.0.<ts>' })
    expect(badVer.ok).toBe(false)
    if (!badVer.ok) expect(badVer.failureDomain).toBe('MANIFEST_BUILD')
    const badMode = await buildSkinPackage(nodeFs(), join(root, 'b3'), validSpec(), naming, { ...DEFAULT_BUILD_CONFIG, previewMode: 'screenshot' as never })
    expect(badMode.ok).toBe(false)
    if (!badMode.ok) expect(badMode.failureDomain).toBe('MANIFEST_BUILD')
    const badTag = await buildSkinPackage(nodeFs(), join(root, 'b4'), validSpec(), { ...naming, tags: ['Bad Tag'] })
    expect(badTag.ok).toBe(false)
    if (!badTag.ok) expect(badTag.failureDomain).toBe('MANIFEST_BUILD')
    // 失败不留半成品目录
    expect(existsSync(join(root, 'b1'))).toBe(false)
    rmSync(root, { recursive: true, force: true })
  })

  it('A7：资产管道逐字节复制；非法路径/冲突路径 → ASSET_BUILD', async () => {
    const root = tempRoot()
    const assetBytes = new Uint8Array([1, 2, 3, 4, 5])
    const config = { ...DEFAULT_BUILD_CONFIG, assets: { 'assets/logo.bin': assetBytes, 'preview/extra.txt': new TextEncoder().encode('hello') } }
    const result = await buildSkinPackage(nodeFs(), join(root, 'build'), validSpec(), naming, config)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.issues.join(';'))
    const onDisk = new Uint8Array(readFileSync(join(root, 'build', 'assets', 'logo.bin')))
    expect(Buffer.from(onDisk).equals(Buffer.from(assetBytes))).toBe(true)
    expect(result.files).toContain('assets/logo.bin')
    const badRel = await buildSkinPackage(nodeFs(), join(root, 'b1'), validSpec(), naming, { ...DEFAULT_BUILD_CONFIG, assets: { '../evil.txt': assetBytes } })
    expect(badRel.ok).toBe(false)
    if (!badRel.ok) expect(badRel.failureDomain).toBe('ASSET_BUILD')
    const backslash = await buildSkinPackage(nodeFs(), join(root, 'b2'), validSpec(), naming, { ...DEFAULT_BUILD_CONFIG, assets: { 'a\\b.txt': assetBytes } })
    expect(backslash.ok).toBe(false)
    if (!backslash.ok) expect(backslash.failureDomain).toBe('ASSET_BUILD')
    const clash = await buildSkinPackage(nodeFs(), join(root, 'b3'), validSpec(), naming, { ...DEFAULT_BUILD_CONFIG, assets: { 'styles/theme.css': assetBytes } })
    expect(clash.ok).toBe(false)
    if (!clash.ok) expect(clash.failureDomain).toBe('ASSET_BUILD')
    expect(assetPathIssues('assets/ok.png')).toEqual([])
    rmSync(root, { recursive: true, force: true })
  })

  it('CSS_VALIDATION：致命 CSS 结构问题判定（导出函数）', () => {
    expect(fatalCssIssues('a { color: red; }')).toEqual([])
    expect(fatalCssIssues('a { color: red;').length).toBeGreaterThan(0)
    expect(fatalCssIssues('a { color: red; } body { 中文: x; }').length).toBeGreaterThan(0)
  })

  it('writeSkinPackage 兼容封装：默认配置产出同一文件集', async () => {
    const root = tempRoot()
    await writeSkinPackage(nodeFs(), join(root, 'w'), validSpec(), naming)
    const legacy = await buildSkinPackage(nodeFs(), join(root, 'n'), validSpec(), naming, DEFAULT_BUILD_CONFIG)
    expect(legacy.ok).toBe(true)
    if (!legacy.ok) throw new Error(legacy.issues.join(';'))
    expect(Buffer.from(readFileSync(join(root, 'w', 'manifest.json'))).equals(Buffer.from(readFileSync(join(root, 'n', 'manifest.json'))))).toBe(true)
    expect(JSON.parse(readFileSync(join(root, 'w', 'manifest.json'), 'utf8')).version).toBe(DEFAULT_PACKAGE_VERSION)
    rmSync(root, { recursive: true, force: true })
  })
})

describe('validateBuiltPackage（产物校验器）', () => {
  async function build(root: string): Promise<string> {
    const result = await buildSkinPackage(nodeFs(), join(root, 'pkg'), validSpec(), naming)
    if (!result.ok) throw new Error(result.issues.join(';'))
    return join(root, 'pkg')
  }

  it('C1~C7：合法产物全部通过', async () => {
    const root = tempRoot()
    const dir = await build(root)
    const result = await validateBuiltPackage(nodeFs(), dir)
    expect(result.ok, result.ok ? '' : result.issues.map(i => i.path + ' ' + i.message).join(';')).toBe(true)
    if (!result.ok) throw new Error('should pass')
    expect(result.files.sort()).toEqual([...EXPECTED_FILES].sort())
    rmSync(root, { recursive: true, force: true })
  })

  it('反例矩阵：坏 manifest / 缺 client / 坏 CSS / 缺 preview / 可执行文件 / 远程 URL / 绝对路径 / 非法 token', async () => {
    const root = tempRoot()
    // 坏 manifest
    const d1 = await build(root)
    writeFileSync(join(d1, 'manifest.json'), '{"id":"demo-skin","version":"x"}')
    const r1 = await validateBuiltPackage(nodeFs(), d1)
    expect(r1.ok).toBe(false)
    // 缺 client
    const d2 = await build(root + '-2')
    rmSync(join(d2, 'client', 'index.js'))
    const r2 = await validateBuiltPackage(nodeFs(), d2)
    expect(r2.ok).toBe(false)
    if (!r2.ok) expect(r2.issues.some(i => i.path.includes('client'))).toBe(true)
    // 坏 CSS（失衡花括号）
    const d3 = await build(root + '-3')
    writeFileSync(join(d3, 'styles', 'theme.css'), 'a { color: red;')
    const r3 = await validateBuiltPackage(nodeFs(), d3)
    expect(r3.ok).toBe(false)
    if (!r3.ok) expect(r3.issues.some(i => i.path.includes('theme.css'))).toBe(true)
    // 缺 preview
    const d4 = await build(root + '-4')
    rmSync(join(d4, 'preview', 'light.svg'))
    const r4 = await validateBuiltPackage(nodeFs(), d4)
    expect(r4.ok).toBe(false)
    if (!r4.ok) expect(r4.issues.some(i => i.path.includes('preview/light.svg'))).toBe(true)
    // 可执行文件
    const d5 = await build(root + '-5')
    writeFileSync(join(d5, 'evil.exe'), 'MZ')
    const r5 = await validateBuiltPackage(nodeFs(), d5)
    expect(r5.ok).toBe(false)
    if (!r5.ok) expect(r5.issues.some(i => i.message.includes('可执行'))).toBe(true)
    // 远程 URL（css 内）
    const d6 = await build(root + '-6')
    writeFileSync(join(d6, 'styles', 'extra.css'), 'a { background: url(http://evil/x.png); }')
    const r6 = await validateBuiltPackage(nodeFs(), d6)
    expect(r6.ok).toBe(false)
    if (!r6.ok) expect(r6.issues.some(i => i.message.includes('远程'))).toBe(true)
    // 绝对路径（css 内盘符）
    const d7 = await build(root + '-7')
    writeFileSync(join(d7, 'styles', 'extra.css'), 'a { background: url(C:\\Users\\x.png); }')
    const r7 = await validateBuiltPackage(nodeFs(), d7)
    expect(r7.ok).toBe(false)
    if (!r7.ok) expect(r7.issues.some(i => i.message.includes('盘符'))).toBe(true)
    // 非法 token 值
    const d8 = await build(root + '-8')
    writeFileSync(join(d8, 'theme', 'light.json'), '{"--dsw-alias-brand-primary": 42}')
    const r8 = await validateBuiltPackage(nodeFs(), d8)
    expect(r8.ok).toBe(false)
    if (!r8.ok) expect(r8.issues.some(i => i.path.includes('theme/light.json'))).toBe(true)
    rmSync(root, { recursive: true, force: true })
  })

  it('absolutePathIssues：盘符/UNC/file:// 命中；CSS 相对 url 不误报', async () => {
    const root = tempRoot()
    writeFileSync(join(root, 'a.css'), 'a { background: url(/icons/x.png); } b { color: red; }')
    expect(await absolutePathIssues(nodeFs(), root)).toEqual([])
    writeFileSync(join(root, 'b.css'), 'a { x: file:///C:/evil; }')
    expect((await absolutePathIssues(nodeFs(), root)).length).toBeGreaterThan(0)
    writeFileSync(join(root, 'c.css'), 'a { x: "D:\\path"; }')
    expect((await absolutePathIssues(nodeFs(), root)).length).toBeGreaterThan(0)
    rmSync(root, { recursive: true, force: true })
  })
})

describe('sealPackage（integrity）', () => {
  it('B7/§21：封存幂等 + 排除自身 + 篡改即失败', async () => {
    const root = tempRoot()
    const build = await buildSkinPackage(nodeFs(), join(root, 'pkg'), validSpec(), naming)
    if (!build.ok) throw new Error(build.issues.join(';'))
    const dir = join(root, 'pkg')
    const first = await sealPackage(nodeFs(), dir)
    expect(first.ok).toBe(true)
    if (!first.ok) throw new Error(first.issues.join(';'))
    const integrityText = readFileSync(join(dir, 'integrity.json'), 'utf8')
    expect(integrityText).not.toContain('integrity.json') // 自引用排除（既有 hashPackage 语义）
    const second = await sealPackage(nodeFs(), dir)
    expect(second.ok).toBe(true)
    expect(readFileSync(join(dir, 'integrity.json'), 'utf8')).toBe(integrityText) // 幂等字节一致
    const verify = await verifyPackage(nodeFs(), dir, first.integrity)
    expect(verify.ok).toBe(true)
    // 篡改任一文件 → 复验失败
    writeFileSync(join(dir, 'styles', 'theme.css'), readFileSync(join(dir, 'styles', 'theme.css'), 'utf8') + ' ')
    const tampered = await verifyPackage(nodeFs(), dir, first.integrity)
    expect(tampered.ok).toBe(false)
    const hash = await hashPackage(nodeFs(), dir)
    expect(hash.files.every(f => f.path !== 'integrity.json')).toBe(true)
    rmSync(root, { recursive: true, force: true })
  })

  it('不同内容 → integrity 变化（spec 变化即包变化，与图片来源无关）', async () => {
    const root = tempRoot()
    const a = await buildSkinPackage(nodeFs(), join(root, 'a'), validSpec(), naming)
    const b = await buildSkinPackage(nodeFs(), join(root, 'b'), { ...validSpec(), colorPalette: [{ hex: '#ffffff', role: 'bg-base', share: 1 }, { hex: '#33ff66', role: 'brand', share: 0.1 }] }, naming)
    expect(a.ok && b.ok).toBe(true)
    if (!a.ok || !b.ok) throw new Error('build fail')
    expect(a.buildManifest.inputIdentity.specSha256).not.toBe(b.buildManifest.inputIdentity.specSha256)
    const sa = await sealPackage(nodeFs(), join(root, 'a'))
    const sb = await sealPackage(nodeFs(), join(root, 'b'))
    expect(sa.ok && sb.ok).toBe(true)
    if (!sa.ok || !sb.ok) throw new Error('seal fail')
    expect(JSON.stringify(sa.integrity)).not.toBe(JSON.stringify(sb.integrity))
    rmSync(root, { recursive: true, force: true })
  })

  it('BuildConfig 变化 → buildConfigSha256 变化（身份可追踪）', async () => {
    const root = tempRoot()
    const a = await buildSkinPackage(nodeFs(), join(root, 'a'), validSpec(), naming, { ...DEFAULT_BUILD_CONFIG, packageVersion: '0.1.0' })
    const b = await buildSkinPackage(nodeFs(), join(root, 'b'), validSpec(), naming, { ...DEFAULT_BUILD_CONFIG, packageVersion: '0.2.0' })
    expect(a.ok && b.ok).toBe(true)
    if (!a.ok || !b.ok) throw new Error('build fail')
    expect(a.buildManifest.inputIdentity.buildConfigSha256).not.toBe(b.buildManifest.inputIdentity.buildConfigSha256)
    expect(JSON.parse(readFileSync(join(root, 'a', 'manifest.json'), 'utf8')).version).toBe('0.1.0')
    expect(JSON.parse(readFileSync(join(root, 'b', 'manifest.json'), 'utf8')).version).toBe('0.2.0')
    rmSync(root, { recursive: true, force: true })
  })

  it('evidenceRef 只进 build-manifest，不进包文件', async () => {
    const root = tempRoot()
    const evidenceRef = { imageKey: 'abc123', provider: 'vision-http', model: 'ovh/x', analysisVersion: 'v2' }
    const result = await buildSkinPackage(nodeFs(), join(root, 'pkg'), validSpec(), naming, DEFAULT_BUILD_CONFIG, evidenceRef)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.issues.join(';'))
    expect(result.buildManifest.evidenceRef).toEqual(evidenceRef)
    for (const rel of EXPECTED_FILES) {
      expect(readFileSync(join(root, 'pkg', rel), 'utf8')).not.toContain('abc123')
    }
    rmSync(root, { recursive: true, force: true })
  })
})
