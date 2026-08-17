import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { nodeFs } from '../../src/repository/fs'
import { SkinRepository } from '../../src/repository/repository'
import { resolveSkinRoots } from '../../src/repository/store'
import { cleanup, tempDir, writeSkinFixture } from '../helpers'

describe('Phase 3 F：Repository Recovery（中断点 → 重启对账 → registry==disk）', () => {
  let home: string
  let roots: ReturnType<typeof resolveSkinRoots>

  beforeEach(() => {
    home = tempDir('dsh-skin-f-')
    roots = resolveSkinRoots(home)
    for (const dir of [roots.installed, roots.generated, roots.downloaded, roots.staging, roots.cache]) mkdirSync(dir, { recursive: true })
  })
  afterEach(() => { cleanup(home) })

  const makeRepo = (atomic?: (p: string, t: string) => Promise<void>) => new SkinRepository(nodeFs(), roots, undefined, atomic)
  const stagingEntries = () => readdirSync(roots.staging)

  it('F1：validate 后、stage 前失败（非法 manifest）→ 无任何残留', async () => {
    const bad = writeSkinFixture(join(home, 'src'), 'f1-bad')
    writeFileSync(join(bad, 'manifest.json'), JSON.stringify({ id: 'Bad!', version: '1.0.0', name: 'x', author: 'a', description: 'd', tags: [], skinApiVersion: 1, preview: {} }))
    const repo = makeRepo()
    await repo.hydrate()
    expect((await repo.install(bad)).ok).toBe(false)
    expect(readdirSync(roots.installed)).toEqual([])
    expect(stagingEntries()).toEqual([])
    expect(repo.list()).toEqual([])
  })

  it('F2：stage 过程中 kill（staging 半成品目录）→ 重启清扫，无 installed 假记录', async () => {
    // 模拟中断现场：staging 里留半成品
    const orphan = join(roots.staging, '.install-deadbeef')
    mkdirSync(join(orphan, 'theme'), { recursive: true })
    writeFileSync(join(orphan, 'theme', 'light.json'), '{}')
    const orphan2 = join(roots.staging, '.replace-old-cafe')
    mkdirSync(orphan2, { recursive: true })
    // 重启 = 新实例 hydrate
    const repo = makeRepo()
    await repo.hydrate()
    expect(stagingEntries()).toEqual([])
    expect(readdirSync(roots.installed)).toEqual([])
    expect(repo.list()).toEqual([])
  })

  it('F3：integrity 后、commit 前失败（checksum 不符）→ staging 干净、无半包', async () => {
    const bad = writeSkinFixture(join(home, 'src'), 'f3-bad')
    writeFileSync(join(bad, 'integrity.json'), JSON.stringify({ algorithm: 'sha256', files: [{ path: 'manifest.json', size: 999, sha256: 'deadbeef' }] }))
    const repo = makeRepo()
    await repo.hydrate()
    expect((await repo.install(bad)).ok).toBe(false)
    expect(readdirSync(roots.installed)).toEqual([])
    expect(stagingEntries()).toEqual([])
    expect(repo.list()).toEqual([])
  })

  it('F4：commit 后、registry update 前 kill（磁盘有包、registry 缺条目）→ 重启对账补全 registry==disk', async () => {
    const good = writeSkinFixture(join(home, 'src'), 'f4-good')
    const repo = makeRepo()
    await repo.hydrate()
    expect((await repo.install(good)).ok).toBe(true)
    // 模拟 registry 写回前 kill：registry.json 里无该条目
    writeFileSync(join(roots.root, 'registry.json'), JSON.stringify({ schemaVersion: 1, entries: [] }))
    const repo2 = makeRepo()
    await repo2.hydrate()
    expect(repo2.get('f4-good')?.id).toBe('f4-good')
    expect(repo2.get('f4-good')?.state).toBe('ok')
    // registry.json 已被回写修复
    const saved = JSON.parse(readFileSync(join(roots.root, 'registry.json'), 'utf8')) as { entries: Array<{ id: string }> }
    expect(saved.entries.map(e => e.id)).toContain('f4-good')
  })

  it('F5：registry update 中 kill（registry.json 损坏）→ 磁盘权威重建；persist 失败不阻断', async () => {
    const good = writeSkinFixture(join(home, 'src'), 'f5-good')
    const repo = makeRepo()
    await repo.hydrate()
    expect((await repo.install(good)).ok).toBe(true)
    // 损坏 registry.json（半写/坏 JSON）
    writeFileSync(join(roots.root, 'registry.json'), '{"schemaVersion":1,"entries":[')
    const repo2 = makeRepo()
    await repo2.hydrate()
    expect(repo2.get('f5-good')?.id).toBe('f5-good')
    const saved = JSON.parse(readFileSync(join(roots.root, 'registry.json'), 'utf8')) as { entries: Array<{ id: string }> }
    expect(saved.entries.map(e => e.id)).toContain('f5-good')
    // persist 失败（原子写抛错）不阻断 hydrate，内存快照仍正确
    const failing = makeRepo(async () => { throw new Error('disk full') })
    await failing.hydrate()
    expect(failing.get('f5-good')?.id).toBe('f5-good')
  })
})

