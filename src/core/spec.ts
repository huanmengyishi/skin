/**
 * SkinDesignSpec：视觉证据 → 结构化设计规格（AI 生成阶段的领域契约）。
 * 视觉模型输出绝不直接拼代码；spec 是 Vision Evidence 与 Code Generation 之间
 * 唯一可校验、可缓存、可 diff 的中间层。
 * @module dsh-skin/src/core/spec
 */

export interface SpecColor {
  /** #RRGGBB */
  hex: string
  /** 语义角色：bg-base / bg-layer / border / brand / label / label-secondary / accent … */
  role: string
  /** 视觉占比 0..1（vision_colors share 或模型估计） */
  share: number
}

/** 逐字段来源（v1.2 provenance；不在 DeepSeek 输出中，由编排层构建）。 */
export type SpecFieldSource = 'vision' | 'local-quantization' | 'model-design' | 'fallback'

export interface SpecFieldProvenance {
  source: SpecFieldSource
  /** 指向 VisionEvidence 的引用（如 evidence.colors[0] / layout[1]）。 */
  ref?: string
  /** 设计解释（偏离证据时的说明）。 */
  note?: string
}

export interface SpecProvenance {
  fields: Record<string, SpecFieldProvenance>
  evidenceRef: { imageKey?: string; provider?: string; model?: string; analysisVersion?: string }
  interpretation: string[]
}

export interface SkinDesignSpec {
  /** 一句话风格描述（terminal / glass / retro …） */
  visualStyle: string
  colorPalette: SpecColor[]
  typography: { family: string; mono: string }
  spacing: { density: 'compact' | 'comfortable' | 'spacious'; radius: number }
  shapeLanguage: string
  borderStyle: string
  shadowStyle: string
  backgroundStyle: string
  headerStyle: string
  sidebarStyle: string
  messageStyle: string
  inputStyle: string
  buttonStyle: string
  cardStyle: string
  iconStyle: string
  /** 期望的 chrome 元素（仅记录意图，渲染由模板决定） */
  chromeElements: string[]
  /** 装饰元素意图（同上） */
  decorativeElements: string[]
  /** 可矢量化的资产候选（logo/纹理等） */
  assetCandidates: string[]
  /** 模型可选的附加 CSS 规则（会被作用域包裹后拼入 styles/theme.css） */
  customCss?: string
  /** v1.2：逐字段来源与设计解释（编排层构建，非模型输出）。 */
  provenance?: SpecProvenance
}

import { cssFragmentIssues, fontFamilyIssues } from './css-strings.ts'

export type SpecResult = { ok: true; spec: SkinDesignSpec } | { ok: false; issues: string[] }

const HEX = /^#[0-9a-fA-F]{6}$/
const ROLES = new Set(['bg-base', 'bg-layer', 'border', 'brand', 'label', 'label-secondary', 'accent', 'other'])

/** 校验未知 JSON 是否为合法 SkinDesignSpec（AI 产出必须过此门）。 */
export function validateSkinDesignSpec(value: unknown): SpecResult {
  const issues: string[] = []
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ok: false, issues: ['spec 必须是 JSON 对象'] }
  const raw = value as Record<string, unknown>

  if (typeof raw.visualStyle !== 'string' || raw.visualStyle.trim().length === 0) issues.push('visualStyle 必须是非空字符串')
  const palette = raw.colorPalette
  if (!Array.isArray(palette) || palette.length === 0) issues.push('colorPalette 必须是非空数组')
  else {
    palette.forEach((entry, index) => {
      if (typeof entry !== 'object' || entry === null) { issues.push('colorPalette[' + index + '] 必须是对象'); return }
      const color = entry as Record<string, unknown>
      if (typeof color.hex !== 'string' || !HEX.test(color.hex)) issues.push('colorPalette[' + index + '].hex 必须是 #RRGGBB')
      if (typeof color.role !== 'string' || !ROLES.has(color.role)) issues.push('colorPalette[' + index + '].role 非法（' + String(color.role) + '）')
      if (typeof color.share !== 'number' || color.share < 0 || color.share > 1) issues.push('colorPalette[' + index + '].share 必须是 0..1')
    })
  }
  const typography = raw.typography as Record<string, unknown> | undefined
  if (typeof typography !== 'object' || typography === null) issues.push('typography 必须是对象')
  else {
    if (typeof typography.family !== 'string' || typography.family.length === 0) issues.push('typography.family 必须是非空字符串')
    else for (const issue of fontFamilyIssues(typography.family)) issues.push('typography.family 非法（' + issue.kind + '）：' + issue.message)
    if (typeof typography.mono !== 'string' || typography.mono.length === 0) issues.push('typography.mono 必须是非空字符串')
    else for (const issue of fontFamilyIssues(typography.mono)) issues.push('typography.mono 非法（' + issue.kind + '）：' + issue.message)
  }
  const spacing = raw.spacing as Record<string, unknown> | undefined
  if (typeof spacing !== 'object' || spacing === null) issues.push('spacing 必须是对象')
  else {
    if (!['compact', 'comfortable', 'spacious'].includes(String(spacing.density))) issues.push('spacing.density 非法')
    if (typeof spacing.radius !== 'number' || spacing.radius < 0 || spacing.radius > 32) issues.push('spacing.radius 必须是 0..32')
  }
  for (const field of ['shapeLanguage', 'borderStyle', 'shadowStyle', 'backgroundStyle', 'headerStyle', 'sidebarStyle', 'messageStyle', 'inputStyle', 'buttonStyle', 'cardStyle', 'iconStyle'] as const) {
    if (typeof raw[field] !== 'string') { issues.push(field + ' 必须是字符串'); continue }
    // Q3 字段感知校验：机器 CSS 字段不得携带自然语言泄漏（引号内 CJK 字体名等合法结构除外）；空串=无样式，跳过
    if (String(raw[field]).trim().length === 0) continue
    for (const issue of cssFragmentIssues(String(raw[field]))) {
      issues.push(field + ' 含非法内容（' + issue.kind + '）：' + issue.message)
    }
  }
  for (const field of ['chromeElements', 'decorativeElements', 'assetCandidates'] as const) {
    if (!Array.isArray(raw[field])) issues.push(field + ' 必须是数组')
  }
  if (raw.customCss !== undefined && typeof raw.customCss !== 'string') issues.push('customCss 必须是字符串')
  // provenance：可选；存在则必须是对象（字段逐项校验，来源枚举合法）
  if (raw.provenance !== undefined) {
    const prov = raw.provenance as Record<string, unknown> | null
    if (typeof prov !== 'object' || prov === null || Array.isArray(prov)) issues.push('provenance 必须是对象')
    else {
      if (!Array.isArray(prov.interpretation)) issues.push('provenance.interpretation 必须是数组')
      if (typeof prov.fields !== 'object' || prov.fields === null || Array.isArray(prov.fields)) issues.push('provenance.fields 必须是对象')
    }
  }
  else if (typeof raw.customCss === 'string' && raw.customCss.trim().length > 0) {
    for (const issue of cssFragmentIssues(raw.customCss, { allowRules: true })) {
      issues.push('customCss 含非法内容（' + issue.kind + '）：' + issue.message)
    }
  }

  if (issues.length > 0) return { ok: false, issues }
  return {
    ok: true,
    spec: {
      visualStyle: String(raw.visualStyle),
      colorPalette: (palette as unknown[]).map(entry => {
        const c = entry as Record<string, unknown>
        return { hex: String(c.hex).toLowerCase(), role: String(c.role), share: Number(c.share) }
      }),
      typography: { family: String(typography!.family), mono: String(typography!.mono) },
      spacing: { density: spacing!.density as SkinDesignSpec['spacing']['density'], radius: Number(spacing!.radius) },
      shapeLanguage: String(raw.shapeLanguage),
      borderStyle: String(raw.borderStyle),
      shadowStyle: String(raw.shadowStyle),
      backgroundStyle: String(raw.backgroundStyle),
      headerStyle: String(raw.headerStyle),
      sidebarStyle: String(raw.sidebarStyle),
      messageStyle: String(raw.messageStyle),
      inputStyle: String(raw.inputStyle),
      buttonStyle: String(raw.buttonStyle),
      cardStyle: String(raw.cardStyle),
      iconStyle: String(raw.iconStyle),
      chromeElements: [...(raw.chromeElements as unknown[])].map(String),
      decorativeElements: [...(raw.decorativeElements as unknown[])].map(String),
      assetCandidates: [...(raw.assetCandidates as unknown[])].map(String),
      customCss: raw.customCss === undefined ? undefined : String(raw.customCss),
      provenance: raw.provenance === undefined ? undefined : (raw.provenance as SpecProvenance),
    },
  }
}

/** 名称 → 皮肤 ID 建议（仅保留 [a-z0-9-]；空结果回退 'skin'）。用户可修改，唯一性由仓库校验。 */
export function slugifySkinId(input: string): string {
  const slug = input.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63)
  return slug.length > 0 ? slug : 'skin'
}
