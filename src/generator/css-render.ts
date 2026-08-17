/**
 * 结构化 CSS Renderer（Q4）：SkinDesignSpec → 确定性 theme.css。
 * 声明片段解析为 property/value 列表（同属性首个胜出+记 issue）；模板字段与 DeepSeek 字段分离；
 * 槽位规则输出为合法顶层作用域选择器（修复 v1.0.0 嵌套规则被浏览器静默丢弃的缺陷）；customCss 作为顶层规则追加在 scope 之外。
 * @module dsh-skin/src/generator/css-render
 */

import { parseDeclarations, parseStylesheet, type ParsedDeclaration } from '../core/css-parse.ts'
import type { SkinDesignSpec } from '../core/spec.ts'

export interface CssRenderResult {
  css: string
  issues: string[]
}

interface BlockSpec {
  selector: string
  fragments: string[]
}

/** 合并多个片段：解析 → 拼接 → 同属性首个胜出去重。 */
function mergeFragments(fragments: string[]): { declarations: ParsedDeclaration[]; issues: string[] } {
  const declarations: ParsedDeclaration[] = []
  const issues: string[] = []
  const seen = new Set<string>()
  for (const fragment of fragments) {
    if (fragment.trim().length === 0) continue
    const parsed = parseDeclarations(fragment)
    issues.push(...parsed.issues)
    for (const declaration of parsed.declarations) {
      if (seen.has(declaration.property)) {
        issues.push('重复声明（首个胜出）：' + declaration.property)
        continue
      }
      seen.add(declaration.property)
      declarations.push(declaration)
    }
  }
  return { declarations, issues }
}

function renderBlock(selector: string, declarations: ParsedDeclaration[]): string {
  if (declarations.length === 0) return ''
  return selector + ' {\n' + declarations.map(d => '  ' + d.property + ': ' + d.value + ';').join('\n') + '\n}'
}

/** spec → 结构化 CSS（含 issue 列表）。同 spec 同输出（确定性）。 */
export function cssFromSpecStructured(spec: SkinDesignSpec, skinId: string): CssRenderResult {
  const scope = 'body[data-dsh-skin="' + skinId + '"]'
  const issues: string[] = []
  const blocks: BlockSpec[] = []
  const radius = spec.spacing.radius
  // 1. 基础块（仅模板字段 + 背景/几何声明）
  blocks.push({ selector: scope, fragments: [
    'font-family: ' + spec.typography.family + ';',
    'border-radius: ' + radius + 'px;',
    spec.backgroundStyle,
    spec.shapeLanguage,
  ] })
  // 2. 侧栏（sidebar + header 合并）
  blocks.push({ selector: scope + ' [data-slot="sidebar"]', fragments: [spec.sidebarStyle, spec.headerStyle] })
  // 3. 会话区（card + message）
  blocks.push({ selector: scope + ' [data-slot="conversation"]', fragments: [spec.cardStyle, spec.messageStyle] })
  // 4. 浮层
  blocks.push({ selector: scope + ' [data-slot="shell.overlay"] > *', fragments: [spec.cardStyle, spec.borderStyle, spec.shadowStyle] })
  // 5. 输入
  blocks.push({ selector: scope + ' input, ' + scope + ' textarea', fragments: [spec.inputStyle, spec.borderStyle, 'border-radius: ' + radius + 'px;'] })
  // 6. 按钮
  blocks.push({ selector: scope + ' button', fragments: [spec.buttonStyle, spec.borderStyle, 'border-radius: ' + radius + 'px;'] })
  // 7. 代码
  blocks.push({ selector: scope + ' pre, ' + scope + ' code', fragments: ['font-family: ' + spec.typography.mono + ';'] })
  // 8. 图标
  blocks.push({ selector: scope + ' svg, ' + scope + ' [data-slot="sidebar"] svg', fragments: [spec.iconStyle] })
  // 渲染主体块（空块自动跳过）
  const rendered: string[] = []
  for (const block of blocks) {
    const merged = mergeFragments(block.fragments)
    issues.push(...merged.issues)
    const text = renderBlock(block.selector, merged.declarations)
    if (text.length > 0) rendered.push(text)
  }
  // 9. customCss：完整规则原样透传（scope 之外；Q3 已校验平衡；@keyframes 等嵌套 at-rule 不做声明重排）
  if (spec.customCss !== undefined && spec.customCss.trim().length > 0) {
    const parsed = parseStylesheet(spec.customCss)
    issues.push(...parsed.issues.map(i => 'customCss.' + i.kind + '：' + i.message))
    rendered.push(spec.customCss.trim())
  }
  const css = '/* 由 SkinDesignSpec 结构化模板生成（确定性构建） */\n' + rendered.join('\n') + '\n'
  return { css, issues }
}

