/**
 * 字符串感知的 CSS 片段校验（无第三方依赖；Q3 的字段感知层）。
 * 原则：禁止非法自然语言进入机器设计字段；不禁止合法 CSS 结构，
 * 引号内的 CJK（如 font-family 字体名）合法；用户面字段（name/description）不经本模块。
 * @module dsh-skin/src/core/css-strings
 */

export interface CssStringIssue {
  kind: 'UNQUOTED_CJK' | 'UNCLOSED_QUOTE' | 'PAREN_IMBALANCE' | 'BRACE_IMBALANCE' | 'NL_SENTENCE' | 'EMPTY' | 'SENTENCE_PUNCTUATION'
  message: string
}

const CJK = /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/
const SENTENCE_PUNCT = /[。，！？；：…—]/

/** 扫描器：跳注释与引号串，统计括号/花括号配对，捕获引号外 CJK。 */
function scan(text: string): { unquotedCjk: number[]; parenDepth: number; braceDepth: number; openQuote: string | null; cjkPositions: number[]; bracesOutsideQuotes: number[] } {
  const unquotedCjk: number[] = []
  const cjkPositions: number[] = []
  const bracesOutsideQuotes: number[] = []
  let parenDepth = 0
  let braceDepth = 0
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
      if (c === '\\') { i += 2; continue }
      if (c === openQuote) openQuote = null
      if (CJK.test(c)) cjkPositions.push(i)
      i += 1
      continue
    }
    if (c === '/' && next === '*') { inComment = true; i += 2; continue }
    if (c === '"' || c === "'") { openQuote = c; i += 1; continue }
    if (CJK.test(c)) { unquotedCjk.push(i); cjkPositions.push(i) }
    if (c === '(') parenDepth += 1
    if (c === ')') parenDepth -= 1
    if (c === '{' || c === '}') { braceDepth += c === '{' ? 1 : -1; bracesOutsideQuotes.push(i) }
    i += 1
  }
  return { unquotedCjk, parenDepth, braceDepth, openQuote, cjkPositions, bracesOutsideQuotes }
}

/** 声明片段级校验（shapeLanguage/borderStyle/... 等：不含 { } 的声明集合）。 */
export function cssFragmentIssues(text: string, opts: { allowRules?: boolean } = {}): CssStringIssue[] {
  const issues: CssStringIssue[] = []
  if (typeof text !== 'string' || text.trim().length === 0) { issues.push({ kind: 'EMPTY', message: '片段为空' }); return issues }
  const trimmed = text.trim()
  const s = scan(trimmed)
  for (const pos of s.unquotedCjk) issues.push({ kind: 'UNQUOTED_CJK', message: '引号外出现中文字符（位置 ' + pos + '）：' + JSON.stringify(trimmed.slice(Math.max(0, pos - 8), pos + 8)) })
  if (s.openQuote !== null) issues.push({ kind: 'UNCLOSED_QUOTE', message: '引号未闭合' })
  if (s.parenDepth !== 0) issues.push({ kind: 'PAREN_IMBALANCE', message: '括号不配对（深度 ' + s.parenDepth + '）' })
  if (opts.allowRules === true) {
    if (s.braceDepth !== 0) issues.push({ kind: 'BRACE_IMBALANCE', message: '花括号不配对（深度 ' + s.braceDepth + '）' })
  } else {
    // v1.4 加固：声明片段字段引号外出现任何花括号即拒绝（配平注入也无法通过）
    if (s.bracesOutsideQuotes.length > 0) issues.push({ kind: 'BRACE_IMBALANCE', message: '声明片段不允许含 { }（位置 ' + s.bracesOutsideQuotes[0] + '；引号外花括号一律拒绝）' })
    else if (s.braceDepth !== 0) issues.push({ kind: 'BRACE_IMBALANCE', message: '声明片段不允许含 { }（深度 ' + s.braceDepth + '）' })
  }
  // 句子标点（引号外）与疑似自然语言句（无任何 CSS 结构 token）
  const noCssToken = !/[:;()#]/.test(trimmed) && !trimmed.includes('var(')
  if (noCssToken && trimmed.length > 16) issues.push({ kind: 'NL_SENTENCE', message: '疑似自然语言描述而非 CSS 片段' })
  let inComment = false; let openQ: string | null = null
  for (let i = 0; i < trimmed.length; i++) {
    const c = trimmed[i]; const n = trimmed[i + 1]
    if (inComment) { if (c === '*' && n === '/') inComment = false; continue }
    if (openQ !== null) { if (c === '\\') { i++; continue }; if (c === openQ) openQ = null; continue }
    if (c === '/' && n === '*') { inComment = true; i++; continue }
    if (c === '"' || c === "'") { openQ = c; continue }
    if (SENTENCE_PUNCT.test(c)) issues.push({ kind: 'SENTENCE_PUNCTUATION', message: '引号外出现句子标点：' + JSON.stringify(c) })
  }
  return issues
}

/** 字体栈校验：允许引号内 CJK 字体名；拒绝引号外 CJK 与句子。 */
export function fontFamilyIssues(text: string): CssStringIssue[] {
  const issues: CssStringIssue[] = []
  if (typeof text !== 'string' || text.trim().length === 0) { issues.push({ kind: 'EMPTY', message: '字体栈为空' }); return issues }
  const s = scan(text)
  if (s.unquotedCjk.length > 0) issues.push({ kind: 'UNQUOTED_CJK', message: '字体名中的中文必须加引号' })
  if (s.openQuote !== null) issues.push({ kind: 'UNCLOSED_QUOTE', message: '引号未闭合' })
  if (SENTENCE_PUNCT.test(text)) issues.push({ kind: 'SENTENCE_PUNCTUATION', message: '字体声明含句子标点' })
  return issues
}

/** 整表校验（codegen 输出的 theme.css）：CJK 仅允许注释/引号内；花括号配对；非空。 */
export function cssStylesheetIssues(text: string): CssStringIssue[] {
  const issues: CssStringIssue[] = []
  if (typeof text !== 'string' || text.trim().length === 0) { issues.push({ kind: 'EMPTY', message: '样式表为空' }); return issues }
  const s = scan(text)
  for (const pos of s.unquotedCjk) issues.push({ kind: 'UNQUOTED_CJK', message: '引号外出现中文字符（位置 ' + pos + '）' })
  if (s.openQuote !== null) issues.push({ kind: 'UNCLOSED_QUOTE', message: '引号未闭合' })
  if (s.parenDepth !== 0) issues.push({ kind: 'PAREN_IMBALANCE', message: '括号不配对（深度 ' + s.parenDepth + '）' })
  if (s.braceDepth !== 0) issues.push({ kind: 'BRACE_IMBALANCE', message: '花括号不配对（深度 ' + s.braceDepth + '）' })
  return issues
}

