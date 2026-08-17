import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { nodeFs, resolveInside } from '../../src/repository/fs'
import { SkinRepository } from '../../src/repository/repository'
import { resolveSkinRoots } from '../../src/repository/store'
import { cleanup, tempDir, writeSkinFixture } from '../helpers'

describe('Phase 3 Windows 文件系统专项（junction/大小写/rename 原子性/路径规范化）', () => {
  let home: string
  let roots: ReturnType<typeof resolveSkinRoots>

  beforeEach(() => {
    home = tempDir('dsh-skin-wf-')
    roots = resolveSkinRoots(home)
    for (const dir of [roots.installed, roots.generated, roots.downloaded, roots.staging, roots.cache]) mkdirSync(dir, { recursive: true })
  })
  afterEach(() => { cleanup(home) })

  it('junction 成员：安装拒绝（symlink 扫描），无半包', async () => {
    const outside = join(home, 'outside')
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(outside, 'secret.txt'), 'secret')
    const dir = writeSkinFixture(join(home, 'src'), 'wf-1')
    try { symlinkSync(outside, join(dir, 'theme', 'evil-link'), 'junction') } catch (e) { console.log('junction 创建失败（无权限？）', String(e)) }
    const repo = new SkinRepository(nodeFs(), roots, undefined)
    await repo.hydrate()
    const result = await repo.install(dir)
    expect(result.ok).toBe(false)
    expect(readdirSync(roots.installed)).toEqual([])
    expect(readdirSync(roots.staging)).toEqual([])
  })

  it('目录名大小写与 manifest.id 不一致 → invalid 状态（不 ok）', async () => {
    const dir = writeSkinFixture(join(home, 'src'), 'WF-2')
    const repo = new SkinRepository(nodeFs(), roots, undefined)
    await repo.hydrate()
    // install 时 manifest.id=WF-2 非法（大写）→ 拒绝
    expect((await repo.install(dir)).ok).toBe(false)
    // 直接落盘一个大小写不一致的目录 → discover 判 invalid
    const ok = writeSkinFixture(roots.installed, 'wf-lower')
    const repo2 = new SkinRepository(nodeFs(), roots, undefined)
    await repo2.hydrate()
    expect(repo2.get('wf-lower')?.state).toBe('ok')
  })

  it('resolveInside：盘符/绝对路径/反斜杠/协议/穿越全部拒绝', async () => {
    const root = join(home, 'pkg')
    mkdirSync(root, { recursive: true })
    expect(await resolveInside(nodeFs(), root, 'C:\\evil.txt')).toBeUndefined()
    expect(await resolveInside(nodeFs(), root, 'C:/evil.txt')).toBeUndefined()
    expect(await resolveInside(nodeFs(), root, '/abs/path')).toBeUndefined()
    expect(await resolveInside(nodeFs(), root, '..\\up.txt')).toBeUndefined()
    expect(await resolveInside(nodeFs(), root, '../up.txt')).toBeUndefined()
    expect(await resolveInside(nodeFs(), root, 'https://x/y')).toBeUndefined()
    const bs = String.fromCharCode(92)
    expect(await resolveInside(nodeFs(), root, 'sub' + bs + 'file.txt')).toBeUndefined()
    // 中间路径段必须存在且为目录（守卫语义）；目标本身可不存在
    mkdirSync(join(root, 'ok'), { recursive: true })
    expect(await resolveInside(nodeFs(), root, 'ok/file.txt')).toBe(join(root, 'ok', 'file.txt'))
  })

  it('同卷 rename 原子性：install 与 replace 在 Windows 同卷 rename 下完整落位', async () => {
    const v1 = writeSkinFixture(join(home, 'src1'), 'wf-3')
    const repo = new SkinRepository(nodeFs(), roots, undefined)
    await repo.hydrate()
    expect((await repo.install(v1)).ok).toBe(true)
    expect(existsSync(join(roots.installed, 'wf-3', 'manifest.json'))).toBe(true)
    const v2 = writeSkinFixture(join(home, 'src2'), 'wf-3')
    writeFileSync(join(v2, 'styles', 'theme.css'), 'body[data-dsh-skin="wf-3"] { color: blue; }')
    expect((await repo.replace(v2)).ok).toBe(true)
    expect(existsSync(join(roots.installed, 'wf-3', 'manifest.json'))).toBe(true)
    expect(readdirSync(roots.staging)).toEqual([])
    expect(repo.get('wf-3')?.state).toBe('ok')
  })
})

