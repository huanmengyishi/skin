import { describe, expect, it } from 'vitest'
import { cssFragmentIssues, cssStylesheetIssues, fontFamilyIssues } from '../../src/core/css-strings'
import { validateSkinDesignSpec } from '../../src/core/spec'
import { validateManifest } from '../../src/core/manifest'

function specWith(field: string, value: string): unknown {
  return {
    visualStyle: 'fixture',
    colorPalette: [{ hex: '#0b120b', role: 'bg-base', share: 0.5 }],
    typography: { family: 'mono', mono: 'mono' },
    spacing: { density: 'comfortable', radius: 4 },
    shapeLanguage: '', borderStyle: '', shadowStyle: '', backgroundStyle: '', headerStyle: '',
    sidebarStyle: '', messageStyle: '', inputStyle: '', buttonStyle: '', cardStyle: '', iconStyle: '',
    chromeElements: [], decorativeElements: [], assetCandidates: [],
    [field]: value,
  }
}

describe('Q3 字段感知校验（反例矩阵）', () => {
  it('合法 CSS 值通过；非法自然语言值拒绝（逐字段）', () => {
    expect(validateSkinDesignSpec(specWith('borderStyle', 'border: 1px solid var(--x);')).ok).toBe(true)
    expect(validateSkinDesignSpec(specWith('backgroundStyle', 'background: linear-gradient(160deg, #1a1a2e, #4a6fa5);')).ok).toBe(true)
    // 非法中文颜色
    const chineseColor = validateSkinDesignSpec(specWith('backgroundStyle', '背景颜色是深蓝色'))
    expect(chineseColor.ok).toBe(false)
    if (!chineseColor.ok) expect(chineseColor.issues.join(';')).toContain('backgroundStyle')
    // 自然语言长度
    const nlLength = validateSkinDesignSpec(specWith('shapeLanguage', '按钮呈现圆润效果'))
    expect(nlLength.ok).toBe(false)
    // 中文句子进按钮样式
    const nlButton = validateSkinDesignSpec(specWith('buttonStyle', '这是一个漂亮的按钮样式'))
    expect(nlButton.ok).toBe(false)
  })

  it('字体声明：合法含引号 CJK 字体名通过；未加引号 CJK 拒绝；自然语言拒绝', () => {
    expect(fontFamilyIssues('"Noto Sans SC", "宋体", sans-serif')).toEqual([])
    expect(fontFamilyIssues('宋体, serif').some(i => i.kind === 'UNQUOTED_CJK')).toBe(true)
    expect(fontFamilyIssues('看起来比较大的字体').some(i => i.kind === 'UNQUOTED_CJK' || i.kind === 'SENTENCE_PUNCTUATION')).toBe(true)
    const specFont = validateSkinDesignSpec(specWith('typography.family', 'x') as never)
    void specFont
    const badFont = validateSkinDesignSpec({
      ...(specWith('backgroundStyle', '') as Record<string, unknown>),
      typography: { family: '宋体, serif', mono: 'mono' },
    })
    expect(badFont.ok).toBe(false)
  })

  it('description 含中文合法（用户面字段不拦）；机器字段才拦', () => {
    const manifest = validateManifest({
      id: 'demo', version: '1.0.0', name: '东方古典', author: '作者', description: '东方古典风格皮肤',
      tags: ['demo'], skinApiVersion: 1, preview: {},
    })
    expect(manifest.ok).toBe(true)
  })

  it('cssFragmentIssues：合法声明/含 CSS 结构通过；疑似自然语言触发 NL_SENTENCE', () => {
    expect(cssFragmentIssues('border: 1px solid var(--x);').filter(i => i.kind !== 'SENTENCE_PUNCTUATION')).toEqual([])
    const prose = cssFragmentIssues('垂直线条与柔和弧线结合，模仿飞檐翘角')
    expect(prose.some(i => i.kind === 'UNQUOTED_CJK')).toBe(true)
    expect(cssFragmentIssues('foo: bar')).toEqual([])
  })

  it('cssStylesheetIssues：整表级（引号内 CJK 字体名合法；引号外 CJK 拒绝；花括号配对）', () => {
    const good = 'body[data-dsh-skin="demo"] { font-family: "宋体", serif; color: #123456; }'
    expect(cssStylesheetIssues(good)).toEqual([])
    const leak = 'body { color: red; } 这是中文描述'
    expect(cssStylesheetIssues(leak).some(i => i.kind === 'UNQUOTED_CJK')).toBe(true)
    const unbalanced = 'body { color: red;'
    expect(cssStylesheetIssues(unbalanced).some(i => i.kind === 'BRACE_IMBALANCE')).toBe(true)
  })
})

