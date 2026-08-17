/**
 * v1.2 Provenance 与 Evidence Consistency：
 * - buildSpecProvenance：把每个 Spec 字段标注来源（vision/local-quantization/model-design/fallback）；
 *   颜色字段经最近邻匹配指向 evidence.colors；其余设计字段 = model-design（DeepSeek 解释）。
 * - checkEvidenceConsistency：兼容性判定（不要求相等）：
 *   全色偏离超阈值 → WARN（记录，不 REJECT）；合法 hex 已由 spec 校验保证。
 * 策略：Vision 事实 vs 设计决策分层；偏差显式记录为 interpretation/deviation，不静默通过。
 * @module dsh-skin/src/generator/provenance
 */

import type { SkinDesignSpec, SpecProvenance, SpecFieldProvenance } from '../core/spec.ts'
import type { VisionEvidence } from './vision.ts'

export interface ConsistencyIssue {
  severity: 'WARN' | 'REJECT'
  field: string
  message: string
}

export interface ConsistencyResult {
  compatible: boolean
  issues: ConsistencyIssue[]
}

function hexToRgb(hex: string): [number, number, number] {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)]
}

function colorDistance(a: string, b: string): number {
  const [r1, g1, b1] = hexToRgb(a)
  const [r2, g2, b2] = hexToRgb(b)
  return Math.sqrt((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2)
}

/** 全色偏离阈值：所有 spec 颜色距最近证据色都超过该距离 → 记录 WARN（兼容性策略，非僵化相等）。 */
export const CONSISTENCY_WARN_DISTANCE = 120

export function checkEvidenceConsistency(spec: SkinDesignSpec, evidence: VisionEvidence): ConsistencyResult {
  const issues: ConsistencyIssue[] = []
  const evidenceColors = evidence.colors ?? []
  if (evidenceColors.length === 0) {
    issues.push({ severity: 'WARN', field: 'colorPalette', message: '证据无颜色（colorSource=' + String(evidence.colorSource ?? 'none') + '）；spec 颜色来源需显式 fallback 标注' })
    return { compatible: true, issues }
  }
  let allDeviate = true
  for (const color of spec.colorPalette) {
    const nearest = Math.min(...evidenceColors.map(e => colorDistance(color.hex, e.hex)))
    if (nearest <= CONSISTENCY_WARN_DISTANCE) { allDeviate = false; break }
  }
  if (allDeviate) {
    issues.push({
      severity: 'WARN',
      field: 'colorPalette',
      message: '全部 spec 颜色与证据色距离 > ' + CONSISTENCY_WARN_DISTANCE + '（设计偏离，需 interpretation 说明）',
    })
  }
  return { compatible: true, issues }
}

export function buildSpecProvenance(spec: SkinDesignSpec, evidence: VisionEvidence, meta: { imageKey?: string; provider?: string; model?: string; analysisVersion?: string }): SpecProvenance {
  const fields: Record<string, SpecFieldProvenance> = {}
  const evidenceColors = evidence.colors ?? []
  // 颜色字段：最近邻匹配证据色（≤WARN 距离 → vision/local-quantization + ref；否则 model-design 偏离标注）
  spec.colorPalette.forEach((color, index) => {
    let bestIdx = -1
    let best = Number.POSITIVE_INFINITY
    evidenceColors.forEach((entry, i) => {
      const d = colorDistance(color.hex, entry.hex)
      if (d < best) { best = d; bestIdx = i }
    })
    if (bestIdx >= 0 && best <= CONSISTENCY_WARN_DISTANCE) {
      fields['colorPalette[' + index + ']'] = {
        source: evidence.colorSource === 'local-quantization' ? 'local-quantization' : 'vision',
        ref: 'evidence.colors[' + bestIdx + ']（距离 ' + Math.round(best) + '）',
      }
    } else {
      fields['colorPalette[' + index + ']'] = { source: 'model-design', note: '偏离证据色（最近距离 ' + (Number.isFinite(best) ? Math.round(best) : '∞') + '）' }
    }
  })
  // 事实引用字段（DeepSeek 只应解释，不应新造事实；标注其证据来源）
  fields['visualStyle'] = { source: 'model-design', note: '对 evidence.summary/layout 的设计解释' }
  for (const field of ['shapeLanguage', 'borderStyle', 'shadowStyle', 'backgroundStyle', 'headerStyle', 'sidebarStyle', 'messageStyle', 'inputStyle', 'buttonStyle', 'cardStyle', 'iconStyle', 'customCss'] as const) {
    fields[field] = { source: 'model-design', note: '设计决策（CSS），依据 evidence.summary/layout' }
  }
  fields['typography'] = { source: 'model-design', note: '设计决策（字体），依据 evidence.summary' }
  fields['spacing'] = { source: 'model-design', note: '设计决策（间距/圆角），依据 evidence.summary' }
  fields['decorativeElements'] = { source: 'model-design', note: '装饰意图，可对照 evidence.entities' }
  fields['assetCandidates'] = { source: 'model-design', note: '资产候选意图' }
  fields['chromeElements'] = { source: 'model-design', note: 'chrome 意图' }
  return { fields, evidenceRef: { ...meta }, interpretation: [] }
}

