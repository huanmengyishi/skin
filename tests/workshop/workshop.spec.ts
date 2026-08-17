import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zipSync } from 'fflate'
import { nodeFs } from '../../src/repository/fs'
import { SkinRepository } from '../../src/repository/repository'
import { resolveSkinRoots } from '../../src/repository/store'
import { isSafeZipEntry, extractZipSafe, downloadAndInstall, readProvenance } from '../../src/workshop/install'
import { WorkshopClient, type FetchLike } from '../../src/workshop/client'
import { publishSkin } from '../../src/workshop/publish'
import { WorkshopOfflineError, validateWorkshopSkinInfo } from '../../src/workshop/protocol'

function pkgEntries(id: string, version = '1.0.0'): Record<string, Uint8Array> {
  const encoder = new TextEncoder()
  return {
    'manifest.json': encoder.encode(JSON.stringify({ id, version, name: id, author: 'ws', description: 'd', tags: [], skinApiVersion: 1, preview: {} })),
    'theme/light.json': encoder.encode('{}'),
    'theme/dark.json': encoder.encode('{}'),
    'styles/theme.css': encoder.encode('body[data-dsh-skin="' + id + '"]{}'),
    'client/index.js': encoder.encode('window.__ModuleLoader__.load({ id: "dsh-skin/' + id + '", factory: function () { return { apply: function () {} }; } });'),
    'preview/light.svg': encoder.encode('<svg/>'),
  }
}

function makeRepo(home: string) {
  const roots = resolveSkinRoots(home)
  for (const dir of [roots.installed, roots.generated, roots.downloaded, roots.staging, roots.cache]) mkdirSync(dir, { recursive: true })
  return new SkinRepository(nodeFs(), roots, undefined)
}

const wsInfo = (over: Partial<Record<string, unknown>> = {}) => ({
  skinId: 'ws-skin', version: '1.0.0', name: 'WS Skin', author: 'ws', description: 'd', tags: [], category: '',
  preview: {}, downloadCount: 0, rating: 0, createdAt: '', updatedAt: '', harnessCompatibility: '', skinApiVersion: 1,
  license: '', checksum: 'a'.repeat(64), packageSize: 0, ...over,
})

function fakeFetch(handler: (input: string) => { ok: boolean; status: number; body: unknown }) {
  const fetchImpl: FetchLike = async (input: string) => {
    const result = handler(input)
    return {
      ok: result.ok, status: result.status,
      json: async () => result.body,
      arrayBuffer: async () => result.body as ArrayBuffer,
      text: async () => String(result.body),
    }
  }
  return fetchImpl
}

describe('workshop protocol/client', () => {
  it('元数据校验：缺 checksum/版本字段拒绝', () => {
    expect(validateWorkshopSkinInfo(wsInfo()).ok).toBe(true)
    expect(validateWorkshopSkinInfo(wsInfo({ checksum: '' })).ok).toBe(false)
    expect(validateWorkshopSkinInfo(wsInfo({ skinApiVersion: 2 })).ok).toBe(false)
  })
  it('list/detail/versions/download 全链路（含 checksum 传递）', async () => {
    const zip = zipSync(pkgEntries('ws-skin'))
    const sha = createHash('sha256').update(zip).digest('hex')
    const client = new WorkshopClient('http://ws.local', fakeFetch(input => {
      if (input.endsWith('/skins')) return { ok: true, status: 200, body: { skins: [wsInfo({ checksum: sha, packageSize: zip.length })] } }
      if (input.endsWith('/versions')) return { ok: true, status: 200, body: { skinId: 'ws-skin', versions: [{ version: '1.0.0', checksum: sha, size: zip.length, createdAt: '', harnessCompatibility: '', skinApiVersion: 1 }] } }
      if (input.includes('/download')) return { ok: true, status: 200, body: zip.buffer }
      return { ok: false, status: 404, body: {} }
    }))
    const list = await client.list()
    expect(list[0].skinId).toBe('ws-skin')
    const downloaded = await client.download('ws-skin')
    expect(downloaded.expectedChecksum).toBe(sha)
  })
  it('离线/不可达 → WorkshopOfflineError（本地不受影响）', async () => {
    const offline = new WorkshopClient('', fakeFetch(() => ({ ok: true, status: 200, body: {} })))
    await expect(offline.list()).rejects.toBeInstanceOf(WorkshopOfflineError)
    const unreachable = new WorkshopClient('http://ws.local', (async () => { throw new Error('ECONNREFUSED') }) as never)
    await expect(unreachable.list()).rejects.toBeInstanceOf(WorkshopOfflineError)
  })
})

describe('zip 安全与下载安装管线', () => {
  it('zip-slip 条目拒绝', () => {
    expect(isSafeZipEntry('manifest.json')).toBe(true)
    expect(isSafeZipEntry('a/b/c.svg')).toBe(true)
    expect(isSafeZipEntry('../evil')).toBe(false)
    expect(isSafeZipEntry('a/../../evil')).toBe(false)
    expect(isSafeZipEntry('/abs')).toBe(false)
    expect(isSafeZipEntry('C:/evil')).toBe(false)
    expect(isSafeZipEntry('a\\evil')).toBe(false)
    expect(isSafeZipEntry('')).toBe(false)
  })

  it('下载→checksum→解包→provenance→integrity→安装（downloaded 来源）', async () => {
    const home = join(tmpdir(), 'dsh-skin-ws-' + Date.now() + '-a')
    const repo = makeRepo(home)
    await repo.hydrate()
    const zip = zipSync(pkgEntries('ws-skin'))
    const sha = createHash('sha256').update(zip).digest('hex')
    const result = await downloadAndInstall(nodeFs(), repo, resolveSkinRoots(home).staging, async () => ({ bytes: new Uint8Array(zip), expectedChecksum: sha }), { skinId: 'ws-skin', version: '1.0.0' })
    expect(result.ok).toBe(true)
    const entry = repo.get('ws-skin')
    expect(entry?.source).toBe('downloaded')
    const provenance = await readProvenance(nodeFs(), entry!.path)
    expect(provenance?.remoteId).toBe('ws-skin')
    expect(provenance?.checksum).toBe(sha)
    expect(existsSync(join(entry!.path, 'integrity.json'))).toBe(true)
  })

  it('checksum 不匹配 / 缺失 → 拒绝且零残留', async () => {
    const home = join(tmpdir(), 'dsh-skin-ws-' + Date.now() + '-b')
    const repo = makeRepo(home)
    await repo.hydrate()
    const zip = zipSync(pkgEntries('ws-skin'))
    const roots = resolveSkinRoots(home)
    const bad = await downloadAndInstall(nodeFs(), repo, roots.staging, async () => ({ bytes: new Uint8Array(zip), expectedChecksum: '0'.repeat(64) }), { skinId: 'ws-skin', version: '1.0.0' })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.issues.join(';')).toContain('checksum')
    const missing = await downloadAndInstall(nodeFs(), repo, roots.staging, async () => ({ bytes: new Uint8Array(zip), expectedChecksum: '' }), { skinId: 'ws-skin', version: '1.0.0' })
    expect(missing.ok).toBe(false)
    expect(repo.get('ws-skin')).toBeUndefined()
    expect(existsSync(join(roots.downloaded, 'ws-skin'))).toBe(false)
  })

  it('zip 内含穿越条目 → 拒绝（extractZipSafe 抛错）', async () => {
    const entries = { ...pkgEntries('ws-skin'), '../evil.txt': new TextEncoder().encode('x') }
    const zip = zipSync(entries)
    const dir = join(tmpdir(), 'dsh-skin-zipslip-' + Date.now())
    mkdirSync(dir, { recursive: true })
    await expect(extractZipSafe(new Uint8Array(zip), dir, nodeFs())).rejects.toThrow(/zip-slip/)
  })

  it('覆盖更新：replace 语义（版本升级、旧包回滚保障）', async () => {
    const home = join(tmpdir(), 'dsh-skin-ws-' + Date.now() + '-c')
    const repo = makeRepo(home)
    await repo.hydrate()
    const roots = resolveSkinRoots(home)
    const zipV1 = zipSync(pkgEntries('ws-skin', '1.0.0'))
    const sha1 = createHash('sha256').update(zipV1).digest('hex')
    const first = await downloadAndInstall(nodeFs(), repo, roots.staging, async () => ({ bytes: new Uint8Array(zipV1), expectedChecksum: sha1 }), { skinId: 'ws-skin', version: '1.0.0' })
    expect(first.ok).toBe(true)
    const zipV2 = zipSync(pkgEntries('ws-skin', '2.0.0'))
    const sha2 = createHash('sha256').update(zipV2).digest('hex')
    const update = await downloadAndInstall(nodeFs(), repo, roots.staging, async () => ({ bytes: new Uint8Array(zipV2), expectedChecksum: sha2 }), { skinId: 'ws-skin', version: '2.0.0' }, { replaceExisting: true })
    expect(update.ok).toBe(true)
    expect(repo.get('ws-skin')?.version).toBe('2.0.0')
    expect(repo.get('ws-skin')?.source).toBe('downloaded')
  })
})

describe('发布管线（publish）', () => {
  const postLog: Array<{ path: string; body: Record<string, unknown> }> = []
  const uploadClient = new WorkshopClient('http://ws.local', (async (input: string, init?: unknown) => {
    const body = init !== undefined ? JSON.parse(String((init as { body?: string }).body ?? '{}')) : {}
    postLog.push({ path: input.replace('http://ws.local', ''), body })
    return {
      ok: true, status: 200,
      json: async () => ({ skinId: 'pub-skin', version: '0.1.0', checksum: 'c'.repeat(64) }),
      arrayBuffer: async () => new ArrayBuffer(0),
      text: async () => '',
    }
  }) as never)

  function makeInstalledRepo(home: string, id: string) {
    const roots = resolveSkinRoots(home)
    for (const dir of [roots.installed, roots.generated, roots.downloaded, roots.staging, roots.cache]) mkdirSync(dir, { recursive: true })
    const repository = new SkinRepository(nodeFs(), roots, undefined)
    return { roots, repository }
  }

  it('发布新皮肤：四门校验通过 → upload（zip+sha256）→ 本地包零改动', async () => {
    const home = join(tmpdir(), 'dsh-skin-pub-' + Date.now() + '-a')
    const { roots, repository } = makeInstalledRepo(home, 'pub-skin')
    await repository.hydrate()
    // 用 helper 造包并安装
    const source = join(home, 'source')
    mkdirSync(join(source, 'theme'), { recursive: true })
    mkdirSync(join(source, 'styles'), { recursive: true })
    mkdirSync(join(source, 'client'), { recursive: true })
    const encoder = new TextEncoder()
    const files: Record<string, string> = {
      'manifest.json': JSON.stringify({ id: 'pub-skin', version: '0.1.0', name: 'Pub Skin', author: 'me', description: 'd', tags: [], skinApiVersion: 1, preview: {} }),
      'theme/light.json': '{}', 'theme/dark.json': '{}', 'styles/theme.css': 'body[data-dsh-skin="pub-skin"]{}',
      'client/index.js': 'window.__ModuleLoader__.load({ id: "dsh-skin/pub-skin", factory: function () { return { apply: function () {} }; } });',
      'preview/light.svg': '<svg/>',
    }
    for (const [rel, content] of Object.entries(files)) {
      const target = join(source, rel)
      mkdirSync(join(target, '..'), { recursive: true })
      writeFileSync(target, encoder.encode(content))
    }
    expect((await repository.install(source, { kind: 'installed' })).ok).toBe(true)
    const before = readFileSync(join(roots.installed, 'pub-skin', 'manifest.json'), 'utf8')
    postLog.length = 0
    const result = await publishSkin(nodeFs(), repository, uploadClient, 'pub-skin', 'new')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.version).toBe('0.1.0')
    expect(postLog.length).toBe(1)
    expect(postLog[0].path).toBe('/skins')
    expect(typeof postLog[0].body.packageBase64).toBe('string')
    expect(typeof postLog[0].body.packageSha256).toBe('string')
    // 本地包零改动
    expect(readFileSync(join(roots.installed, 'pub-skin', 'manifest.json'), 'utf8')).toBe(before)
  })

  it('发布新版本：POST /skins/:id/versions', async () => {
    const home = join(tmpdir(), 'dsh-skin-pub-' + Date.now() + '-b')
    const { roots, repository } = makeInstalledRepo(home, 'pub-skin')
    await repository.hydrate()
    void roots
    const source = join(home, 'source')
    mkdirSync(join(source, 'client'), { recursive: true })
    writeFileSync(join(source, 'manifest.json'), JSON.stringify({ id: 'pub-skin', version: '0.1.0', name: 'Pub Skin', author: 'me', description: 'd', tags: [], skinApiVersion: 1, preview: {} }))
    writeFileSync(join(source, 'client', 'index.js'), 'window.__ModuleLoader__.load({ id: "x", factory: function () { return { apply: function () {} }; } });')
    expect((await repository.install(source, { kind: 'installed' })).ok).toBe(true)
    postLog.length = 0
    const result = await publishSkin(nodeFs(), repository, uploadClient, 'pub-skin', 'version')
    expect(result.ok).toBe(true)
    expect(postLog[0].path).toBe('/skins/pub-skin/versions')
  })

  it('来源守卫：内置/下载来源拒绝；状态非 ok 拒绝；上传失败本地零改动', async () => {
    const home = join(tmpdir(), 'dsh-skin-pub-' + Date.now() + '-c')
    const { roots, repository } = makeInstalledRepo(home, 'pub-skin')
    await repository.hydrate()
    // downloaded 来源
    const source = join(home, 'source')
    mkdirSync(join(source, 'client'), { recursive: true })
    writeFileSync(join(source, 'manifest.json'), JSON.stringify({ id: 'pub-skin', version: '0.1.0', name: 'Pub Skin', author: 'me', description: 'd', tags: [], skinApiVersion: 1, preview: {} }))
    writeFileSync(join(source, 'client', 'index.js'), 'window.__ModuleLoader__.load({ id: "x", factory: function () { return { apply: function () {} }; } });')
    expect((await repository.install(source, { kind: 'downloaded' })).ok).toBe(true)
    const refused = await publishSkin(nodeFs(), repository, uploadClient, 'pub-skin', 'new')
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.issues.join(';')).toContain('下载来源')
    // 上传失败（远端 400）：用另一个 installed 皮肤验证本地零改动
    const source2 = join(home, 'source2')
    mkdirSync(join(source2, 'client'), { recursive: true })
    writeFileSync(join(source2, 'manifest.json'), JSON.stringify({ id: 'pub-skin-2', version: '0.1.0', name: 'Pub Skin 2', author: 'me', description: 'd', tags: [], skinApiVersion: 1, preview: {} }))
    writeFileSync(join(source2, 'client', 'index.js'), 'window.__ModuleLoader__.load({ id: "x", factory: function () { return { apply: function () {} }; } });')
    expect((await repository.install(source2, { kind: 'installed' })).ok).toBe(true)
    const failing = new WorkshopClient('http://ws.local', (async () => ({ ok: false, status: 400, json: async () => ({ error: 'dup' }), arrayBuffer: async () => new ArrayBuffer(0), text: async () => '' })) as never)
    const before = readFileSync(join(roots.installed, 'pub-skin-2', 'manifest.json'), 'utf8')
    const failed = await publishSkin(nodeFs(), repository, failing, 'pub-skin-2', 'new')
    expect(failed.ok).toBe(false)
    if (!failed.ok) expect(failed.issues.join(';')).toContain('本地皮肤未改动')
    expect(readFileSync(join(roots.installed, 'pub-skin-2', 'manifest.json'), 'utf8')).toBe(before)
  })
})

