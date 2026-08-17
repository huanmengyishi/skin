/**
 * Skin Center 的纯视图逻辑：搜索 / 标签过滤 / 来源过滤 / 排序。
 * 与 UI 解耦，便于单元测试与后续复用。
 * @module dsh-skin/src/client/center/selectors
 */

export interface GalleryEntry {
  id: string
  source: 'builtin' | 'installed' | 'generated' | 'downloaded'
  version: string
  name: string
  author: string
  description: string
  tags: string[]
  skinApiVersion: number
  preview: { light?: string; dark?: string }
  state: 'ok' | 'invalid' | 'corrupt'
  issues: string[]
  updatedAtMs: number
  trust: 'trusted' | 'untrusted'
}

export type GallerySort = 'name' | 'id' | 'version' | 'updated'

export interface GalleryFilter {
  /** 空格分隔的关键词（匹配 id/name/author/description，忽略大小写） */
  query: string
  /** 选中标签（AND 语义：皮肤必须包含全部选中标签） */
  tags: string[]
  /** 来源过滤（空 = 全部） */
  sources: Array<'builtin' | 'installed' | 'generated' | 'downloaded'>
  sort: GallerySort
}

/** 把 version 字符串拆成数字段做近似 SemVer 比较（预发布段忽略）。 */
function versionParts(version: string): number[] {
  return version.split('-')[0].split('.').map(part => {
    const n = Number.parseInt(part, 10)
    return Number.isFinite(n) ? n : 0
  })
}

function compareVersion(a: string, b: string): number {
  const left = versionParts(a)
  const right = versionParts(b)
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const l = left[i] ?? 0
    const r = right[i] ?? 0
    if (l !== r) return l - r
  }
  return 0
}

/** 关键词匹配：每个词都必须命中 id/name/author/description 之一。 */
function matchesQuery(entry: GalleryEntry, query: string): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter(word => word.length > 0)
  if (words.length === 0) return true
  const haystack = [entry.id, entry.name, entry.author, entry.description].join(' ').toLowerCase()
  return words.every(word => haystack.includes(word))
}

export function filterAndSort(entries: readonly GalleryEntry[], filter: GalleryFilter): GalleryEntry[] {
  const result = entries.filter(entry =>
    matchesQuery(entry, filter.query)
    && filter.tags.every(tag => entry.tags.includes(tag))
    && (filter.sources.length === 0 || filter.sources.includes(entry.source)),
  )
  result.sort((a, b) => {
    switch (filter.sort) {
      case 'id': return a.id.localeCompare(b.id)
      case 'version': return compareVersion(b.version, a.version)
      case 'updated': return b.updatedAtMs - a.updatedAtMs
      case 'name':
      default: return a.name.localeCompare(b.name)
    }
  })
  return result
}

/** 全部标签（去重、按名称排序，用于标签筛选条）。 */
export function collectTags(entries: readonly GalleryEntry[]): string[] {
  return [...new Set(entries.flatMap(entry => entry.tags))].sort((a, b) => a.localeCompare(b))
}

/** 展示用更新时间（YYYY-MM-DD；0 = 未知）。 */
export function formatUpdated(ms: number): string {
  if (ms <= 0) return '-'
  const date = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate())
}
