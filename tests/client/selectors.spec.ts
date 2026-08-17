import { describe, expect, it } from 'vitest'
import { collectTags, filterAndSort, formatUpdated, type GalleryEntry } from '../../src/client/center/selectors.ts'

function entry(over: Partial<GalleryEntry>): GalleryEntry {
  return {
    id: 'x', source: 'builtin', version: '1.0.0', name: 'X', author: 'a', description: 'd',
    tags: [], skinApiVersion: 1, preview: {}, state: 'ok', issues: [], updatedAtMs: 0, trust: 'trusted',
    ...over,
  }
}

const fixtures: GalleryEntry[] = [
  entry({ id: 'terminal', name: 'Phosphor Terminal', tags: ['retro', 'terminal'], source: 'builtin', version: '0.1.0', updatedAtMs: 1000 }),
  entry({ id: 'clean', name: 'Clean Lab', tags: ['minimal'], source: 'builtin', version: '1.0.0', updatedAtMs: 2000 }),
  entry({ id: 'my-local', name: 'My Local', author: 'me', tags: ['terminal'], source: 'installed', version: '2.1.3', updatedAtMs: 3000 }),
]

describe('filterAndSort', () => {
  it('关键词匹配 id/name/author/description（多词 AND）', () => {
    expect(filterAndSort(fixtures, { query: 'phosphor', tags: [], sources: [], sort: 'name' }).map(e => e.id)).toEqual(['terminal'])
    expect(filterAndSort(fixtures, { query: 'me local', tags: [], sources: [], sort: 'name' }).map(e => e.id)).toEqual(['my-local'])
    expect(filterAndSort(fixtures, { query: '不存在', tags: [], sources: [], sort: 'name' })).toEqual([])
  })

  it('标签 AND 语义', () => {
    expect(filterAndSort(fixtures, { query: '', tags: ['terminal'], sources: [], sort: 'name' }).map(e => e.id)).toEqual(['my-local', 'terminal'])
    expect(filterAndSort(fixtures, { query: '', tags: ['terminal', 'retro'], sources: [], sort: 'name' }).map(e => e.id)).toEqual(['terminal'])
  })

  it('来源过滤', () => {
    expect(filterAndSort(fixtures, { query: '', tags: [], sources: ['installed'], sort: 'name' }).map(e => e.id)).toEqual(['my-local'])
    expect(filterAndSort(fixtures, { query: '', tags: [], sources: [], sort: 'name' }).length).toBe(3)
  })

  it('排序：name/id/version/updated', () => {
    expect(filterAndSort(fixtures, { query: '', tags: [], sources: [], sort: 'name' }).map(e => e.id)).toEqual(['clean', 'my-local', 'terminal'])
    expect(filterAndSort(fixtures, { query: '', tags: [], sources: [], sort: 'id' }).map(e => e.id)).toEqual(['clean', 'my-local', 'terminal'])
    expect(filterAndSort(fixtures, { query: '', tags: [], sources: [], sort: 'version' }).map(e => e.id)).toEqual(['my-local', 'clean', 'terminal'])
    expect(filterAndSort(fixtures, { query: '', tags: [], sources: [], sort: 'updated' }).map(e => e.id)).toEqual(['my-local', 'clean', 'terminal'])
  })

  it('collectTags 去重排序', () => {
    expect(collectTags(fixtures)).toEqual(['minimal', 'retro', 'terminal'])
  })

  it('formatUpdated', () => {
    expect(formatUpdated(0)).toBe('-')
    expect(formatUpdated(new Date('2026-08-16T08:00:00Z').getTime())).toBe('2026-08-16')
  })
})
