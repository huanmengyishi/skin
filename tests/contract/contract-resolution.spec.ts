import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { nodeFs } from '../../src/repository/fs'
import { SkinRepository } from '../../src/repository/repository'
import { resolveSkinRoots } from '../../src/repository/store'
import { cleanup, tempDir, writeSkinFixture } from '../helpers'

function versioned(root: string, id: string, version: string): string {
  const dir = writeSkinFixture(root, id)
  const fs = require('node:fs') as typeof import('node:fs')
  const manifest = JSON.parse(fs.readFileSync(join(dir, 'manifest.json'), 'utf8')) as Record<string, unknown>
  manifest.version = version
  fs.writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2))
  return dir
}

describe('Phase 3 Resolution / Precedence（级联删除 → 逐级降级）', () => {
  let home: string
  let roots: ReturnType<typeof resolveSkinRoots>

  beforeEach(() => {
    home = tempDir('dsh-skin-rs-')
    roots = resolveSkinRoots(home)
    for (const dir of [roots.installed, roots.generated, roots.downloaded, roots.staging, roots.cache]) mkdirSync(dir, { recursive: true })
  })
  afterEach(() => { cleanup(home) })

  it('同 id 四来源：installed > generated > downloaded > builtin；逐级删除逐级降级', async () => {
    const builtin = join(home, 'builtin')
    mkdirSync(builtin, { recursive: true })
    versioned(builtin, 'rs-x', '1.0.0')
    versioned(roots.downloaded, 'rs-x', '2.0.0')
    versioned(roots.generated, 'rs-x', '3.0.0')
    versioned(roots.installed, 'rs-x', '4.0.0')
    const repo = new SkinRepository(nodeFs(), roots, builtin)
    await repo.hydrate()
    const resolve = () => repo.get('rs-x')
    expect(resolve()?.source).toBe('installed')
    expect(resolve()?.version).toBe('4.0.0')
    expect(resolve()?.issues.some(i => i.includes('遮蔽'))).toBe(true)
    // 删除 installed → generated
    rmSync(join(roots.installed, 'rs-x'), { recursive: true, force: true })
    await repo.registry.refresh()
    expect(resolve()?.source).toBe('generated')
    expect(resolve()?.version).toBe('3.0.0')
    expect(resolve()?.issues.some(i => i.includes('遮蔽'))).toBe(true)
    // 删除 generated → downloaded
    rmSync(join(roots.generated, 'rs-x'), { recursive: true, force: true })
    await repo.registry.refresh()
    expect(resolve()?.source).toBe('downloaded')
    expect(resolve()?.version).toBe('2.0.0')
    expect(resolve()?.trust).toBe('untrusted')
    expect(resolve()?.issues.some(i => i.includes('遮蔽'))).toBe(true)
    // 删除 downloaded → builtin
    rmSync(join(roots.downloaded, 'rs-x'), { recursive: true, force: true })
    await repo.registry.refresh()
    expect(resolve()?.source).toBe('builtin')
    expect(resolve()?.version).toBe('1.0.0')
    expect(resolve()?.trust).toBe('trusted')
    expect(resolve()?.issues.some(i => i.includes('遮蔽'))).toBe(false)
  })
})

