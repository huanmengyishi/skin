import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { nodeFs } from '../../src/repository/fs'
import { SkinRepository } from '../../src/repository/repository'
import { resolveSkinRoots } from '../../src/repository/store'
import { cleanup, tempDir, writeSkinFixture } from '../helpers'

const legal = (id: string) => ({ id, version: '1.0.0', name: 'N', author: 'A', description: 'D', tags: [], skinApiVersion: 1, preview: {} })

describe('Phase 3 J：Malformed Package（全部拒绝、五目录不变、registry 不变）', () => {
  let home: string
  let roots: ReturnType<typeof resolveSkinRoots>

  beforeEach(() => {
    home = tempDir('dsh-skin-j-')
    roots = resolveSkinRoots(home)
    for (const dir of [roots.installed, roots.generated, roots.downloaded, roots.staging, roots.cache]) mkdirSync(dir, { recursive: true })
  })
  afterEach(() => { cleanup(home) })

  const makeRepo = () => new SkinRepository(nodeFs(), roots, undefined)
  const assertClean = (repo: SkinRepository) => {
    expect(readdirSync(roots.installed)).toEqual([])
    expect(readdirSync(roots.generated)).toEqual([])
    expect(readdirSync(roots.downloaded)).toEqual([])
    expect(readdirSync(roots.staging)).toEqual([])
    expect(repo.list()).toEqual([])
  }

  it('J 矩阵：14 类畸形输入全部拒绝且零残留', async () => {
    const repo = makeRepo()
    await repo.hydrate()
    const cases: Array<{ name: string; kind: string; prepare(): string }> = []
    cases.push({ name: 'missing manifest', kind: 'PackageError', prepare: () => { const d = join(home, 'src1', 'j1'); mkdirSync(join(d, 'theme'), { recursive: true }); return d } })
    cases.push({ name: 'invalid JSON manifest', kind: 'ManifestError', prepare: () => { const d = writeSkinFixture(join(home, 'src2'), 'j2'); writeFileSync(join(d, 'manifest.json'), '{broken'); return d } })
    cases.push({ name: 'invalid manifest schema（缺 name）', kind: 'ManifestError', prepare: () => { const d = writeSkinFixture(join(home, 'src3'), 'j3'); const m = legal('j3') as Record<string, unknown>; delete m.name; writeFileSync(join(d, 'manifest.json'), JSON.stringify(m)); return d } })
    cases.push({ name: 'invalid structure（symlink 成员）', kind: 'SecurityError', prepare: () => { const d = writeSkinFixture(join(home, 'src4'), 'j4'); try { symlinkSync(join(home, 'outside'), join(d, 'theme', 'link')) } catch {} return d } })
    cases.push({ name: 'invalid integrity（不支持算法）', kind: 'IntegrityError', prepare: () => { const d = writeSkinFixture(join(home, 'src5'), 'j5'); writeFileSync(join(d, 'integrity.json'), JSON.stringify({ algorithm: 'md5', files: [] })); return d } })
    cases.push({ name: 'checksum mismatch', kind: 'IntegrityError', prepare: () => { const d = writeSkinFixture(join(home, 'src6'), 'j6'); writeFileSync(join(d, 'integrity.json'), JSON.stringify({ algorithm: 'sha256', files: [{ path: 'manifest.json', size: 1, sha256: 'bad' }] })); return d } })
    cases.push({ name: 'duplicate id', kind: 'ResolutionError', prepare: () => { const d = writeSkinFixture(join(home, 'src7'), 'j7'); return d } })
    cases.push({ name: 'path traversal（preview 越界）', kind: 'ManifestError', prepare: () => { const d = writeSkinFixture(join(home, 'src8'), 'j8'); const m = legal('j8') as Record<string, unknown>; m.preview = { light: '../up.png' }; writeFileSync(join(d, 'manifest.json'), JSON.stringify(m)); return d } })
    cases.push({ name: 'remote URL in css', kind: 'SecurityError', prepare: () => { const d = writeSkinFixture(join(home, 'src9'), 'j9'); writeFileSync(join(d, 'styles', 'theme.css'), 'body{background:url(https://evil.example/x.png)}'); return d } })
    cases.push({ name: 'unexpected executable', kind: 'SecurityError', prepare: () => { const d = writeSkinFixture(join(home, 'src10'), 'j10'); writeFileSync(join(d, 'payload.exe'), 'MZ'); return d } })
    cases.push({ name: 'incompatible skinApiVersion=2', kind: 'CompatibilityError', prepare: () => { const d = writeSkinFixture(join(home, 'src11'), 'j11'); const m = legal('j11') as Record<string, unknown>; m.skinApiVersion = 2; writeFileSync(join(d, 'manifest.json'), JSON.stringify(m)); return d } })
    cases.push({ name: 'skinApiVersion=0', kind: 'CompatibilityError', prepare: () => { const d = writeSkinFixture(join(home, 'src12'), 'j12'); const m = legal('j12') as Record<string, unknown>; m.skinApiVersion = 0; writeFileSync(join(d, 'manifest.json'), JSON.stringify(m)); return d } })
    cases.push({ name: 'reserved id（default）', kind: 'ManifestError', prepare: () => { const d = writeSkinFixture(join(home, 'src13'), 'default'); return d } })
    cases.push({ name: '非法 ID（大写/空格）', kind: 'ManifestError', prepare: () => { const d = writeSkinFixture(join(home, 'src14'), 'Bad Id'); return d } })
    // 先装一个合法包制造 duplicate id 前置
    const first = writeSkinFixture(join(home, 'src0'), 'j7')
    expect((await repo.install(first)).ok).toBe(true)
    const results: Array<{ name: string; kind: string; rejected: boolean; issues: string[] }> = []
    for (const c of cases) {
      const dir = c.prepare()
      const result = await repo.install(dir)
      results.push({ name: c.name, kind: c.kind, rejected: !result.ok, issues: result.ok ? [] : result.issues })
      expect(result.ok).toBe(false)
    }
    // registry 不变（仅 j7 合法包）
    expect(repo.list().map(e => e.id)).toEqual(['j7'])
    expect(readdirSync(roots.installed)).toEqual(['j7'])
    expect(readdirSync(roots.generated)).toEqual([])
    expect(readdirSync(roots.downloaded)).toEqual([])
    expect(readdirSync(roots.staging)).toEqual([])
    for (const r of results) {
      expect(r.rejected).toBe(true)
      // 结果协议与 SkinError 分类的语义映射（taxonomy 契约 §10：仓库层保持结果协议）
      expect(r.issues.length).toBeGreaterThan(0)
    }
  })
})

