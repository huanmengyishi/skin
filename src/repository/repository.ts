/**
 * SkinRepository：Skin 包的门面。
 * 职责 = discover / read / load / install / uninstall（文件与包语义）；
 * 注册表元数据归 SkinRegistry；持久化归 RegistryStorage。
 * 安装流程：校验源 → staging 复制 → 二次校验（含完整性）→ atomic rename → registry 刷新。
 * @module dsh-skin/src/repository/repository
 */

import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { hashPackage, verifyPackage } from '../core/integrity.ts'
import { isValidSkinId, validateManifest, type SkinManifest } from '../core/manifest.ts'
import { scanPackageSecurity } from './security.ts'
import { copyDirRecursive, nodeFs, resolveInside, type FsLike } from './fs.ts'
import { SkinRegistry, jsonRegistryStorage, type SkinRegistryEntry } from './registry.ts'
import { INTEGRITY_FILENAME, MANIFEST_FILENAME, type SkinRoots } from './store.ts'

export type RepositoryResult = { ok: true } | { ok: false; issues: string[] }

export type InstallKind = 'installed' | 'generated' | 'downloaded'

export interface InstallOptions {
  kind?: InstallKind
}

export interface SkinFileRef {
  /** 包内相对路径 */
  rel: string
  /** 绝对路径（仅宿主进程内使用，绝不发给浏览器） */
  abs: string
}

export class SkinRepository {
  readonly registry: SkinRegistry
  private readonly atomicWrite?: (path: string, text: string) => Promise<void>

  constructor(
    private readonly fs: FsLike,
    private readonly roots: SkinRoots,
    builtinRoot: string | undefined,
    atomicWrite?: (path: string, text: string) => Promise<void>,
  ) {
    this.atomicWrite = atomicWrite
    const storage = jsonRegistryStorage(fs, join(roots.root, 'registry.json'), atomicWrite)
    this.registry = new SkinRegistry(fs, roots, builtinRoot, storage)
  }

  /** 启动对账：读缓存 → 磁盘权威 → 回写。
   *  F 证据驱动：staging 中的中断操作孤儿目录（install 与 replace-old 与 remove 前缀）在启动时清扫——
   *  没有任何安装/替换/卸载操作能跨进程存活，staging 是纯暂存区，残留即中断证据。 */
  async hydrate(): Promise<void> {
    await this.fs.mkdir(this.roots.installed, { recursive: true })
    await this.fs.mkdir(this.roots.generated, { recursive: true })
    await this.fs.mkdir(this.roots.downloaded, { recursive: true })
    await this.fs.mkdir(this.roots.staging, { recursive: true })
    await this.fs.mkdir(this.roots.cache, { recursive: true })
    await this.sweepStaging()
    await this.registry.hydrate()
  }

  /** 清扫 staging 中的中断操作孤儿目录（幂等；仅匹配本仓库的孤儿命名前缀）。 */
  private async sweepStaging(): Promise<void> {
    let entries
    try {
      entries = await this.fs.readdir(this.roots.staging)
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (/^\.(install-|replace-old-|remove-)/.test(entry.name)) {
        await this.fs.rm(join(this.roots.staging, entry.name), { recursive: true, force: true }).catch(() => undefined)
      }
    }
  }

  list(): SkinRegistryEntry[] {
    return this.registry.list()
  }

  get(id: string): SkinRegistryEntry | undefined {
    return this.registry.get(id)
  }

  /** 读取包内文件的字节（经路径守卫）。 */
  async readFile(id: string, rel: string): Promise<Uint8Array | undefined> {
    const ref = await this.fileRef(id, rel)
    if (ref === undefined) return undefined
    try {
      return await this.fs.readFile(ref.abs)
    } catch {
      return undefined
    }
  }

  /** 包内相对路径 → 受守卫的绝对路径。 */
  async fileRef(id: string, rel: string): Promise<SkinFileRef | undefined> {
    const entry = this.registry.get(id)
    if (entry === undefined || entry.state === 'corrupt') return undefined
    const abs = await resolveInside(this.fs, entry.path, rel)
    if (abs === undefined) return undefined
    return { rel, abs }
  }

  /** 来源根目录（kind 决定落位 installed/generated/downloaded）。 */
  private rootOf(kind: InstallKind): string {
    switch (kind) {
      case 'generated': return this.roots.generated
      case 'downloaded': return this.roots.downloaded
      case 'installed':
      default: return this.roots.installed
    }
  }

  /**
   * 安装一个皮肤包目录（Phase 1 输入 = 目录；zip 输入随 Workshop 接入同一流程）。
   * 任何失败都不在目标根留下半成品。
   */
  async install(sourceDir: string, options: InstallOptions = {}): Promise<RepositoryResult> {
    const kind = options.kind ?? 'installed'
    const issues: string[] = []
    // 1. 源目录校验（manifest 语义）
    let manifest: SkinManifest
    try {
      const raw = JSON.parse(await this.fs.readText(join(sourceDir, MANIFEST_FILENAME)))
      const result = validateManifest(raw)
      if (!result.ok) return { ok: false, issues: result.issues.map(i => i.path + ' ' + i.message) }
      manifest = result.manifest
    } catch {
      return { ok: false, issues: ['源目录不是合法 Skin Package：无法读取/解析 manifest.json'] }
    }
    if (!isValidSkinId(manifest.id)) {
      return { ok: false, issues: ['非法 Skin ID：' + manifest.id] }
    }
    if (this.registry.has(manifest.id)) {
      return { ok: false, issues: ['ID 已存在：' + manifest.id + '（先 remove 或换 ID）'] }
    }
    // 2. staging 复制（拒绝 symlink）
    const tmpDir = join(this.roots.staging, '.install-' + randomBytes(6).toString('hex'))
    try {
      await copyDirRecursive(this.fs, sourceDir, tmpDir)
    } catch (error) {
      await this.fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined)
      return { ok: false, issues: ['staging 复制失败：' + String((error as Error).message)] }
    }
    // 3. staged 二次校验 + 安全门 + 完整性（integrity.json 存在则必须匹配；缺失则生成）
    try {
      const securityIssues = await scanPackageSecurity(this.fs, tmpDir)
      if (securityIssues.length > 0) {
        throw new Error('安全扫描拒绝：' + securityIssues.join('；'))
      }
      const stagedManifestRaw = JSON.parse(await this.fs.readText(join(tmpDir, MANIFEST_FILENAME)))
      const stagedResult = validateManifest(stagedManifestRaw)
      if (!stagedResult.ok || stagedResult.manifest.id !== manifest.id) {
        throw new Error('staged manifest 校验失败')
      }
      let integrityRaw: unknown
      try {
        integrityRaw = JSON.parse(await this.fs.readText(join(tmpDir, INTEGRITY_FILENAME)))
      } catch {
        integrityRaw = undefined
      }
      if (integrityRaw !== undefined) {
        const check = await verifyPackage(this.fs, tmpDir, integrityRaw as never)
        if (!check.ok) throw new Error('完整性校验失败：' + check.issues.join('; '))
      } else {
        const computed = await hashPackage(this.fs, tmpDir)
        await this.fs.writeFile(join(tmpDir, INTEGRITY_FILENAME), JSON.stringify(computed, null, 2) + '\n')
      }
    } catch (error) {
      await this.fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined)
      return { ok: false, issues: [String((error as Error).message)] }
    }
    // 4. atomic rename 进目标根（同卷保证原子）
    const finalDir = join(this.rootOf(kind), manifest.id)
    try {
      await this.fs.rename(tmpDir, finalDir)
    } catch (error) {
      await this.fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined)
      return { ok: false, issues: ['安装落位失败：' + String((error as Error).message)] }
    }
    // 5. registry 刷新 + 持久化
    await this.registry.refresh()
    try {
      await this.registry.persist()
    } catch {
      // registry.json 回写失败不撤销安装：磁盘发现是权威，下次启动自愈
    }
    return { ok: true }
  }

  /**
   * 覆盖安装（同 id 替换）：旧包先挪到 staging 垃圾桶，新包 rename 进目标根；
   * 失败时把旧包 rename 回（回滚）。仅非内置来源允许。
   */
  async replace(sourceDir: string, options: InstallOptions = {}): Promise<RepositoryResult> {
    const kind = options.kind ?? 'installed'
    const issues: string[] = []
    let manifest
    try {
      const raw = JSON.parse(await this.fs.readText(join(sourceDir, MANIFEST_FILENAME)))
      const result = validateManifest(raw)
      if (!result.ok) return { ok: false, issues: result.issues.map(i => i.path + ' ' + i.message) }
      manifest = result.manifest
    } catch {
      return { ok: false, issues: ['源目录不是合法 Skin Package'] }
    }
    const existing = this.registry.get(manifest.id)
    if (existing === undefined) return this.install(sourceDir, options)
    if (existing.source === 'builtin') return { ok: false, issues: ['内置皮肤不可覆盖：' + manifest.id] }
    const oldDir = existing.path
    const trash = join(this.roots.staging, '.replace-old-' + randomBytes(6).toString('hex'))
    // 1) 旧包挪走（rename 原子）
    try {
      await this.fs.rename(oldDir, trash)
    } catch (error) {
      return { ok: false, issues: ['替换：旧包移出失败：' + String((error as Error).message)] }
    }
    // 2) 新包按 install 流程进目标根（对同 id：registry.has 会拦 → 先刷新 registry）
    await this.registry.refresh()
    const installed = await this.install(sourceDir, options)
    if (!installed.ok) {
      // 3) 失败回滚：旧包 rename 回
      try {
        await this.fs.rename(trash, oldDir)
      } catch (error) {
        issues.push('回滚失败：' + String((error as Error).message))
      }
      await this.registry.refresh()
      return { ok: false, issues: [...installed.issues, ...issues] }
    }
    // 4) 成功：清理垃圾桶
    await this.fs.rm(trash, { recursive: true, force: true }).catch(() => undefined)
    await this.registry.refresh()
    return { ok: true }
  }

  /** 卸载非内置皮肤；内置皮肤不可卸载。 */
  async remove(id: string): Promise<RepositoryResult> {
    const entry = this.registry.get(id)
    if (entry === undefined) return { ok: false, issues: ['皮肤不存在：' + id] }
    if (entry.source === 'builtin') return { ok: false, issues: ['内置皮肤不可卸载：' + id] }
    const trash = join(this.roots.staging, '.remove-' + randomBytes(6).toString('hex'))
    try {
      await this.fs.rename(entry.path, trash)
      await this.fs.rm(trash, { recursive: true, force: true })
    } catch (error) {
      return { ok: false, issues: ['卸载失败：' + String((error as Error).message)] }
    }
    await this.registry.refresh()
    try {
      await this.registry.persist()
    } catch {
      // 同上：磁盘权威
    }
    return { ok: true }
  }
}

export { nodeFs }
