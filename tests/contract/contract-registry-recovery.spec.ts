import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { nodeFs } from '../../src/repository/fs'
import { SkinRepository } from '../../src/repository/repository'
import { resolveSkinRoots } from '../../src/repository/store'
import { cleanup, tempDir, writeSkinFixture } from '../helpers'

describe('Phase 3 Registry Recovery（registry.json ↔ 磁盘 一致性矩阵）', () => {
  let home: string
  let roots: ReturnType<typeof resolveSkinRoots>

  beforeEach(() => {
    home = tempDir('dsh-skin-rg-')
    roots = resolveSkinRoots(home)
    for (const dir of [roots.installed, roots.generated, roots.downloaded, roots.staging, roots.cache]) mkdirSync(dir, { recursive: true })
  })
  afterEach(() => { cleanup(home) })

  it('entry exists / package missing → 对账后条目消失', async () => {
    const good = writeSkinFixture(join(home, 'src'), 'rg-1')
    const repo = new SkinRepository(nodeFs(), roots, undefined)
    await repo.hydrate()
    expect((await repo.install(good)).ok).toBe(true)
    // 磁盘包被外部删除（模拟损坏），registry.json 保留旧条目
    const fsMod = await import('node:fs')
    fsMod.rmSync(join(roots.installed, 'rg-1'), { recursive: true, force: true })
    const repo2 = new SkinRepository(nodeFs(), roots, undefined)
    await repo2.hydrate()
    expect(repo2.get('rg-1')).toBeUndefined()
  })

  it('package exists / registry missing → 对账后条目补全', async () => {
    const good = writeSkinFixture(join(home, 'src'), 'rg-2')
    const repo = new SkinRepository(nodeFs(), roots, undefined)
    await repo.hydrate()
    expect((await repo.install(good)).ok).toBe(true)
    writeFileSync(join(roots.root, 'registry.json'), JSON.stringify({ schemaVersion: 1, entries: [] }))
    const repo2 = new SkinRepository(nodeFs(), roots, undefined)
    await repo2.hydrate()
    expect(repo2.get('rg-2')?.id).toBe('rg-2')
  })

  it('registry malformed → 容错重建，registry==disk', async () => {
    const good = writeSkinFixture(join(home, 'src'), 'rg-3')
    const repo = new SkinRepository(nodeFs(), roots, undefined)
    await repo.hydrate()
    expect((await repo.install(good)).ok).toBe(true)
    writeFileSync(join(roots.root, 'registry.json'), 'not json at all')
    const repo2 = new SkinRepository(nodeFs(), roots, undefined)
    await repo2.hydrate()
    expect(repo2.get('rg-3')?.id).toBe('rg-3')
    expect(repo2.get('rg-3')?.state).toBe('ok')
  })

  it('registry duplicate entry → 对账去重（确定性：磁盘发现为权威）', async () => {
    const good = writeSkinFixture(join(home, 'src'), 'rg-4')
    const repo = new SkinRepository(nodeFs(), roots, undefined)
    await repo.hydrate()
    expect((await repo.install(good)).ok).toBe(true)
    const saved = JSON.parse(await nodeFs().readText(join(roots.root, 'registry.json'))) as { schemaVersion: number; entries: Array<{ id: string }> }
    saved.entries.push({ ...saved.entries[0] })
    writeFileSync(join(roots.root, 'registry.json'), JSON.stringify(saved))
    const repo2 = new SkinRepository(nodeFs(), roots, undefined)
    await repo2.hydrate()
    expect(repo2.list().filter(e => e.id === 'rg-4')).toHaveLength(1)
  })

  it('registry stale version → 对账后版本纠正为磁盘值', async () => {
    const good = writeSkinFixture(join(home, 'src'), 'rg-5')
    const repo = new SkinRepository(nodeFs(), roots, undefined)
    await repo.hydrate()
    expect((await repo.install(good)).ok).toBe(true)
    // 磁盘版本改为 2.0.0，registry 仍旧 1.0.0
    const manifest = JSON.parse(await nodeFs().readText(join(roots.installed, 'rg-5', 'manifest.json'))) as Record<string, unknown>
    manifest.version = '2.0.0'
    writeFileSync(join(roots.installed, 'rg-5', 'manifest.json'), JSON.stringify(manifest))
    const repo2 = new SkinRepository(nodeFs(), roots, undefined)
    await repo2.hydrate()
    expect(repo2.get('rg-5')?.version).toBe('2.0.0')
  })

  it('确定性重建：连续两次 hydrate 结果一致且按 id 排序', async () => {
    writeSkinFixture(join(home, 'srcB'), 'rg-b')
    writeSkinFixture(join(home, 'srcA'), 'rg-a')
    const repo = new SkinRepository(nodeFs(), roots, undefined)
    await repo.hydrate()
    expect((await repo.install(join(home, 'srcB', 'rg-b'))).ok).toBe(true)
    expect((await repo.install(join(home, 'srcA', 'rg-a'))).ok).toBe(true)
    const r1 = new SkinRepository(nodeFs(), roots, undefined)
    await r1.hydrate()
    const r2 = new SkinRepository(nodeFs(), roots, undefined)
    await r2.hydrate()
    expect(r1.list().map(e => e.id)).toEqual(r2.list().map(e => e.id))
    expect(r1.list().map(e => e.id)).toEqual(['rg-a', 'rg-b'])
  })
})

