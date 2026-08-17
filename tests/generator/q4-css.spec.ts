import { describe, expect, it } from 'vitest'
import { cssFromSpec, cssFromSpecWithIssues } from '../../src/generator/codegen'
import { parseStylesheet } from '../../src/core/css-parse'
import type { SkinDesignSpec } from '../../src/core/spec'

function richSpec(): SkinDesignSpec {
  return {
    visualStyle: 'test',
    colorPalette: [{ hex: '#0b120b', role: 'bg-base', share: 0.5 }, { hex: '#33ff66', role: 'brand', share: 0.3 }],
    typography: { family: '"Noto Sans SC", sans-serif', mono: '"JetBrains Mono", monospace' },
    spacing: { density: 'comfortable', radius: 12 },
    shapeLanguage: 'border-radius: 14px;',
    borderStyle: 'border: 1px solid var(--dsw-alias-border-l2);',
    shadowStyle: 'box-shadow: 0 0 12px rgba(51,255,102,0.25);',
    backgroundStyle: 'background: linear-gradient(160deg, #0b120b, #1e3a1e);',
    headerStyle: 'border-bottom: 1px solid var(--dsw-alias-border-l1);',
    sidebarStyle: 'background: var(--dsw-specific-sidebar-fill);',
    messageStyle: 'padding: 8px;',
    inputStyle: 'background: var(--dsw-alias-bg-layer-1);',
    buttonStyle: 'background: var(--dsw-alias-bg-layer-2);',
    cardStyle: 'background: var(--dsw-alias-bg-layer-1);',
    iconStyle: 'color: #33ff66;',
    chromeElements: [], decorativeElements: [], assetCandidates: [],
    customCss: '.decorative-sakura { position: fixed; top: 0; right: 0; }',
  }
}

describe('Q4 CSS Quality（结构化/确定性/校验）', () => {
  it('确定性：同 spec 两次输出字节一致；快照锁定结构', () => {
    const spec = richSpec()
    const a = cssFromSpec(spec, 'demo')
    const b = cssFromSpec(spec, 'demo')
    expect(a).toBe(b)
    expect(a).toContain('由 SkinDesignSpec 结构化模板生成')
    expect(a).toContain('body[data-dsh-skin="demo"] {')
    expect(a).toContain('body[data-dsh-skin="demo"] [data-slot="sidebar"] {')
    expect(a).toContain('.decorative-sakura {')
    expect(a).not.toContain(';;')
    expect(a).not.toContain('{ ; }')
  })

  it('槽位规则是顶层合法选择器（不再嵌套在 scope 块内被浏览器丢弃）', () => {
    const css = cssFromSpec(richSpec(), 'demo')
    const parsed = parseStylesheet(css)
    expect(parsed.rules.length).toBeGreaterThan(0)
    for (const rule of parsed.rules) {
      expect(rule.selector.length).toBeGreaterThan(0)
    }
    // 所有槽位选择器都是顶层块（含 scope 前缀）
    expect(parsed.rules.some(r => r.selector === 'body[data-dsh-skin="demo"] [data-slot="sidebar"]')).toBe(true)
    expect(parsed.rules.some(r => r.selector === '.decorative-sakura')).toBe(true)
    // 结构校验零问题（含重复/空块检查）
    expect(parsed.issues).toEqual([])
  })

  it('重复声明：渲染期去重（首个胜出）并记录 issue；不出现 ;;', () => {
    const spec = richSpec()
    spec.backgroundStyle = 'background: #111111;; background: #222222; color: red;'
    const { css, issues } = cssFromSpecWithIssues(spec, 'demo')
    expect(issues.some((i: string) => i.includes('重复声明'))).toBe(true)
    expect(css).not.toContain(';;')
    const parsed = parseStylesheet(css)
    const bodyRule = parsed.rules.find(r => r.selector === 'body[data-dsh-skin="demo"]')
    expect(bodyRule).toBeDefined()
    expect((bodyRule?.declarations ?? []).filter(d => d.property === 'background')).toHaveLength(1)
  })

  it('@keyframes 嵌套 at-rule：透传不重排，校验无误判', () => {
    const spec = richSpec()
    spec.shapeLanguage = ''
    spec.customCss = '@keyframes bubbleFloat { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-12px); } } .sparkle { color: #f8c8c8; }'
    const { css, issues } = cssFromSpecWithIssues(spec, 'demo')
    expect(issues).toEqual([])
    const parsed = parseStylesheet(css)
    expect(parsed.issues).toEqual([])
    expect(css).toContain('@keyframes bubbleFloat')
  })

  it('parseStylesheet 结构校验矩阵：空块/重复选择器/重复声明/CJK/未闭合', () => {
    const dupSelector = parseStylesheet('body {} body {}')
    expect(dupSelector.issues.some(i => i.kind === 'DUPLICATE_SELECTOR')).toBe(true)
    expect(dupSelector.issues.some(i => i.kind === 'EMPTY_DECLARATION_BLOCK')).toBe(true)
    const dupDecl = parseStylesheet('body { color: red; color: blue; }')
    expect(dupDecl.issues.some(i => i.kind === 'DUPLICATE_DECLARATION')).toBe(true)
    const cjk = parseStylesheet('body { color: 深蓝色; }')
    expect(cjk.issues.some(i => i.kind === 'UNQUOTED_CJK')).toBe(true)
    const unclosed = parseStylesheet('body { color: red;')
    expect(unclosed.issues.some(i => i.kind === 'MALFORMED')).toBe(true)
    const fontOk = parseStylesheet('body { font-family: "思源黑体", serif; }')
    expect(fontOk.issues).toEqual([])
  })
})

