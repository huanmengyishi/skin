import { describe, expect, it } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { trustOf, SKIN_RESOLUTION_POLICY } from '../../src/core/contract'
import { discoverPackages } from '../../src/repository/discover'
import { nodeFs } from '../../src/repository/fs'
import { SkinRepository } from '../../src/repository/repository'
import { resolveSkinRoots } from '../../src/repository/store'
import { cleanup, tempDir, writeSkinFixture } from '../helpers'

function writeVersionedSkin(root: string, id: string, version: string): string {
  const dir = writeSkinFixture(root, id)
  const manifest = JSON.parse(require('node:fs').readFileSync(join(dir, 'manifest.json'), 'utf8')) as Record<string, unknown>
  manifest.version = version
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2))
  return dir
}

describe('Phase 1 契约：Source / Trust 独立维度', () => {
  it('trustOf 静态边界：downloaded=untrusted，其余=trusted', () => {
    expect(trustOf('builtin')).toBe('trusted')
    expect(trustOf('installed')).toBe('trusted')
    expect(trustOf('generated')).toBe('trusted')
    expect(trustOf('downloaded')).toBe('untrusted')
  })

  it('Source 与 Trust 是两个维度：同一 source 的信任不随名称之外的任何条件变化', () => {
    for (const source of ['builtin', 'installed', 'generated', 'downloaded'] as const) {
      expect(trustOf(source)).toBe(trustOf(source))
    }
    expect(SKIN_RESOLUTION_POLICY.precedence).toEqual(['installed', 'generated', 'downloaded', 'builtin'])
  })
})

describe('Phase 1 契约：SkinResolutionPolicy', () => {
  it('同 id 四来源冲突：installed > generated > downloaded > builtin，遮蔽记录 issue', async () => {
    const home = tempDir('dsh-skin-policy-')
    try {
      const roots = resolveSkinRoots(home)
      for (const dir of [roots.installed, roots.generated, roots.downloaded, roots.staging, roots.cache]) mkdirSync(dir, { recursive: true })
      const builtin = join(home, 'builtin')
      mkdirSync(builtin, { recursive: true })
      writeVersionedSkin(builtin, 'skin-x', '1.0.0')
      writeVersionedSkin(roots.downloaded, 'skin-x', '2.0.0')
      writeVersionedSkin(roots.generated, 'skin-x', '3.0.0')
      writeVersionedSkin(roots.installed, 'skin-x', '4.0.0')
      const discovered = await discoverPackages(nodeFs(), builtin, roots.installed, roots.generated, roots.downloaded)
      expect(discovered).toHaveLength(1)
      const winner = discovered[0]
      expect(winner.source).toBe('installed')
      expect(winner.manifest?.version).toBe('4.0.0')
      expect(winner.issues.some(i => i.includes('遮蔽'))).toBe(true)
    } finally { cleanup(home) }
  })

  it('无 installed/generated 时 downloaded 遮蔽 builtin；只有 builtin 时 builtin 胜出且无遮蔽', async () => {
    const home = tempDir('dsh-skin-policy2-')
    try {
      const roots = resolveSkinRoots(home)
      for (const dir of [roots.installed, roots.generated, roots.downloaded, roots.staging, roots.cache]) mkdirSync(dir, { recursive: true })
      const builtin = join(home, 'builtin')
      mkdirSync(builtin, { recursive: true })
      writeVersionedSkin(builtin, 'skin-y', '1.0.0')
      writeVersionedSkin(roots.downloaded, 'skin-y', '9.9.9')
      const discovered = await discoverPackages(nodeFs(), builtin, roots.installed, roots.generated, roots.downloaded)
      expect(discovered[0].source).toBe('downloaded')
      expect(discovered[0].manifest?.version).toBe('9.9.9')
      expect(discovered[0].issues.some(i => i.includes('遮蔽'))).toBe(true)
    } finally { cleanup(home) }
  })

  it('安装冲突：同 id 二次 install 拒绝；replace 走回滚语义；builtin 不可覆盖/不可卸载', async () => {
    const home = tempDir('dsh-skin-policy3-')
    try {
      const roots = resolveSkinRoots(home)
      for (const dir of [roots.installed, roots.generated, roots.downloaded, roots.staging, roots.cache]) mkdirSync(dir, { recursive: true })
      const builtin = join(home, 'builtin')
      mkdirSync(builtin, { recursive: true })
      writeVersionedSkin(builtin, 'skin-z', '1.0.0')
      const repo = new SkinRepository(nodeFs(), roots, builtin)
      await repo.hydrate()
      expect(repo.get('skin-z')?.source).toBe('builtin')
      const source = writeVersionedSkin(join(home, 'src'), 'skin-z', '2.0.0')
      expect((await repo.install(source)).ok).toBe(false)
      expect((await repo.replace(source)).ok).toBe(false)
      expect((await repo.remove('skin-z')).ok).toBe(false)
      expect(repo.get('skin-z')?.version).toBe('1.0.0')
      // 非内置：install 冲突拒绝、replace 成功
      const other = writeVersionedSkin(join(home, 'src2'), 'fresh', '1.0.0')
      expect((await repo.install(other)).ok).toBe(true)
      const otherV2 = writeVersionedSkin(join(home, 'src3'), 'fresh', '2.0.0')
      expect((await repo.install(otherV2)).ok).toBe(false)
      expect((await repo.replace(otherV2)).ok).toBe(true)
      expect(repo.get('fresh')?.version).toBe('2.0.0')
    } finally { cleanup(home) }
  })
})

