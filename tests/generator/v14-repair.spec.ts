/**
 * v1.4 单元矩阵：RepairDecision schema/patch/保护路径/预算、振荡护栏、
 * 诊断层（WorstRegion 页面映射/候选字段/问题域）、metricDelta、失败域语义。
 */
import { describe, expect, it } from 'vitest'
import {
  applySpecPatch, OscillationGuard, parseSpecPath, specChangeIssues, specSha256,
  validateRepairDecision, type RepairDecision,
} from '../../src/generator/repair.ts'
import {
  buildWorstRegions, computeMetricDelta, globalIssueDomain, pageRegionOf, SPEC_RESPONSIBILITY_MAP,
  regionEvidenceFromObservation,
} from '../../src/generator/diagnosis.ts'
import type { FidelityMetrics } from '../../src/generator/fidelity.ts'
import type { SkinDesignSpec } from '../../src/core/spec.ts'
import { validateSkinDesignSpec } from '../../src/core/spec.ts'

const spec = (): SkinDesignSpec => ({
  visualStyle: 'fixture', colorPalette: [
    { hex: '#0b120b', role: 'bg-base', share: 0.5 },
    { hex: '#33ff66', role: 'brand', share: 0.3 },
    { hex: '#b8ffc8', role: 'label', share: 0.2 },
  ],
  typography: { family: 'mono', mono: 'mono' },
  spacing: { density: 'comfortable', radius: 4 },
  shapeLanguage: '', borderStyle: '', shadowStyle: '', backgroundStyle: '', headerStyle: '',
  sidebarStyle: '', messageStyle: '', inputStyle: '', buttonStyle: '', cardStyle: '', iconStyle: '',
  chromeElements: [], decorativeElements: [], assetCandidates: [],
})

const goodDecision: RepairDecision = {
  targetRegions: ['global'],
  problemAssessment: '底色偏离参考',
  specChanges: [{ path: 'colorPalette[0].hex', newValue: '#0b120b', reason: '对齐参考', targetRegion: 'global', expectedEffect: '降低 palette 偏差' }],
  confidence: 0.7,
}

describe('parseSpecPath / specChangeIssues', () => {
  it('合法路径解析 + 白名单', () => {
    expect(parseSpecPath('colorPalette[0].hex').segments).toEqual(['colorPalette', '0', 'hex'])
    expect(parseSpecPath('typography.family').segments).toEqual(['typography', 'family'])
    expect(parseSpecPath('spacing.radius').issues).toEqual([])
    expect(parseSpecPath('visualStyle').issues).toEqual([])
  })
  it('受保护/非法路径拒绝', () => {
    expect(parseSpecPath('__proto__.x').issues.length).toBeGreaterThan(0)
    expect(parseSpecPath('constructor.prototype.x').issues.length).toBeGreaterThan(0)
    expect(parseSpecPath('manifest.version').issues.length).toBeGreaterThan(0)
    expect(parseSpecPath('provenance').issues.length).toBeGreaterThan(0) // 编排层产物，非设计字段
    expect(parseSpecPath('skinApiVersion').issues.length).toBeGreaterThan(0)
    expect(parseSpecPath('colorPalette[0].hex;').issues.length).toBeGreaterThan(0)
    expect(parseSpecPath('a b.c').issues.length).toBeGreaterThan(0)
  })
  it('类型/值域按字段校验', () => {
    expect(specChangeIssues({ path: 'colorPalette[0].hex', newValue: 'red' }).length).toBeGreaterThan(0)
    expect(specChangeIssues({ path: 'colorPalette[0].hex', newValue: '#123456' })).toEqual([])
    expect(specChangeIssues({ path: 'colorPalette[0].role', newValue: 'hacker' }).length).toBeGreaterThan(0)
    expect(specChangeIssues({ path: 'colorPalette[0].share', newValue: 9 }).length).toBeGreaterThan(0)
    expect(specChangeIssues({ path: 'spacing.radius', newValue: 99 }).length).toBeGreaterThan(0)
    expect(specChangeIssues({ path: 'spacing.density', newValue: 'wide' }).length).toBeGreaterThan(0)
    expect(specChangeIssues({ path: 'visualStyle', newValue: '' }).length).toBeGreaterThan(0)
    // CSS 注入/自然语言拒绝（css-strings 层）
    expect(specChangeIssues({ path: 'backgroundStyle', newValue: 'background: red; } body { x' }).length).toBeGreaterThan(0)
    expect(specChangeIssues({ path: 'backgroundStyle', newValue: '背景换成蓝色' }).length).toBeGreaterThan(0)
    expect(specChangeIssues({ path: 'backgroundStyle', newValue: 'background: #123456;' })).toEqual([])
    // 对象/函数值拒绝
    expect(specChangeIssues({ path: 'visualStyle', newValue: { evil: 1 } }).length).toBeGreaterThan(0)
    expect(specChangeIssues({ path: 'chromeElements', newValue: [1, 2] }).length).toBeGreaterThan(0)
    expect(specChangeIssues({ path: 'chromeElements', newValue: ['a', 'b'] })).toEqual([])
  })
})

describe('validateRepairDecision', () => {
  const context = { worstRegionIds: ['cell-0-0', 'cell-1-5'] }
  it('合法决策通过并归一', () => {
    const result = validateRepairDecision(goodDecision, context)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.decision.specChanges[0].path).toBe('colorPalette[0].hex')
  })
  it('targetRegions 必须存在于最差区域集（或 global）；reason/expectedEffect 必填', () => {
    const badRegion = { ...goodDecision, targetRegions: ['nonexistent'] }
    expect(validateRepairDecision(badRegion, context).ok).toBe(false)
    const noReason = { ...goodDecision, specChanges: [{ ...goodDecision.specChanges[0], reason: '' }] }
    expect(validateRepairDecision(noReason, context).ok).toBe(false)
    const noEffect = { ...goodDecision, specChanges: [{ ...goodDecision.specChanges[0], expectedEffect: ' ' }] }
    expect(validateRepairDecision(noEffect, context).ok).toBe(false)
    const badTarget = { ...goodDecision, specChanges: [{ ...goodDecision.specChanges[0], targetRegion: 'cell-9-9' }] }
    expect(validateRepairDecision(badTarget, context).ok).toBe(false)
  })
  it('预算：超出 maxChangedFields 整条拒绝（不截断）', () => {
    const many = { ...goodDecision, specChanges: [1, 2, 3, 4, 5].map(i => ({ ...goodDecision.specChanges[0], path: 'visualStyle', newValue: 'v' + i })) }
    const result = validateRepairDecision(many, context)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.issues.join(';')).toContain('上限')
    const ok = validateRepairDecision(many, { ...context, maxChangedFields: 5 })
    expect(ok.ok).toBe(true)
  })
  it('confidence 仅 0..1 辅助信号', () => {
    expect(validateRepairDecision({ ...goodDecision, confidence: 1.5 }, context).ok).toBe(false)
    expect(validateRepairDecision({ ...goodDecision, confidence: 0.5 }, context).ok).toBe(true)
  })
})

describe('applySpecPatch / OscillationGuard', () => {
  it('结构化 patch：深拷贝 + oldValue 记录 + 后续校验通过', () => {
    const original = spec()
    const result = applySpecPatch(original, goodDecision)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.issues.join(';'))
    expect(result.spec.colorPalette[0].hex).toBe('#0b120b')
    expect(original.colorPalette[0].hex).toBe('#0b120b') // 原对象不受影响
    expect(result.changes[0].oldValue).toBe('#0b120b')
    expect(validateSkinDesignSpec(result.spec).ok).toBe(true)
  })
  it('受保护路径即使绕过校验器也在应用层拒绝（双保险）', () => {
    const evil = { targetRegions: ['global'], problemAssessment: 'x', specChanges: [{ path: '__proto__.polluted', newValue: 'x', reason: 'r', targetRegion: 'global', expectedEffect: 'e' }] }
    const result = applySpecPatch(spec(), evil)
    expect(result.ok).toBe(false)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })
  it('越界索引拒绝', () => {
    const out = { ...goodDecision, specChanges: [{ ...goodDecision.specChanges[0], path: 'colorPalette[9].hex' }] }
    expect(applySpecPatch(spec(), out).ok).toBe(false)
  })
  it('振荡护栏：重复状态 → false；新状态 → true', () => {
    const s1 = spec()
    const s2 = spec()
    const guard = new OscillationGuard([s1])
    expect(guard.add(s2)).toBe(false) // 同状态重现
    const changed = { ...s1, visualStyle: 'changed' }
    expect(guard.add(changed)).toBe(true)
    expect(guard.add({ ...changed })).toBe(false)
    expect(guard.size()).toBe(2)
    expect(specSha256(s1)).toBe(specSha256(s2))
  })
})

describe('diagnosis：WorstRegion / 页面映射 / metricDelta', () => {
  const metrics = (overrides: Partial<FidelityMetrics> = {}): FidelityMetrics => ({
    palette: { intersection: 0.6, dominantDistance: 20, referenceTop: ['#080808'], generatedTop: ['#181818'] },
    layout: { cosine: 0.95 },
    region: { meanDelta: 10, worstCell: { ratio: 30, x1: 0, y1: 0, x2: 150, y2: 90 } },
    pixel: { diffRatio: 0.1, threshold: 16 },
    structure: { nonBlank: true },
    ...overrides,
  })
  it('全局问题域：palette/layout 显著偏离才标注，否则 UNKNOWN（不伪造）', () => {
    expect(globalIssueDomain(metrics({ palette: { ...metrics().palette, intersection: 0.2 } }))).toBe('PALETTE')
    expect(globalIssueDomain(metrics({ layout: { cosine: 0.5 } }))).toBe('LAYOUT')
    expect(globalIssueDomain(metrics())).toBe('UNKNOWN')
  })
  it('页面区域几何映射（壳 mock 固定布局）', () => {
    expect(pageRegionOf({ x1: 0, y1: 0, x2: 150, y2: 90 })).toBe('sidebar')
    expect(pageRegionOf({ x1: 900, y1: 20, x2: 1050, y2: 110 })).toBe('overlay')
    expect(pageRegionOf({ x1: 300, y1: 540, x2: 450, y2: 630 })).toBe('input')
    expect(pageRegionOf({ x1: 300, y1: 200, x2: 450, y2: 290 })).toBe('conversation')
    expect(SPEC_RESPONSIBILITY_MAP.sidebar).toContain('sidebarStyle')
    expect(SPEC_RESPONSIBILITY_MAP.input).toContain('buttonStyle')
  })
  it('buildWorstRegions：id/rank/指标归属/候选字段 + 坐标一致', () => {
    const ref = { width: 1200, height: 720, data: new Uint8Array(1200 * 720 * 4).fill(10) }
    const shot = ref.data.slice()
    const shotBuf = new Uint8Array(1200 * 720 * 4)
    for (let i = 0; i < shotBuf.length; i += 4) {
      shotBuf[i] = 200
      shotBuf[i + 1] = 200
      shotBuf[i + 2] = 200
      shotBuf[i + 3] = 255
    }
    void shot
    const { regions, issues } = buildWorstRegions(ref, { width: 1200, height: 720, data: shotBuf }, metrics())
    expect(issues.length).toBe(0)
    expect(regions.length).toBeGreaterThan(0)
    expect(regions[0].id).toMatch(/^cell-\d+-\d+$/)
    expect(regions[0].rank).toBe(1)
    expect(regions[0].bbox.x1).toBeGreaterThanOrEqual(0)
    expect(regions[0].bbox.x2).toBeLessThanOrEqual(1200)
    expect(regions[0].candidateSpecFields.length).toBeGreaterThan(0)
  })
  it('metricDelta：距离类增量方向正确 + 结构变化标注', () => {
    const prev = metrics()
    const next = metrics({ region: { meanDelta: 2, worstCell: prev.region.worstCell }, pixel: { diffRatio: 0.02, threshold: 16 } })
    const delta = computeMetricDelta(prev, next)
    expect(delta.regionMeanDelta).toBe(-8)
    expect(delta.pixelDiffRatio).toBeCloseTo(-0.08)
    expect(delta.structureNonBlank).toBe('stable')
    const broken = computeMetricDelta(prev, { ...next, structure: { nonBlank: false } })
    expect(broken.structureNonBlank).toBe('true->false')
  })
  it('regionEvidenceFromObservation：归一化 + provenance 保留（V2/V3）', () => {
    const evidence = regionEvidenceFromObservation(
      { summary: 's', layout: [{ region: 'r', content: 'shape' }], entities: [], colors: [{ hex: '#AABBCC', share: 0.5 }], text: 't', source: { kind: 'vision-json', provider: 'vision-http', model: 'm' }, colorSource: 'vision' },
      { id: 'cell-0-0', bbox: { x1: 0, y1: 0, x2: 150, y2: 90 } },
      { imageKey: 'k', provider: 'vision-http', model: 'm', analysisVersion: 'v2' },
    )
    expect(evidence.regionId).toBe('cell-0-0')
    expect(evidence.colors[0].hex).toBe('#aabbcc')
    expect(evidence.shape).toBe('shape')
    expect(evidence.source?.provider).toBe('vision-http')
    expect(evidence.provenance.imageKey).toBe('k')
    expect(evidence.degraded).toBe(false)
  })
})
