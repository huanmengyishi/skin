import { describe, expect, it } from 'vitest'
import { checkEvidenceConsistency } from '../../src/generator/provenance'
import { validateSkinDesignSpec } from '../../src/core/spec'
import type { SkinDesignSpec } from '../../src/core/spec'
import type { VisionEvidence } from '../../src/generator/vision'

function specWith(colors: Array<{ hex: string; role: string; share: number }>, radiusNote?: boolean): SkinDesignSpec {
  return {
    visualStyle: 'x',
    colorPalette: colors,
    typography: { family: 'mono', mono: 'mono' },
    spacing: { density: 'comfortable', radius: 4 },
    shapeLanguage: radiusNote === true ? '圆润的' : 'border-radius: 4px;',
    borderStyle: '', shadowStyle: '', backgroundStyle: '', headerStyle: '',
    sidebarStyle: '', messageStyle: '', inputStyle: '', buttonStyle: '', cardStyle: '', iconStyle: '',
    chromeElements: [], decorativeElements: [], assetCandidates: [],
  }
}

const darkBlue: VisionEvidence = { summary: '深蓝', layout: [], entities: [], colors: [{ hex: '#10243a', share: 0.7 }], text: '', colorSource: 'vision' }

describe('v1.2 Evidence Consistency 矩阵（§35 Case 1~6）', () => {
  it('Case1：兼容 Spec → PASS；Case2：深蓝证据 + 更深蓝 → PASS', () => {
    expect(checkEvidenceConsistency(specWith([{ hex: '#10243a', role: 'bg-base', share: 0.5 }]), darkBlue).issues).toEqual([])
    expect(checkEvidenceConsistency(specWith([{ hex: '#0a1a2c', role: 'bg-base', share: 0.5 }]), darkBlue).issues).toEqual([])
  })

  it('Case3：证据深蓝 + 亮粉主色 → WARN（记录不 REJECT）', () => {
    const result = checkEvidenceConsistency(specWith([{ hex: '#ff69b4', role: 'bg-base', share: 0.5 }]), darkBlue)
    expect(result.compatible).toBe(true)
    expect(result.issues.some(i => i.severity === 'WARN' && i.field === 'colorPalette')).toBe(true)
  })

  it('Case4：证据无颜色 → WARN 要求显式 fallback 标注', () => {
    const noColor: VisionEvidence = { ...darkBlue, colors: [], colorSource: 'none' }
    const result = checkEvidenceConsistency(specWith([{ hex: '#10243a', role: 'bg-base', share: 0.5 }]), noColor)
    expect(result.issues.some(i => i.message.includes('fallback'))).toBe(true)
  })

  it('Case5：圆角数字 CSS → PASS；Case6：圆角自然语言 → REJECT（Q3 字段感知）', () => {
    expect(validateSkinDesignSpec(specWith([{ hex: '#10243a', role: 'bg-base', share: 0.5 }])).ok).toBe(true)
    const rejected = validateSkinDesignSpec(specWith([{ hex: '#10243a', role: 'bg-base', share: 0.5 }], true))
    expect(rejected.ok).toBe(false)
  })
})

