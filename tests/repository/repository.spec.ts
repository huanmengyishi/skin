import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { nodeFs } from '../../src/repository/fs'
import { SkinRepository } from '../../src/repository/repository'
import { resolveSkinRoots } from '../../src/repository/store'
import { cleanup, tempDir, writeSkinFixture } from '../helpers'

describe('SkinRepository', () => {
  let home: string
  let roots: ReturnType<typeof resolveSkinRoots>

  beforeEach(() => {
    home = tempDir('dsh-skin-repo-')
    roots = resolveSkinRoots(home)
    mkdirSync(roots.installed, { recursive: true })
    mkdirSync(roots.staging, { recursive: true })
    mkdirSync(roots.cache, { recursive: true })
  })

  afterEach(() => { cleanup(home) })

  function makeRepo(builtinRoot?: string): SkinRepository {
    return new SkinRepository(nodeFs(), roots, builtinRoot)
  }

  it('install：staging→校验→原子落位，discover/load 闭环', async () => {
    const source = writeSkinFixture(join(home, 'source'), 'local-one')
    const repo = makeRepo()
    await repo.hydrate()
    const result = await repo.install(source)
    expect(result.ok).toBe(true)
    expect(existsSync(join(roots.installed, 'local-one', 'manifest.json'))).toBe(true)
    // integrity.json 在首次安装时生成
    expect(existsSync(join(roots.installed, 'local-one', 'integrity.json'))).toBe(true)
    expect(readdirSync(roots.staging)).toEqual([])
    expect(repo.get('local-one')?.state).toBe('ok')
    // 读文件
    const bytes = await repo.readFile('local-one', 'styles/theme.css')
    expect(bytes).toBeDefined()
  })

  it('install：重复 ID 拒绝且不落任何半成品', async () => {
    const source = writeSkinFixture(join(home, 'source'), 'dup')
    const repo = makeRepo()
    await repo.hydrate()
    expect((await repo.install(source)).ok).toBe(true)
    const second = await repo.install(source)
    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.issues.join(';')).toContain('已存在')
    expect(readdirSync(roots.staging)).toEqual([])
    expect(readdirSync(roots.installed)).toEqual(['dup'])
  })

  it('install：manifest 非法拒绝', async () => {
    const source = writeSkinFixture(join(home, 'source'), 'bad')
    writeFileSync(join(source, 'manifest.json'), JSON.stringify({ id: 'BAD' }))
    const repo = makeRepo()
    await repo.hydrate()
    const result = await repo.install(source)
    expect(result.ok).toBe(false)
    expect(readdirSync(roots.installed)).toEqual([])
    expect(readdirSync(roots.staging)).toEqual([])
  })

  it('install：含 symlink 的源被拒绝且清理 staging', async () => {
    const source = writeSkinFixture(join(home, 'source'), 'linked')
    mkdirSync(join(home, 'outside'), { recursive: true })
    writeFileSync(join(home, 'outside', 'secret.txt'), 's')
    let canSymlink = true
    try { symlinkSync(join(home, 'outside'), join(source, 'evil'), 'junction') } catch { canSymlink = false }
    if (!canSymlink) return
    const repo = makeRepo()
    await repo.hydrate()
    const result = await repo.install(source)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.issues.join(';')).toContain('symlink')
    expect(readdirSync(roots.installed)).toEqual([])
    expect(readdirSync(roots.staging)).toEqual([])
  })

  it('install：integrity 篡改检测（源带 integrity.json 但文件被改）', async () => {
    const source = writeSkinFixture(join(home, 'source'), 'integrity-skin')
    // 用 hashPackage 生成清单后篡改一个文件
    const { hashPackage } = await import('../../src/core/integrity')
    const computed = await hashPackage(nodeFs(), source)
    writeFileSync(join(source, 'integrity.json'), JSON.stringify(computed))
    writeFileSync(join(source, 'styles', 'theme.css'), 'body {} /* tampered */')
    const repo = makeRepo()
    await repo.hydrate()
    const result = await repo.install(source)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.issues.join(';')).toContain('完整性')
    expect(readdirSync(roots.installed)).toEqual([])
    expect(readdirSync(roots.staging)).toEqual([])
  })

  it('remove：installed 可卸载；builtin 拒绝', async () => {
    const builtin = join(home, 'builtins')
    writeSkinFixture(builtin, 'clean')
    const source = writeSkinFixture(join(home, 'source'), 'local-one')
    const repo = makeRepo(builtin)
    await repo.hydrate()
    expect((await repo.install(source)).ok).toBe(true)
    expect((await repo.remove('local-one')).ok).toBe(true)
    expect(repo.get('local-one')).toBeUndefined()
    expect(existsSync(join(roots.installed, 'local-one'))).toBe(false)
    const reject = await repo.remove('clean')
    expect(reject.ok).toBe(false)
    if (!reject.ok) expect(reject.issues.join(';')).toContain('内置')
  })


  it('replace：覆盖 generated 成功（旧包清理）', async () => {
    const source = writeSkinFixture(join(home, 'source'), 'gen-skin')
    const repo = makeRepo()
    await repo.hydrate()
    expect((await repo.install(source, { kind: 'generated' })).ok).toBe(true)
    expect(repo.get('gen-skin')?.source).toBe('generated')
    // 修改源包（版本变更）再 replace
    const manifestPath = join(source, 'manifest.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    manifest.version = '2.0.0'
    writeFileSync(manifestPath, JSON.stringify(manifest))
    expect((await repo.replace(source, { kind: 'generated' })).ok).toBe(true)
    expect(repo.get('gen-skin')?.version).toBe('2.0.0')
    expect(readdirSync(roots.staging)).toEqual([])
  })

  it('replace：新包安装失败时回滚恢复旧包', async () => {
    const source = writeSkinFixture(join(home, 'source'), 'gen-skin')
    const repo = makeRepo()
    await repo.hydrate()
    expect((await repo.install(source, { kind: 'generated' })).ok).toBe(true)
    // 制造一个含 symlink 的替换源（copy 阶段失败）
    const badSource = writeSkinFixture(join(home, 'badsource'), 'gen-skin')
    mkdirSync(join(home, 'outside'), { recursive: true })
    writeFileSync(join(home, 'outside', 'secret.txt'), 's')
    let canSymlink = true
    try { symlinkSync(join(home, 'outside'), join(badSource, 'evil'), 'junction') } catch { canSymlink = false }
    if (!canSymlink) return
    const result = await repo.replace(badSource, { kind: 'generated' })
    expect(result.ok).toBe(false)
    // 旧包完好、版本仍是 1.0.0、staging 干净
    expect(repo.get('gen-skin')?.version).toBe('1.0.0')
    expect(existsSync(join(roots.generated, 'gen-skin', 'manifest.json'))).toBe(true)
    expect(readdirSync(roots.staging)).toEqual([])
  })

  it('replace：内置拒绝；不存在则走 install', async () => {
    const builtin = join(home, 'builtins')
    writeSkinFixture(builtin, 'clean')
    const repo = makeRepo(builtin)
    await repo.hydrate()
    const fresh = writeSkinFixture(join(home, 'fresh'), 'fresh-skin')
    const first = await repo.replace(fresh, { kind: 'installed' })
    expect(first.ok).toBe(true)
    expect(repo.get('fresh-skin')?.source).toBe('installed')
    const reject = await repo.replace(fresh, { kind: 'installed' })
    void reject
    const builtinReject = await repo.replace(join(builtin, 'clean'))
    expect(builtinReject.ok).toBe(false)
    if (!builtinReject.ok) expect(builtinReject.issues.join(';')).toContain('内置')
  })


  it('install：可执行文件 / 远程 URL 被安全门拒绝且零残留', async () => {
    const repo = makeRepo()
    await repo.hydrate()
    // exe
    const sourceExe = writeSkinFixture(join(home, 'source-exe'), 'evil-skin')
    writeFileSync(join(sourceExe, 'payload.exe'), 'x')
    const exeResult = await repo.install(sourceExe)
    expect(exeResult.ok).toBe(false)
    if (!exeResult.ok) expect(exeResult.issues.join(';')).toContain('安全扫描')
    // 远程 URL
    const sourceUrl = writeSkinFixture(join(home, 'source-url'), 'track-skin')
    writeFileSync(join(sourceUrl, 'styles', 'theme.css'), 'body { background: url("https://evil/x.png"); }')
    const urlResult = await repo.install(sourceUrl)
    expect(urlResult.ok).toBe(false)
    if (!urlResult.ok) expect(urlResult.issues.join(';')).toContain('远程 URL')
    expect(readdirSync(roots.installed)).toEqual([])
    expect(readdirSync(roots.staging)).toEqual([])
  })

  it('fileRef：路径穿越被守卫拒绝', async () => {
    const builtin = join(home, 'builtins')
    writeSkinFixture(builtin, 'clean')
    const repo = makeRepo(builtin)
    await repo.hydrate()
    expect(await repo.fileRef('clean', '../secret')).toBeUndefined()
    expect(await repo.fileRef('clean', 'client/../../x')).toBeUndefined()
    expect((await repo.fileRef('clean', 'client/index.js'))?.rel).toBe('client/index.js')
  })
})
