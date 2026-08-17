/**
 * v1.4 RepairDecision：结构化修复决策（DeepSeek 输出）→ 校验 → Spec Patch。
 * - 决策 = 设计决策（与 v1.2 Evidence/Decision 分层一致）；机器执行面只有 specChanges[]。
 * - 白名单：仅 SkinDesignSpec 设计字段；受保护（provenance/包身份/仓库/运行时元数据）不在白名单即拒绝。
 * - 安全：路径段阻断 __proto__/constructor/prototype；newValue 只允许标量/字符串数组；CSS 经 css-strings 层校验。
 * - 预算：maxChangedFieldsPerIteration（默认 4）；超出=整条拒绝，不静默截断。
 * @module dsh-skin/src/generator/repair
 */

import { createHash } from 'node:crypto'
import { cssFragmentIssues, fontFamilyIssues } from '../core/css-strings.ts'
import type { SkinDesignSpec } from '../core/spec.ts'

export interface SpecChange {
  path: string
  newValue: unknown
  reason: string
  targetRegion: string
  expectedEffect: string
}

export interface RepairDecision {
  targetRegions: string[]
  problemAssessment: string
  specChanges: SpecChange[]
  confidence?: number
}

export type RepairDecisionResult = { ok: true; decision: RepairDecision } | { ok: false; issues: string[] }

/** 可写路径白名单（SkinDesignSpec 设计字段）。 */
const ALLOWED_TOP = new Set([
  'colorPalette', 'typography', 'spacing',
  'shapeLanguage', 'borderStyle', 'shadowStyle', 'backgroundStyle', 'headerStyle', 'sidebarStyle',
  'messageStyle', 'inputStyle', 'buttonStyle', 'cardStyle', 'iconStyle',
  'customCss', 'visualStyle', 'chromeElements', 'decorativeElements', 'assetCandidates',
])

const CSS_FIELDS = new Set(['shapeLanguage', 'borderStyle', 'shadowStyle', 'backgroundStyle', 'headerStyle', 'sidebarStyle', 'messageStyle', 'inputStyle', 'buttonStyle', 'cardStyle', 'iconStyle'])
const ARRAY_FIELDS = new Set(['chromeElements', 'decorativeElements', 'assetCandidates'])
const ROLES = new Set(['bg-base', 'bg-layer', 'border', 'brand', 'label', 'label-secondary', 'accent', 'other'])
const DENSITIES = new Set(['compact', 'comfortable', 'spacious'])
const HEX = /^#[0-9a-fA-F]{6}$/
const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype'])

/** path → 段序列（支持 colorPalette[0].hex；数组字段整体替换用顶层名）。 */
export function parseSpecPath(path: string): { segments: string[]; issues: string[] } {
  const issues: string[] = []
  if (typeof path !== 'string' || path.trim().length === 0) return { segments: [], issues: ['path 必须是非空字符串'] }
  if (/['"\s]/.test(path)) return { segments: [], issues: ['path 含非法字符（引号/空白/反斜杠）：' + path] }
  const segments: string[] = []
  for (const part of path.split('.')) {
    const match = /^([a-zA-Z][a-zA-Z0-9]*)(\[(\d+)\])?$/.exec(part)
    if (match === null) return { segments: [], issues: ['path 段非法：' + part] }
    if (FORBIDDEN_SEGMENTS.has(match[1])) return { segments: [], issues: ['path 含受保护段：' + match[1]] }
    segments.push(match[1])
    if (match[2] !== undefined) segments.push(match[3])
  }
  if (segments.length === 0) return { segments: [], issues: ['path 为空'] }
  if (!ALLOWED_TOP.has(segments[0])) return { segments: [], issues: ['path 不在设计字段白名单：' + segments[0] + '（受保护/非设计字段禁止修改）'] }
  return { segments, issues }
}

/** 单条 SpecChange 的类型/值域校验（按字段复用 css-strings/spec 规则）。 */
export function specChangeIssues(change: { path: string; newValue: unknown }): string[] {
  const issues: string[] = []
  const parsed = parseSpecPath(change.path)
  if (parsed.issues.length > 0) return parsed.issues
  const segments = parsed.segments
  const top = segments[0]
  const value = change.newValue
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) return ['newValue 必须是标量或字符串数组（禁止对象/函数/代码）']
  if (top === 'colorPalette') {
    if (segments.length !== 3) return ['colorPalette 路径必须形如 colorPalette[i].hex/role/share']
    const field = segments[2]
    if (field === 'hex') { if (typeof value !== 'string' || !HEX.test(value)) issues.push('colorPalette[i].hex 必须是 #RRGGBB：' + String(value)) }
    else if (field === 'role') { if (typeof value !== 'string' || !ROLES.has(value)) issues.push('colorPalette[i].role 必须是合法角色：' + String(value)) }
    else if (field === 'share') { if (typeof value !== 'number' || value < 0 || value > 1) issues.push('colorPalette[i].share 必须是 0..1：' + String(value)) }
    else issues.push('colorPalette 未知子字段：' + field)
  } else if (top === 'typography') {
    if (segments.length !== 2) return ['typography 路径必须形如 typography.family/mono']
    if (typeof value !== 'string') return ['typography 值必须是字符串']
    if (value.trim().length === 0) issues.push('typography 值不能为空')
    else issues.push(...fontFamilyIssues(value).map(i => 'typography 非法（' + i.kind + '）：' + i.message))
  } else if (top === 'spacing') {
    if (segments.length !== 2) return ['spacing 路径必须形如 spacing.density/radius']
    if (segments[1] === 'density') { if (typeof value !== 'string' || !DENSITIES.has(value)) issues.push('spacing.density 非法：' + String(value)) }
    else if (segments[1] === 'radius') { if (typeof value !== 'number' || value < 0 || value > 32) issues.push('spacing.radius 必须是 0..32') }
    else issues.push('spacing 未知子字段：' + segments[1])
  } else if (CSS_FIELDS.has(top) || top === 'customCss') {
    if (segments.length !== 1) return [top + ' 是叶子字段']
    if (typeof value !== 'string') return [top + ' 必须是字符串']
    if (value.trim().length > 0) {
      issues.push(...cssFragmentIssues(value, { allowRules: top === 'customCss' }).map(i => top + ' 非法（' + i.kind + '）：' + i.message))
    }
  } else if (top === 'visualStyle') {
    if (segments.length !== 1) return ['visualStyle 是叶子字段']
    if (typeof value !== 'string' || value.trim().length === 0) issues.push('visualStyle 必须是非空字符串')
  } else if (ARRAY_FIELDS.has(top)) {
    if (segments.length !== 1) return [top + ' 是数组叶子字段（整体替换）']
    if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) issues.push(top + ' 必须是字符串数组')
  }
  return issues
}

/** RepairDecision 校验（P4/P5）：targetRegions 存在性、reason/expectedEffect、预算、confidence。 */
export function validateRepairDecision(
  value: unknown,
  context: { worstRegionIds: string[]; maxChangedFields?: number },
): RepairDecisionResult {
  const issues: string[] = []
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ok: false, issues: ['repair decision 必须是 JSON 对象'] }
  const raw = value as Record<string, unknown>
  const maxChangedFields = context.maxChangedFields ?? 4
  if (!Array.isArray(raw.targetRegions) || raw.targetRegions.length === 0 || raw.targetRegions.some(r => typeof r !== 'string')) {
    issues.push('targetRegions 必须是非空字符串数组')
  } else {
    const allowed = new Set([...context.worstRegionIds, 'global'])
    for (const region of raw.targetRegions as string[]) {
      if (!allowed.has(region)) issues.push('targetRegion 不存在于最差区域集：' + region)
    }
  }
  if (typeof raw.problemAssessment !== 'string' || raw.problemAssessment.trim().length === 0) issues.push('problemAssessment 必填非空')
  if (!Array.isArray(raw.specChanges) || raw.specChanges.length === 0) issues.push('specChanges 必须是非空数组')
  else {
    const changes = raw.specChanges as Array<Record<string, unknown>>
    if (changes.length > maxChangedFields) issues.push('specChanges 超出每轮修改上限（' + maxChangedFields + '），整条拒绝（不截断）')
    const targetSet = new Set((raw.targetRegions as string[] | undefined) ?? [])
    changes.forEach((change, index) => {
      const path = change.path
      const parsed = typeof path === 'string' ? parseSpecPath(path) : { segments: [], issues: ['path 必须是非空字符串'] }
      if (parsed.issues.length > 0) { issues.push('specChanges[' + index + '] ' + parsed.issues[0]); return }
      issues.push(...specChangeIssues({ path: String(path), newValue: change.newValue }).map(i => 'specChanges[' + index + '] ' + i))
      if (typeof change.reason !== 'string' || change.reason.trim().length === 0) issues.push('specChanges[' + index + '].reason 必填非空')
      if (typeof change.expectedEffect !== 'string' || change.expectedEffect.trim().length === 0) issues.push('specChanges[' + index + '].expectedEffect 必填非空')
      if (typeof change.targetRegion !== 'string' || !(targetSet.has(change.targetRegion) || change.targetRegion === 'global')) {
        issues.push('specChanges[' + index + '].targetRegion 必须是 targetRegions 之一或 global')
      }
    })
  }
  if (raw.confidence !== undefined && (typeof raw.confidence !== 'number' || raw.confidence < 0 || raw.confidence > 1)) issues.push('confidence 必须是 0..1（仅辅助信号）')
  if (issues.length > 0) return { ok: false, issues }
  return {
    ok: true,
    decision: {
      targetRegions: [...(raw.targetRegions as string[])],
      problemAssessment: String(raw.problemAssessment),
      specChanges: (raw.specChanges as Array<Record<string, unknown>>).map(change => ({
        path: String(change.path),
        newValue: change.newValue,
        reason: String(change.reason),
        targetRegion: String(change.targetRegion),
        expectedEffect: String(change.expectedEffect),
      })),
      confidence: raw.confidence === undefined ? undefined : Number(raw.confidence),
    },
  }
}

export interface AppliedChange {
  path: string
  oldValue: unknown
  newValue: unknown
  reason: string
  targetRegion: string
  expectedEffect: string
}

export type SpecPatchResult = { ok: true; spec: SkinDesignSpec; changes: AppliedChange[] } | { ok: false; issues: string[] }

/** 结构化 patch：深拷贝 spec，按序写 newValue；路径越界/受保护 → 拒绝（校验器双保险）。 */
export function applySpecPatch(spec: SkinDesignSpec, decision: RepairDecision): SpecPatchResult {
  const issues: string[] = []
  const next = JSON.parse(JSON.stringify(spec)) as SkinDesignSpec
  const changes: AppliedChange[] = []
  for (const change of decision.specChanges) {
    const parsed = parseSpecPath(change.path)
    if (parsed.issues.length > 0) return { ok: false, issues: parsed.issues }
    const valueIssues = specChangeIssues({ path: change.path, newValue: change.newValue })
    if (valueIssues.length > 0) return { ok: false, issues: valueIssues }
    const segments = parsed.segments
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let cursor: any = next
    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i]
      const nextSeg = segments[i + 1]
      if (/^\d+$/.test(nextSeg)) {
        const arr = cursor[seg] as unknown[]
        if (!Array.isArray(arr) || Number(nextSeg) >= arr.length) return { ok: false, issues: ['path 越界：' + change.path] }
        cursor = arr[Number(nextSeg)]
        i += 1
      } else {
        if (typeof cursor[seg] !== 'object' || cursor[seg] === null) return { ok: false, issues: ['path 不存在：' + change.path] }
        cursor = cursor[seg]
      }
    }
    const last = segments[segments.length - 1]
    const oldValue = cursor[last]
    cursor[last] = change.newValue
    changes.push({ path: change.path, oldValue, newValue: change.newValue, reason: change.reason, targetRegion: change.targetRegion, expectedEffect: change.expectedEffect })
  }
  return { ok: true, spec: next, changes }
}

/** Spec 状态哈希（振荡检测）。 */
export function specSha256(spec: SkinDesignSpec): string {
  return createHash('sha256').update(JSON.stringify(spec)).digest('hex')
}

/** 振荡护栏：已见状态集合；重复出现 → false（触发 OSCILLATION）。 */
export class OscillationGuard {
  private readonly seen = new Set<string>()
  constructor(initial?: SkinDesignSpec[]) {
    for (const spec of initial ?? []) this.seen.add(specSha256(spec))
  }
  /** 返回 false = 该状态此前已出现（振荡）。 */
  add(spec: SkinDesignSpec): boolean {
    const hash = specSha256(spec)
    if (this.seen.has(hash)) return false
    this.seen.add(hash)
    return true
  }
  size(): number {
    return this.seen.size
  }
}
