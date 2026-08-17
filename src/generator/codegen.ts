/**
 * 模板化代码生成：SkinDesignSpec → 完整 Skin Package（确定性、可复现）。
 * AI 负责产出 spec；本模块负责把 spec 翻译成统一 Skin Package 契约。
 * 不接触 DOM / 不做任何视觉调用。
 * @module dsh-skin/src/generator/codegen
 */

import type { SkinDesignSpec, SpecColor } from '../core/spec.ts'
import { cssFromSpecStructured } from './css-render.ts'

export interface SkinNaming {
  id: string
  name: string
  author: string
  description: string
  tags: string[]
}

/** 角色 → 宿主语义 token 映射（v1.3 起导出：package-build 的 Spec→Package 映射证据引用）。 */
export const ROLE_TOKEN: Record<string, string> = {
  'bg-base': '--dsw-alias-bg-base',
  'bg-layer': '--dsw-alias-bg-layer-1',
  border: '--dsw-alias-border-l2',
  brand: '--dsw-alias-brand-primary',
  label: '--dsw-alias-label-primary',
  'label-secondary': '--dsw-alias-label-secondary',
  accent: '--dsw-alias-state-success-primary',
}

function pick(palette: SpecColor[], role: string, fallback: string): string {
  const hit = palette.find(color => color.role === role)
  return hit?.hex ?? fallback
}

function pickTwo(palette: SpecColor[], roleA: string, roleB: string, fallback: string): string {
  return palette.find(color => color.role === roleA)?.hex ?? palette.find(color => color.role === roleB)?.hex ?? fallback
}

/** spec → 亮/暗两份 token JSON（暗色整体压暗 40%）。 */
export function tokensFromSpec(spec: SkinDesignSpec): { light: Record<string, string>; dark: Record<string, string> } {
  const light: Record<string, string> = {}
  const dark: Record<string, string> = {}
  const brand = pick(spec.colorPalette, 'brand', '#4d6bfe')
  const bg = pick(spec.colorPalette, 'bg-base', '#0b120b')
  const layer = pickTwo(spec.colorPalette, 'bg-layer', 'other', bg)
  const border = pick(spec.colorPalette, 'border', layer)
  const label = pick(spec.colorPalette, 'label', '#e8f0e8')
  const labelSecondary = pickTwo(spec.colorPalette, 'label-secondary', 'label', label)
  const accent = pick(spec.colorPalette, 'accent', brand)
  light['--dsw-alias-bg-base'] = bg
  light['--dsw-alias-bg-layer-1'] = layer
  light['--dsw-alias-bg-layer-2'] = layer
  light['--dsw-alias-bg-overlay'] = bg
  light['--dsw-alias-border-l1'] = border
  light['--dsw-alias-border-l2'] = border
  light['--dsw-alias-brand-primary'] = brand
  light['--dsw-alias-label-primary'] = label
  light['--dsw-alias-label-secondary'] = labelSecondary
  light['--dsw-alias-state-success-primary'] = accent
  light['--dsw-alias-state-error-primary'] = '#ff5f56'
  light['--dsw-alias-state-warn-primary'] = '#ffd166'
  light['--dsw-specific-sidebar-fill'] = layer
  for (const [key, value] of Object.entries(light)) dark[key] = value
  const darken = (hex: string): string => {
    const n = Number.parseInt(hex.slice(1), 16)
    const r = Math.round(((n >> 16) & 255) * 0.6)
    const g = Math.round(((n >> 8) & 255) * 0.6)
    const b = Math.round((n & 255) * 0.6)
    return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('')
  }
  dark['--dsw-alias-bg-base'] = darken(bg)
  dark['--dsw-alias-bg-layer-1'] = darken(layer)
  dark['--dsw-alias-bg-layer-2'] = darken(layer)
  dark['--dsw-alias-bg-overlay'] = darken(bg)
  dark['--dsw-specific-sidebar-fill'] = darken(layer)
  return { light, dark }
}

/** spec → styles/theme.css（结构化 renderer；Q4，见 docs/quality-css.md）。 */
export function cssFromSpec(spec: SkinDesignSpec, skinId: string): string {
  return cssFromSpecStructured(spec, skinId).css
}

/** spec → styles/theme.css + 渲染期 issue（Q4 诊断面）。 */
export function cssFromSpecWithIssues(spec: SkinDesignSpec, skinId: string): { css: string; issues: string[] } {
  return cssFromSpecStructured(spec, skinId)
}

export function previewSvg(bg: string, brand: string, label: string, name: string): string {
  const escaped = name.replace(/[<>&"]/g, '')
  return '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="270"><rect width="480" height="270" fill="' + bg + '"/>'
    + '<rect x="0" y="0" width="120" height="270" fill="' + bg + '"/>'
    + '<rect x="136" y="24" width="328" height="56" rx="8" fill="' + bg + '" stroke="' + brand + '" stroke-width="2"/>'
    + '<rect x="136" y="104" width="200" height="28" rx="6" fill="' + bg + '"/>'
    + '<rect x="136" y="144" width="260" height="14" rx="7" fill="' + brand + '" opacity="0.35"/>'
    + '<rect x="136" y="166" width="220" height="14" rx="7" fill="' + brand + '" opacity="0.2"/>'
    + '<circle cx="52" cy="40" r="18" fill="' + brand + '"/>'
    + '<text x="136" y="250" font-family="monospace" font-size="13" fill="' + label + '">' + escaped + '</text></svg>'
}

// v1.3：writeSkinPackage 迁移至 src/generator/package-build.ts（Deterministic Package Builder 统一出口）。
