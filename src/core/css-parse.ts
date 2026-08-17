/**
 * 轻量 CSS 样式表解析（字符串/注释感知；无第三方依赖；Q4 输出校验门）。
 * 校验点：块结构、空声明块、块内重复声明、重复选择器、括号/引号配平、引号外 CJK。
 * @module dsh-skin/src/core/css-parse
 */

export interface ParsedDeclaration { property: string; value: string }
export interface ParsedRule { selector: string; declarations: ParsedDeclaration[] }
export interface CssParseIssue {
  kind: 'EMPTY_DECLARATION_BLOCK' | 'DUPLICATE_DECLARATION' | 'DUPLICATE_SELECTOR' | 'MALFORMED' | 'UNQUOTED_CJK' | 'EMPTY_SHEET'
  message: string
}

const CJK = /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/

/** 字符串感知扫描：把文本切成顶层片段（按单字符分隔符，跳过引号串与注释）。 */
function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = []
  let current = ''
  let openQuote: string | null = null
  let inComment = false
  let i = 0
  while (i < text.length) {
    const c = text[i]
    const next = text[i + 1]
    if (inComment) {
      if (c === '*' && next === '/') { inComment = false; i += 2; continue }
      i += 1
      continue
    }
    if (openQuote !== null) {
      current += c
      if (c === '\\') { current += text[i + 1] ?? ''; i += 2; continue }
      if (c === openQuote) openQuote = null
      i += 1
      continue
    }
    if (c === '/' && next === '*') { inComment = true; current += '/*'; i += 2; continue }
    if (c === '"' || c === "'") { openQuote = c; current += c; i += 1; continue }
    if (c === separator) { parts.push(current); current = ''; i += 1; continue }
    current += c
    i += 1
  }
  parts.push(current)
  return parts
}

/** 声明片段 → 声明列表（分号切分 + 首个冒号切 property/value；无冒号片段丢弃并记 issue；同属性首个胜出）。 */
export function parseDeclarations(fragment: string): { declarations: ParsedDeclaration[]; issues: string[] } {
  const declarations: ParsedDeclaration[] = []
  const issues: string[] = []
  const seen = new Set<string>()
  for (const part of splitTopLevel(fragment, ';')) {
    const trimmed = part.trim()
    if (trimmed.length === 0) continue
    const colon = trimmed.indexOf(':')
    if (colon <= 0) { issues.push('丢弃非声明片段：' + JSON.stringify(trimmed.slice(0, 60))); continue }
    const property = trimmed.slice(0, colon).trim().toLowerCase()
    const value = trimmed.slice(colon + 1).trim()
    if (property.length === 0 || value.length === 0) { issues.push('丢弃空声明：' + JSON.stringify(trimmed.slice(0, 60))); continue }
    if (seen.has(property)) { issues.push('重复声明丢弃（同属性首个胜出）：' + property); continue }
    seen.add(property)
    declarations.push({ property, value })
  }
  return { declarations, issues }
}

/** 整表解析：selector { decls } 序列；返回规则 + 结构问题（不含合法引号内 CJK）。 */
export function parseStylesheet(text: string): { rules: ParsedRule[]; issues: CssParseIssue[] } {
  const issues: CssParseIssue[] = []
  const rules: ParsedRule[] = []
  if (typeof text !== 'string' || text.trim().length === 0) { issues.push({ kind: 'EMPTY_SHEET', message: '样式表为空' }); return { rules, issues } }
  let openQuote: string | null = null
  let inComment = false
  let braceDepth = 0
  let selector = ''
  let body = ''
  const selectorsSeen = new Set<string>()
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    const next = text[i + 1]
    if (inComment) {
      if (c === '*' && next === '/') { inComment = false; i += 2; continue }
      i += 1
      continue
    }
    if (openQuote !== null) {
      if (braceDepth === 0) selector += c
      else { body += c; if (CJK.test(c) && c !== '') undefined }
      if (c === '\\') { if (braceDepth === 0) selector += text[i + 1] ?? ''; else body += text[i + 1] ?? ''; i += 1; continue }
      if (c === openQuote) openQuote = null
      continue
    }
    if (c === '/' && next === '*') { inComment = true; i += 2; continue }
    if (c === '"' || c === "'") { openQuote = c; if (braceDepth === 0) selector += c; else body += c; continue }
    if (CJK.test(c)) {
      if (braceDepth === 0) selector += c
      else issues.push({ kind: 'UNQUOTED_CJK', message: '声明体内引号外出现中文字符' })
      continue
    }
    if (c === '{') {
      braceDepth += 1
      continue
    }
    if (c === '}') {
      braceDepth -= 1
      if (braceDepth < 0) { issues.push({ kind: 'MALFORMED', message: '多余的右花括号' }); continue }
      if (braceDepth === 0) {
        const trimmedSelector = selector.trim()
        if (trimmedSelector.length === 0) issues.push({ kind: 'MALFORMED', message: '空选择器' })
        else if (trimmedSelector.startsWith('@')) {
          // at-rule（@keyframes/@media 等）：嵌套体不透明，跳过声明解析
          if (selectorsSeen.has(trimmedSelector)) issues.push({ kind: 'DUPLICATE_SELECTOR', message: '重复选择器：' + trimmedSelector })
          selectorsSeen.add(trimmedSelector)
          rules.push({ selector: trimmedSelector, declarations: [] })
        }
        else {
          if (selectorsSeen.has(trimmedSelector)) issues.push({ kind: 'DUPLICATE_SELECTOR', message: '重复选择器：' + trimmedSelector })
          selectorsSeen.add(trimmedSelector)
          const parsed = parseDeclarations(body)
          issues.push(...parsed.issues.map(m => ({ kind: 'DUPLICATE_DECLARATION' as const, message: m })))
          if (parsed.declarations.length === 0) issues.push({ kind: 'EMPTY_DECLARATION_BLOCK', message: '空声明块：' + trimmedSelector })
          rules.push({ selector: trimmedSelector, declarations: parsed.declarations })
        }
        selector = ''
        body = ''
        continue
      }
      continue
    }
    if (braceDepth === 0) selector += c
    else if (braceDepth === 1) body += c
  }
  if (braceDepth !== 0) issues.push({ kind: 'MALFORMED', message: '花括号未闭合（深度 ' + braceDepth + '）' })
  if (openQuote !== null) issues.push({ kind: 'MALFORMED', message: '引号未闭合' })
  return { rules, issues }
}

