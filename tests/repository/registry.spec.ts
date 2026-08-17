import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { nodeFs } from '../../src/repository/fs'
import { SkinRegistry, jsonRegistryStorage } from '../../src/repository/registry'
import { resolveSkinRoots } from '../../src/repository/store'
import { cleanup, tempDir, writeSkinFixture } from '../helpers'

describe('SkinRegistry', () => {
  let home: string
  let roots: ReturnType<typeof resolveSkinRoots>

  beforeEach(() => {
    home = tempDir('dsh-skin-reg-')
    roots = resolveSkinRoots(home)
    mkdirSync(roots.installed, { recursive: true })
    mkdirSync(roots.staging, { recursive: true })
    mkdirSync(roots.cache, { recursive: true })
  })

  afterEach(() => {
    cleanup(home)
  })

  it('discover：内置 + installed，损坏/非法不崩溃', async () => {
    const builtin = join(home, 'builtins')
    writeSkinFixture(builtin, 'clean')
    writeSkinFixture(roots.installed, 'local-one')
    // 损坏：manifest 缺失
    mkdirSync(join(roots.installed, 'broken'), { recursive: true })
    // 非法：坏 JSON
    mkdirSync(join(roots.installed, 'badjson'), { recursive: true })
    writeFileSync(join(roots.installed, 'badjson', 'manifest.json'), '{oops')
    const registry = new SkinRegistry(nodeFs(), roots, builtin, jsonRegistryStorage(nodeFs(), join(roots.root, 'registry.json')))
    await registry.refresh()
    const ids = registry.list().map(e => e.id + ':' + e.source + ':' + e.state).sort()
    expect(ids).toEqual(['badjson:installed:corrupt', 'broken:installed:corrupt', 'clean:builtin:ok', 'local-one:installed:ok'])
  })

  it('installed 遮蔽同 id 内置并记录', async () => {
    const builtin = join(home, 'builtins')
    writeSkinFixture(builtin, 'clean')
    writeSkinFixture(roots.installed, 'clean')
    const registry = new SkinRegistry(nodeFs(), roots, builtin, jsonRegistryStorage(nodeFs(), join(roots.root, 'registry.json')))
    await registry.refresh()
    const entry = registry.get('clean')
    expect(entry?.source).toBe('installed')
    expect(entry?.shadowsBuiltin).toBe(true)
  })


  it('trust 标注：downloaded = untrusted，其余 = trusted', async () => {
    const builtin = join(home, 'builtins')
    writeSkinFixture(builtin, 'clean')
    writeSkinFixture(roots.installed, 'local-one')
    writeSkinFixture(roots.generated, 'gen-one')
    writeSkinFixture(roots.downloaded, 'dl-one')
    const registry = new SkinRegistry(nodeFs(), roots, builtin, jsonRegistryStorage(nodeFs(), join(roots.root, 'registry.json')))
    await registry.refresh()
    expect(registry.get('clean')?.trust).toBe('trusted')
    expect(registry.get('local-one')?.trust).toBe('trusted')
    expect(registry.get('gen-one')?.trust).toBe('trusted')
    expect(registry.get('dl-one')?.trust).toBe('untrusted')
  })

  it('persist/load：registry.json 原子写回与读回', async () => {
    const builtin = join(home, 'builtins')
    writeSkinFixture(builtin, 'clean')
    let writes = 0
    const atomicWrite = async (_p: string, text: string): Promise<void> => { writes++; writeFileSync(join(roots.root, 'registry.json'), text) }
    const registry = new SkinRegistry(nodeFs(), roots, builtin, jsonRegistryStorage(nodeFs(), join(roots.root, 'registry.json'), atomicWrite))
    await registry.hydrate()
    expect(writes).toBe(1)
    expect(existsSync(join(roots.root, 'registry.json'))).toBe(true)
    const parsed = JSON.parse(readFileSync(join(roots.root, 'registry.json'), 'utf8'))
    expect(parsed.schemaVersion).toBe(1)
    expect(parsed.entries.length).toBe(1)
  })
})
