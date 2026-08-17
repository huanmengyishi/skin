import { describe, expect, it } from 'vitest'
import { buildSpecProvenance } from '../../src/generator/provenance'
import type { SkinDesignSpec } from '../../src/core/spec'
import type { VisionEvidence } from '../../src/generator/vision'

function spec(): SkinDesignSpec {
  return {
    visualStyle: '夜',
    colorPalette: [{ hex: '#1a1a2e', role: 'bg-base', share: 0.5 }, { hex: '#ff00ff', role: 'brand', share: 0.2 }],
    typography: { family: 'mono', mono: 'mono' },
    spacing: { density: 'comfortable', radius: 4 },
    shapeLanguage: '', borderStyle: '', shadowStyle: '', backgroundStyle: '', headerStyle: '',
    sidebarStyle: '', messageStyle: '', inputStyle: '', buttonStyle: '', cardStyle: '', iconStyle: '',
    chromeElements: [], decorativeElements: [], assetCandidates: [],
  }
}

function evidence(): VisionEvidence {
  return { summary: '深蓝夜', layout: [], entities: [], colors: [{ hex: '#1a1a2e', share: 0.6 }], text: '', source: { kind: 'vision-json' }, colorSource: 'vision' }
}

describe('v1.2 Provenance（逐字段来源 + 可追踪）', () => {
  it('颜色匹配证据 → vision/local-quantization + ref；偏离 → model-design 标注', () => {
    const prov = buildSpecProvenance(spec(), evidence(), { imageKey: 'k', provider: 'vision-http', model: 'm', analysisVersion: 'v2' })
    expect(prov.fields['colorPalette[0]'].source).toBe('vision')
    expect(prov.fields['colorPalette[0]'].ref).toContain('evidence.colors[0]')
    expect(prov.fields['colorPalette[1]'].source).toBe('model-design')
    expect(prov.fields['colorPalette[1]'].note).toContain('偏离')
    expect(prov.evidenceRef.imageKey).toBe('k')
    expect(prov.fields['visualStyle'].source).toBe('model-design')
    expect(prov.fields['backgroundStyle'].source).toBe('model-design')
  })

  it('local-quantization 来源正确标注；禁止全字段统一 vision', () => {
    const ev = { ...evidence(), colorSource: 'local-quantization' as const }
    const prov = buildSpecProvenance(spec(), ev, {})
    expect(prov.fields['colorPalette[0]'].source).toBe('local-quantization')
    const sources = new Set(Object.values(prov.fields).map(f => f.source))
    expect(sources.size).toBeGreaterThan(1)
  })
})

