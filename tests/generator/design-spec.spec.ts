import { describe, expect, it } from 'vitest'
import { validateSkinDesignSpec } from '../../src/core/spec'

function base(): Record<string, unknown> {
  return {
    visualStyle: 'test',
    colorPalette: [{ hex: '#0b120b', role: 'bg-base', share: 0.5 }],
    typography: { family: 'mono', mono: 'mono' },
    spacing: { density: 'comfortable', radius: 4 },
    shapeLanguage: '', borderStyle: '', shadowStyle: '', backgroundStyle: '', headerStyle: '',
    sidebarStyle: '', messageStyle: '', inputStyle: '', buttonStyle: '', cardStyle: '', iconStyle: '',
    chromeElements: [], decorativeElements: [], assetCandidates: [],
  }
}

describe('v1.2 SkinDesignSpec（schema + provenance 字段）', () => {
  it('provenance 可选且结构合法时通过并透传', () => {
    const raw = base()
    raw.provenance = { fields: { 'colorPalette[0]': { source: 'vision', ref: 'evidence.colors[0]' } }, evidenceRef: { imageKey: 'abc', analysisVersion: 'v2' }, interpretation: ['主色取自证据'] }
    const result = validateSkinDesignSpec(raw)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.spec.provenance?.fields['colorPalette[0]'].source).toBe('vision')
  })
  it('provenance 结构非法 → 拒绝', () => {
    const raw = base()
    raw.provenance = { fields: 'not-object', interpretation: 'not-array' }
    const result = validateSkinDesignSpec(raw)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.issues.join(';')).toContain('provenance')
  })
  it('无 provenance 依旧合法（向后兼容）', () => {
    expect(validateSkinDesignSpec(base()).ok).toBe(true)
  })
})

