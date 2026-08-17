import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { nodeFs, type FsLike } from '../../src/repository/fs'
import { SkinRepository } from '../../src/repository/repository'
import { resolveSkinRoots } from '../../src/repository/store'
import { cleanup, tempDir, writeSkinFixture } from '../helpers'

/** 故障注入包装：指定操作在第 N 次调用时抛错一次。 */
function faultFs(plan: Record<string, number>): FsLike {
  const base = nodeFs()
  const count: Record<string, number> = {}
  const wrap = (op: string, fn: (...args: never[]) => unknown) => (...args: never[]) => {
    count[op] = (count[op] ?? 0) + 1
    if (plan[op] !== undefined && count[op] === plan[op]) throw new Error('注入失败：' + op)
    return (fn as (...a: never[]) => unknown)(...args)
  }
  return {
    readFile: wrap('readFile', base.readFile),
    readText: wrap('readText', base.readText),
    writeFile: wrap('writeFile', base.writeFile),
    mkdir: wrap('mkdir', base.mkdir),
    rename: wrap('rename', base.rename),
    rm: wrap('rm', base.rm),
    readdir: wrap('readdir', base.readdir),
    lstat: wrap('lstat', base.lstat),
    stat: wrap('stat', base.stat),
    copyFile: wrap('copyFile', base.copyFile),
  } as FsLike
}

describe('Phase 3 Atomic Install / Uninstall / Replace（逐阶段失败注入 → 回滚无半包）', () => {
  let home: string
  let roots: ReturnType<typeof resolveSkinRoots>

  beforeEach(() => {
    home = tempDir('dsh-skin-at-')
    roots = resolveSkinRoots(home)
    for (const dir of [roots.installed, roots.generated, roots.downloaded, roots.staging, roots.cache]) mkdirSync(dir, { recursive: true })
  })
  afterEach(() => { cleanup(home) })

  it('install：stage 复制失败（copyFile 第 2 次）→ 拒绝 + staging 干净 + 无半包', async () => {
    const good = writeSkinFixture(join(home, 'src'), 'at-1')
    const repo = new SkinRepository(faultFs({ copyFile: 2 }), roots, undefined)
    await repo.hydrate()
    const result = await repo.install(good)
    expect(result.ok).toBe(false)
    expect(result.ok ? [] : result.issues.join(' ')).toContain('注入失败')
    expect(readdirSync(roots.staging)).toEqual([])
    expect(readdirSync(roots.installed)).toEqual([])
  })

  it('install：commit rename 失败 → 拒绝 + staging 干净 + 无半包', async () => {
    const good = writeSkinFixture(join(home, 'src'), 'at-2')
    const repo = new SkinRepository(faultFs({ rename: 1 }), roots, undefined)
    await repo.hydrate()
    const result = await repo.install(good)
    expect(result.ok).toBe(false)
    expect(readdirSync(roots.staging)).toEqual([])
    expect(readdirSync(roots.installed)).toEqual([])
  })

  it('install：registry persist 失败 → install 仍成功；重启对账后 registry==disk', async () => {
    const good = writeSkinFixture(join(home, 'src'), 'at-3')
    const failAtomic = async () => { throw new Error('disk full') }
    const repo = new SkinRepository(nodeFs(), roots, undefined, failAtomic)
    await repo.hydrate()
    expect((await repo.install(good)).ok).toBe(true)
    expect(existsSync(join(roots.installed, 'at-3', 'manifest.json'))).toBe(true)
    // 重启（新实例 + 正常原子写）→ registry 重建并回写
    const repo2 = new SkinRepository(nodeFs(), roots, undefined)
    await repo2.hydrate()
    expect(repo2.get('at-3')?.id).toBe('at-3')
    const saved = JSON.parse(readFileSync(join(roots.root, 'registry.json'), 'utf8')) as { entries: Array<{ id: string }> }
    expect(saved.entries.map(e => e.id)).toContain('at-3')
  })

  it('uninstall：rename 失败 → 拒绝；包仍在磁盘、registry 条目仍在；重启后仍一致', async () => {
    const good = writeSkinFixture(join(home, 'src'), 'at-4')
    const repo = new SkinRepository(nodeFs(), roots, undefined)
    await repo.hydrate()
    expect((await repo.install(good)).ok).toBe(true)
    const repo2 = new SkinRepository(faultFs({ rename: 1 }), roots, undefined)
    await repo2.hydrate()
    const result = await repo2.remove('at-4')
    expect(result.ok).toBe(false)
    expect(existsSync(join(roots.installed, 'at-4', 'manifest.json'))).toBe(true)
    const repo3 = new SkinRepository(nodeFs(), roots, undefined)
    await repo3.hydrate()
    expect(repo3.get('at-4')?.id).toBe('at-4')
  })

  it('uninstall：registry persist 失败 → remove 仍成功；重启对账后 registry 无该条目', async () => {
    const good = writeSkinFixture(join(home, 'src'), 'at-5')
    const failAtomic = async () => { throw new Error('disk full') }
    const repo = new SkinRepository(nodeFs(), roots, undefined)
    await repo.hydrate()
    expect((await repo.install(good)).ok).toBe(true)
    const repo2 = new SkinRepository(nodeFs(), roots, undefined, failAtomic)
    await repo2.hydrate()
    expect((await repo2.remove('at-5')).ok).toBe(true)
    expect(existsSync(join(roots.installed, 'at-5'))).toBe(false)
    const repo3 = new SkinRepository(nodeFs(), roots, undefined)
    await repo3.hydrate()
    expect(repo3.get('at-5')).toBeUndefined()
  })

  it('replace：新包 staged 校验失败（checksum 不符）→ 旧包原样、registry 不变', async () => {
    const v1 = writeSkinFixture(join(home, 'src1'), 'at-6')
    const repo = new SkinRepository(nodeFs(), roots, undefined)
    await repo.hydrate()
    expect((await repo.install(v1)).ok).toBe(true)
    const v2 = writeSkinFixture(join(home, 'src2'), 'at-6')
    writeFileSync(join(v2, 'integrity.json'), JSON.stringify({ algorithm: 'sha256', files: [{ path: 'manifest.json', size: 1, sha256: 'bad' }] }))
    const result = await repo.replace(v2)
    expect(result.ok).toBe(false)
    expect(existsSync(join(roots.installed, 'at-6', 'manifest.json'))).toBe(true)
    expect(repo.get('at-6')?.state).toBe('ok')
    expect(readdirSync(roots.staging)).toEqual([])
  })

  it('replace：同 id 同版本不同内容 → 原子替换成功，内容更新、完整性重算', async () => {
    const v1 = writeSkinFixture(join(home, 'src1'), 'at-7')
    const repo = new SkinRepository(nodeFs(), roots, undefined)
    await repo.hydrate()
    expect((await repo.install(v1)).ok).toBe(true)
    const v2 = writeSkinFixture(join(home, 'src2'), 'at-7')
    writeFileSync(join(v2, 'styles', 'theme.css'), 'body[data-dsh-skin="at-7"] { color: red; }')
    expect((await repo.replace(v2)).ok).toBe(true)
    const content = readFileSync(join(roots.installed, 'at-7', 'styles', 'theme.css'), 'utf8')
    expect(content).toContain('color: red')
    expect(repo.get('at-7')?.state).toBe('ok')
    expect(readdirSync(roots.staging)).toEqual([])
  })
})

