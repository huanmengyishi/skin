/**
 * v1.3 Deterministic Package Builder：SkinDesignSpec + BuildConfig → 标准 SkinPackage。
 * 纯函数语义：同一 (Spec, BuildConfig, Generator Version) ⇒ 同一 Package 字节。
 * - 不读 process.env / cwd / 当前时间 / 随机数 / 机器路径。
 * - 包内只出现 package-relative 路径；时间戳与随机性只允许存在于 generation 工作区。
 * - 产物经 validateBuiltPackage（单一校验器）与 sealPackage（integrity.json，沿用 hashPackage 语义，
 *   排除 integrity.json 自身，不创造第二套 checksum）后，交 Phase 3 已验证的 repository.install 管线。
 * @module dsh-skin/src/generator/package-build
 */

import { createHash } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import { hashPackage, verifyPackage, type IntegrityManifest } from '../core/integrity.ts'
import { isValidRelativePath, isValidSkinId, SKIN_API_VERSION, validateManifest } from '../core/manifest.ts'
import { validateSkinDesignSpec, type SkinDesignSpec } from '../core/spec.ts'
import { parseStylesheet, type CssParseIssue } from '../core/css-parse.ts'
import { cssStylesheetIssues } from '../core/css-strings.ts'
import type { FsLike } from '../repository/fs.ts'
import { scanExecutables, scanRemoteUrls } from '../repository/security.ts'
import { cssFromSpecWithIssues, previewSvg, tokensFromSpec, ROLE_TOKEN, type SkinNaming } from './codegen.ts'

/** Builder 实现版本（代码内常量；只进 build-manifest，不进包文件）。 */
export const PACKAGE_BUILDER_VERSION = 'dsh-skin@1.5.0'
/** 缺省 Package Version：稳定常量策略（禁止时间戳/随机版本；用户可经 GenerateInput.version 覆盖）。 */
export const DEFAULT_PACKAGE_VERSION = '0.1.0'

export interface BuildConfig {
  /** manifest.version（SemVer；来源=用户或稳定常量） */
  packageVersion: string
  /** 构建器版本标识（只进 build-manifest） */
  generatorVersion: string
  /** 预览资产策略：v1.3 仅支持确定性 SVG */
  previewMode: 'svg'
  /** 可选资产集：包内相对路径 → 字节（逐字节复制，不重命名/不转码） */
  assets?: Record<string, Uint8Array>
}

export const DEFAULT_BUILD_CONFIG: BuildConfig = {
  packageVersion: DEFAULT_PACKAGE_VERSION,
  generatorVersion: PACKAGE_BUILDER_VERSION,
  previewMode: 'svg',
}

export type PackageBuildFailureDomain = 'SPEC_VALIDATION' | 'MANIFEST_BUILD' | 'ASSET_BUILD' | 'CSS_VALIDATION' | 'PACKAGE_BUILD'

export interface BuildMappingEntry {
  /** Spec/Naming/Config 字段路径 */
  specField: string
  outputFile: string
  outputField: string
  note?: string
}

export interface BuildManifestRecord {
  inputIdentity: {
    specSha256: string
    buildConfigSha256: string
    generatorVersion: string
    packageVersion: string
  }
  /** Spec 字段 → 输出文件/字段 映射（build evidence / 调试；不进 Package） */
  mapping: BuildMappingEntry[]
  /** 包内全部文件（相对路径，localeCompare 排序） */
  files: string[]
  /** 证据摘要（v1.2 provenance 的最小稳定投影；不进 Package） */
  evidenceRef?: { imageKey?: string; provider?: string; model?: string; analysisVersion?: string }
}

export type PackageBuildResult =
  | { ok: true; files: string[]; buildManifest: BuildManifestRecord; cssIssues: string[] }
  | { ok: false; issues: string[]; failureDomain: PackageBuildFailureDomain }

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const TAG_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/
/** builder 自身会写入的保留路径（资产不得覆盖）。 */
const RESERVED_OUTPUTS = new Set([
  'manifest.json', 'integrity.json',
  'theme/light.json', 'theme/dark.json',
  'styles/theme.css', 'client/index.js',
  'preview/light.svg', 'preview/dark.svg',
])

function sha256Of(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/** 校验资产相对路径：包内相对、无反斜杠/.. /前导斜杠、不覆盖 builder 输出。 */
export function assetPathIssues(rel: string): string[] {
  const issues: string[] = []
  if (rel.includes('\\')) { issues.push('资产路径含反斜杠（必须 \'/\' 分隔）：' + rel); return issues }
  if (!isValidRelativePath(rel)) { issues.push('资产路径非法（绝对/协议/穿越）：' + rel); return issues }
  if (rel.endsWith('/')) { issues.push('资产路径指向目录：' + rel) }
  if (RESERVED_OUTPUTS.has(rel)) { issues.push('资产路径与 builder 输出冲突：' + rel) }
  return issues
}

/** 命名校验（manifest 语义前置；失败域 MANIFEST_BUILD）。 */
export function namingIssues(naming: SkinNaming): string[] {
  const issues: string[] = []
  if (!isValidSkinId(naming.id)) issues.push('非法 Skin ID：' + naming.id)
  if (typeof naming.name !== 'string' || naming.name.trim().length === 0) issues.push('name 必须是非空字符串')
  else if (naming.name.length > 64) issues.push('name 长度不得超过 64')
  if (typeof naming.author !== 'string' || naming.author.trim().length === 0) issues.push('author 必须是非空字符串')
  if (typeof naming.description !== 'string' || naming.description.length === 0) issues.push('description 必须是非空字符串')
  else if (naming.description.length > 512) issues.push('description 长度不得超过 512')
  if (!Array.isArray(naming.tags)) issues.push('tags 必须是数组')
  else {
    if (naming.tags.length > 16) issues.push('tags 最多 16 个')
    for (const tag of naming.tags) if (typeof tag !== 'string' || !TAG_PATTERN.test(tag)) issues.push('非法 tag：' + String(tag))
  }
  return issues
}

/** CSS 结构问题的致命判定：字符串级（CJK/配平/空表）与解析级（MALFORMED/引号外 CJK/空表）。 */
export function fatalCssIssues(css: string): string[] {
  const issues: string[] = []
  for (const issue of cssStylesheetIssues(css)) issues.push(issue.kind + '：' + issue.message)
  const parsed = parseStylesheet(css)
  const fatal: CssParseIssue['kind'][] = ['MALFORMED', 'UNQUOTED_CJK', 'EMPTY_SHEET']
  for (const issue of parsed.issues) {
    if (fatal.includes(issue.kind)) issues.push(issue.kind + '：' + issue.message)
  }
  return issues
}

/** 包目录树哈希（确定性：排序 rel:sha256 拼接；integrity.json 若存在不参与）。 */
export async function packageTreeSha256(fs: FsLike, dir: string): Promise<string> {
  const hash = createHash('sha256')
  for (const rel of await listFiles(fs, dir)) {
    if (rel === 'integrity.json') continue
    const bytes = await fs.readFile(join(dir, rel))
    hash.update(rel + ':' + createHash('sha256').update(bytes).digest('hex') + '\n')
  }
  return hash.digest('hex')
}

/** 包内全部文件相对路径（排序，确定性）。 */
async function listFiles(fs: FsLike, dir: string): Promise<string[]> {
  const out: string[] = []
  const walk = async (current: string, prefix: string): Promise<void> => {
    for (const entry of (await fs.readdir(current)).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = prefix.length === 0 ? entry.name : prefix + '/' + entry.name
      const full = join(current, entry.name)
      if (entry.isSymbolicLink()) throw new Error('拒绝 symlink：' + full)
      if (entry.isDirectory()) await walk(full, rel)
      else out.push(rel)
    }
  }
  await walk(dir, '')
  return out.sort((a, b) => a.localeCompare(b))
}

/** Spec 字段 → 输出文件/字段 映射（build evidence）。 */
function buildMapping(spec: SkinDesignSpec, naming: SkinNaming, config: BuildConfig): BuildMappingEntry[] {
  const entries: BuildMappingEntry[] = []
  const cssBlocks: Record<string, string> = {
    shapeLanguage: '基础块 body[data-dsh-skin="<id>"]',
    backgroundStyle: '基础块 body[data-dsh-skin="<id>"]',
    headerStyle: '侧栏块 [data-slot="sidebar"]',
    sidebarStyle: '侧栏块 [data-slot="sidebar"]',
    cardStyle: '会话区块 [data-slot="conversation"] + 浮层块 [data-slot="shell.overlay"]',
    messageStyle: '会话区块 [data-slot="conversation"]',
    borderStyle: '浮层/输入/按钮块',
    shadowStyle: '浮层块 [data-slot="shell.overlay"]',
    inputStyle: '输入块 input, textarea',
    buttonStyle: '按钮块 button',
    iconStyle: '图标块 svg',
  }
  for (const [field, target] of Object.entries(cssBlocks)) {
    entries.push({ specField: field, outputFile: 'styles/theme.css', outputField: target })
  }
  entries.push({ specField: 'typography.family', outputFile: 'styles/theme.css', outputField: '基础块 font-family' })
  entries.push({ specField: 'typography.mono', outputFile: 'styles/theme.css', outputField: 'pre, code 块 font-family' })
  entries.push({ specField: 'spacing.radius', outputFile: 'styles/theme.css', outputField: 'border-radius（基础/输入/按钮块）' })
  entries.push({ specField: 'spacing.density', outputFile: '(未渲染)', outputField: '意图层：v1.3 不映射到包文件' })
  entries.push({ specField: 'customCss', outputFile: 'styles/theme.css', outputField: '顶层规则透传（scope 之外）' })
  spec.colorPalette.forEach((color, index) => {
    const token = ROLE_TOKEN[color.role]
    const target = token !== undefined ? token : '未映射角色 → 回退链（other/accent 参与回退）'
    entries.push({
      specField: 'colorPalette[' + index + ']（role=' + color.role + '）',
      outputFile: 'theme/light.json + theme/dark.json',
      outputField: target,
      note: token === undefined ? '角色无直接 token；经 pick/pickTwo 回退参与映射' : undefined,
    })
  })
  for (const role of ['bg-base', 'brand', 'label'] as const) {
    entries.push({ specField: 'colorPalette（role=' + role + '）', outputFile: 'preview/light.svg + preview/dark.svg', outputField: 'fill 色' })
  }
  entries.push({ specField: 'visualStyle', outputFile: '(未渲染)', outputField: '意图层：v1.3 不映射到包文件' })
  for (const field of ['chromeElements', 'decorativeElements', 'assetCandidates'] as const) {
    entries.push({ specField: field, outputFile: '(未渲染)', outputField: '意图层：v1.3 不映射到包文件' })
  }
  entries.push({ specField: 'naming.id', outputFile: 'manifest.json', outputField: '$.id' })
  entries.push({ specField: 'naming.name', outputFile: 'manifest.json', outputField: '$.name' })
  entries.push({ specField: 'naming.author', outputFile: 'manifest.json', outputField: '$.author' })
  entries.push({ specField: 'naming.description', outputFile: 'manifest.json', outputField: '$.description' })
  entries.push({ specField: 'naming.tags', outputFile: 'manifest.json', outputField: '$.tags' })
  entries.push({ specField: 'buildConfig.packageVersion', outputFile: 'manifest.json', outputField: '$.version' })
  entries.push({ specField: 'skinApiVersion（常量 SKIN_API_VERSION=1）', outputFile: 'manifest.json', outputField: '$.skinApiVersion' })
  return entries
}

/**
 * Spec + Config → 完整 Skin Package 目录（manifest/theme/styles/client/preview + assets）。
 * 工作区内原子落位：先写 <parent>/.<name>.build-tmp，再 rename 到 destDir（不留半成品）。
 */
export async function buildSkinPackage(
  fs: FsLike,
  destDir: string,
  spec: SkinDesignSpec,
  naming: SkinNaming,
  config: BuildConfig = DEFAULT_BUILD_CONFIG,
  evidenceRef?: BuildManifestRecord['evidenceRef'],
): Promise<PackageBuildResult> {
  const issues: string[] = []
  // 1. 命名/配置前置校验（MANIFEST_BUILD）
  const nameIssues = namingIssues(naming)
  if (nameIssues.length > 0) return { ok: false, issues: nameIssues, failureDomain: 'MANIFEST_BUILD' }
  if (typeof config.packageVersion !== 'string' || !SEMVER.test(config.packageVersion)) {
    return { ok: false, issues: ['packageVersion 非法（必须 SemVer x.y.z[-prerelease]）：' + String(config.packageVersion)], failureDomain: 'MANIFEST_BUILD' }
  }
  if (config.previewMode !== 'svg') {
    return { ok: false, issues: ['previewMode 仅支持 \'svg\'（v1.3）'], failureDomain: 'MANIFEST_BUILD' }
  }
  // 2. Spec 校验（SPEC_VALIDATION；双保险，调用方通常已校验）
  const specCheck = validateSkinDesignSpec(spec)
  if (!specCheck.ok) return { ok: false, issues: ['spec 校验失败：' + specCheck.issues.join('；')], failureDomain: 'SPEC_VALIDATION' }
  // 3. 资产路径校验（ASSET_BUILD）
  const assets = config.assets ?? {}
  for (const rel of Object.keys(assets)) {
    const assetIssues = assetPathIssues(rel)
    if (assetIssues.length > 0) return { ok: false, issues: assetIssues, failureDomain: 'ASSET_BUILD' }
    if (!(assets[rel] instanceof Uint8Array)) return { ok: false, issues: ['资产必须是 Uint8Array：' + rel], failureDomain: 'ASSET_BUILD' }
  }
  // 4. CSS 渲染 + 结构校验（CSS_VALIDATION）
  const rendered = cssFromSpecWithIssues(spec, naming.id)
  const fatalCss = fatalCssIssues(rendered.css)
  if (fatalCss.length > 0) return { ok: false, issues: fatalCss.map(i => 'CSS 校验失败（' + i + '）'), failureDomain: 'CSS_VALIDATION' }
  // 5. 输出内容（全部确定性：无时间戳/随机数/绝对路径）
  const tokens = tokensFromSpec(spec)
  const manifest = {
    id: naming.id,
    version: config.packageVersion,
    name: naming.name.trim(),
    author: naming.author.trim(),
    description: naming.description.trim(),
    tags: naming.tags,
    skinApiVersion: SKIN_API_VERSION,
    preview: { light: 'preview/light.svg', dark: 'preview/dark.svg' },
  }
  const clientJs = 'window.__ModuleLoader__.load({ id: "dsh-skin/' + naming.id + '", factory: function () { return { apply: function () {} }; } });\n'

  const pick = (role: string, fallback: string): string => spec.colorPalette.find(c => c.role === role)?.hex ?? fallback
  const bg = pick('bg-base', '#10131a')
  const brand = pick('brand', '#4d6bfe')
  const label = pick('label', '#e8f0e8')
  const writes: Array<[string, string | Uint8Array]> = [
    ['manifest.json', JSON.stringify(manifest, null, 2) + '\n'],
    ['theme/light.json', JSON.stringify(tokens.light, null, 2) + '\n'],
    ['theme/dark.json', JSON.stringify(tokens.dark, null, 2) + '\n'],
    ['styles/theme.css', rendered.css],
    ['client/index.js', clientJs],
    ['preview/light.svg', previewSvg(bg, brand, label, manifest.name)],
    ['preview/dark.svg', previewSvg(bg, brand, label, manifest.name)],
  ]
  // 6. 工作区内原子落位（tmp → rename）
  const parent = dirname(destDir)
  const tmpDir = join(parent, '.' + basename(destDir) + '.build-tmp')
  try {
    await fs.mkdir(parent, { recursive: true })
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined)
    await fs.mkdir(tmpDir, { recursive: true })
    for (const [rel, content] of writes) {
      await fs.mkdir(join(tmpDir, dirname(rel)), { recursive: true })
      await fs.writeFile(join(tmpDir, rel), content)
    }
    for (const rel of Object.keys(assets).sort((a, b) => a.localeCompare(b))) {
      await fs.mkdir(join(tmpDir, dirname(rel)), { recursive: true })
      await fs.writeFile(join(tmpDir, rel), assets[rel])
    }
    await fs.rm(destDir, { recursive: true, force: true }).catch(() => undefined)
    await fs.rename(tmpDir, destDir)
  } catch (error) {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined)
    return { ok: false, issues: ['包构建 IO 失败：' + String((error as Error).message)], failureDomain: 'PACKAGE_BUILD' }
  }
  const files = await listFiles(fs, destDir)
  const configIdentity = {
    packageVersion: config.packageVersion,
    generatorVersion: config.generatorVersion,
    previewMode: config.previewMode,
    assets: Object.keys(assets).sort((a, b) => a.localeCompare(b)).map(rel => ({ rel, sha256: sha256Of(new TextDecoder().decode(assets[rel])) })),
  }
  const buildManifest: BuildManifestRecord = {
    inputIdentity: {
      specSha256: sha256Of(JSON.stringify(spec)),
      buildConfigSha256: sha256Of(JSON.stringify(configIdentity)),
      generatorVersion: config.generatorVersion,
      packageVersion: config.packageVersion,
    },
    mapping: buildMapping(spec, naming, config),
    files,
    evidenceRef,
  }
  return { ok: true, files, buildManifest, cssIssues: rendered.issues }
}

/** 包内文本文件中的绝对路径扫描（Windows 盘符/UNC/file://）。unix 根路径刻意不检（CSS url(/…) 合法）。 */
export async function absolutePathIssues(fs: FsLike, dir: string): Promise<string[]> {
  const issues: string[] = []
  const textExt = new Set(['.json', '.css', '.js', '.mjs', '.svg', '.html', '.txt', '.md'])
  const walk = async (current: string, prefix: string): Promise<void> => {
    for (const entry of await fs.readdir(current)) {
      const rel = prefix.length === 0 ? entry.name : prefix + '/' + entry.name
      const full = join(current, entry.name)
      if (entry.isSymbolicLink()) { issues.push('symlink：' + rel); continue }
      if (entry.isDirectory()) { await walk(full, rel); continue }
      const dot = rel.lastIndexOf('.')
      if (dot < 0 || !textExt.has(rel.slice(dot).toLowerCase())) continue
      let text: string
      try {
        text = await fs.readText(full)
      } catch {
        issues.push('文本文件不可读：' + rel)
        continue
      }
      if (/file:\/\//i.test(text)) issues.push('含 file:// URL：' + rel)
      // 盘符判定排除 http://、data: 等合法前缀（前置字母/数字/冒号不视为路径起点）
      if (/(?<![a-zA-Z0-9:])[a-zA-Z]:[\\\/]/.test(text)) issues.push('含 Windows 盘符绝对路径：' + rel)
      if (/\\\\[a-zA-Z]/.test(text)) issues.push('含 UNC 路径：' + rel)
    }
  }
  await walk(dir, '')
  return issues
}

export interface PackageValidationIssue {
  path: string
  message: string
}

export type PackageValidationResult =
  | { ok: true; files: string[]; integrity: IntegrityManifest }
  | { ok: false; issues: PackageValidationIssue[] }

/**
 * 构建产物校验器（单一门）：Manifest 合法 / 结构完整 / CSS 语法 / client 形态 / preview 存在 /
 * 兼容性（skinApiVersion=1）/ 无禁文件 / 无绝对路径 / integrity 一致（存在则验证，缺失则只计算报告）。
 * 失败 ⇒ package not installable。
 */
export async function validateBuiltPackage(fs: FsLike, dir: string): Promise<PackageValidationResult> {
  const issues: PackageValidationIssue[] = []
  let manifestRaw: string
  try {
    manifestRaw = await fs.readText(join(dir, 'manifest.json'))
  } catch {
    return { ok: false, issues: [{ path: 'manifest.json', message: '无法读取' }] }
  }
  let manifest: { id: string; version: string; preview: { light?: string; dark?: string } }
  try {
    const parsed = JSON.parse(manifestRaw) as unknown
    const result = validateManifest(parsed)
    if (!result.ok) return { ok: false, issues: result.issues.map(i => ({ path: 'manifest.json ' + i.path, message: i.message })) }
    manifest = result.manifest
  } catch {
    return { ok: false, issues: [{ path: 'manifest.json', message: '不是合法 JSON' }] }
  }
  // 结构 + client 形态
  for (const rel of ['theme/light.json', 'theme/dark.json']) {
    try {
      const parsed = JSON.parse(await fs.readText(join(dir, rel))) as Record<string, unknown>
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) issues.push({ path: rel, message: '必须是 token 对象' })
      else for (const [key, value] of Object.entries(parsed)) if (typeof value !== 'string') issues.push({ path: rel, message: 'token 值必须是字符串：' + key })
    } catch {
      issues.push({ path: rel, message: '缺失或不是合法 JSON' })
    }
  }
  let css = ''
  try {
    css = await fs.readText(join(dir, 'styles/theme.css'))
  } catch {
    issues.push({ path: 'styles/theme.css', message: '无法读取' })
  }
  if (css.length > 0) {
    const fatal = fatalCssIssues(css)
    for (const message of fatal) issues.push({ path: 'styles/theme.css', message })
  } else {
    issues.push({ path: 'styles/theme.css', message: '为空' })
  }
  let clientJs = ''
  try {
    clientJs = await fs.readText(join(dir, 'client/index.js'))
  } catch {
    issues.push({ path: 'client/index.js', message: '无法读取' })
  }
  if (clientJs.length === 0) {
    issues.push({ path: 'client/index.js', message: '为空' })
  } else if (!clientJs.includes('window.__ModuleLoader__.load') || !clientJs.includes('dsh-skin/' + manifest.id)) {
    issues.push({ path: 'client/index.js', message: '缺少 ModuleLoader 注册或皮肤 id 不匹配' })
  }
  // preview 存在性（manifest.preview 声明的路径必须落盘）
  for (const mode of ['light', 'dark'] as const) {
    const rel = manifest.preview[mode]
    if (rel === undefined) continue
    try {
      const bytes = await fs.readFile(join(dir, rel))
      if (bytes.length === 0) issues.push({ path: rel, message: 'preview 文件为空' })
    } catch {
      issues.push({ path: rel, message: 'manifest.preview 声明的文件不存在' })
    }
  }
  // 禁文件/绝对路径
  const executable = await scanExecutables(fs, dir)
  for (const message of executable) issues.push({ path: '(package)', message })
  const remote = await scanRemoteUrls(fs, dir)
  for (const message of remote) issues.push({ path: '(package)', message })
  const absolute = await absolutePathIssues(fs, dir)
  for (const message of absolute) issues.push({ path: '(package)', message })
  if (issues.length > 0) return { ok: false, issues }
  // integrity：存在则验证；缺失则只计算（sealPackage 负责写入）
  let integrity: IntegrityManifest
  let integrityRaw: string | undefined
  try {
    integrityRaw = await fs.readText(join(dir, 'integrity.json'))
  } catch {
    integrityRaw = undefined
  }
  if (integrityRaw !== undefined) {
    try {
      const expected = JSON.parse(integrityRaw) as IntegrityManifest
      const check = await verifyPackage(fs, dir, expected)
      if (!check.ok) return { ok: false, issues: check.issues.map(message => ({ path: 'integrity.json', message })) }
      integrity = expected
    } catch (error) {
      return { ok: false, issues: [{ path: 'integrity.json', message: '无法解析/校验：' + String((error as Error).message) }] }
    }
  } else {
    integrity = await hashPackage(fs, dir)
  }
  const files = await listFiles(fs, dir)
  return { ok: true, files, integrity }
}

/** 封存：hashPackage（排除 integrity.json 自身）→ 写 integrity.json → 复验。幂等（同内容两次封存字节一致）。 */
export async function sealPackage(fs: FsLike, dir: string): Promise<{ ok: true; integrity: IntegrityManifest } | { ok: false; issues: string[] }> {
  try {
    const integrity = await hashPackage(fs, dir)
    await fs.writeFile(join(dir, 'integrity.json'), JSON.stringify(integrity, null, 2) + '\n')
    const check = await verifyPackage(fs, dir, integrity)
    if (!check.ok) return { ok: false, issues: ['封存后复验失败：' + check.issues.join('；')] }
    return { ok: true, integrity }
  } catch (error) {
    return { ok: false, issues: ['integrity 生成失败：' + String((error as Error).message)] }
  }
}

/**
 * 兼容薄封装（v1.0.0 既有调用形状）：spec + naming → 完整包目录；失败抛错。
 * 默认 BuildConfig（版本 0.1.0 / svg 预览）。
 */
export async function writeSkinPackage(
  fs: FsLike,
  destDir: string,
  spec: SkinDesignSpec,
  naming: SkinNaming,
): Promise<void> {
  const result = await buildSkinPackage(fs, destDir, spec, naming, DEFAULT_BUILD_CONFIG)
  if (!result.ok) throw new Error(result.issues.join('；'))
}
