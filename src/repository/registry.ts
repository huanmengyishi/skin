/**
 * SkinRegistry：当前有哪些 Skin、metadata、version、source、state。
 * 它是内存权威的注册表；持久化由注入的 RegistryStorage 承担
 * （storage-domain 只是 Storage 的一种可替换实现，不是 Registry 本身）。
 * @module dsh-skin/src/repository/registry
 */

import { dirname, join, relative } from 'node:path'
import { trustOf } from '../core/contract.ts'
import type { SkinManifest } from '../core/manifest.ts'
import { discoverPackages, type SkinPackageState } from './discover.ts'
import type { FsLike } from './fs.ts'
import { REGISTRY_FILENAME, type SkinRoots } from './store.ts'

export type SkinSource = 'builtin' | 'installed' | 'generated' | 'downloaded'

export interface SkinRegistryEntry {
  id: string
  source: SkinSource
  /** 包目录绝对路径（仅内存，不落盘） */
  path: string
  /** 相对 $DSH_HOME 的包路径（持久化用） */
  relPath: string
  version: string
  name: string
  author: string
  description: string
  tags: string[]
  skinApiVersion: number
  preview: { light?: string; dark?: string }
  state: SkinPackageState
  issues: string[]
  integrityVerified: boolean
  /** 是否遮蔽了同 id 内置皮肤 */
  shadowsBuiltin: boolean
  /** 包目录 mtime（展示用更新时间；每次 refresh 重算） */
  updatedAtMs: number
  /** 信任标注：本地安装/内置/生成 = trusted；下载 = untrusted（静态边界，见 docs/skin-security.md） */
  trust: 'trusted' | 'untrusted'
}

export interface SkinRegistrySnapshot {
  entries: SkinRegistryEntry[]
}

/** Registry 的持久化实现（Storage 概念，与 Registry 分离）。 */
export interface RegistryStorage {
  load(): Promise<SkinRegistryEntry[] | undefined>
  save(entries: SkinRegistryEntry[]): Promise<void>
}

/** registry.json 文件存储：写入经注入的原子写函数（缺省回退为普通写）。 */
export function jsonRegistryStorage(fs: FsLike, path: string, atomicWrite?: (path: string, text: string) => Promise<void>): RegistryStorage {
  return {
    async load() {
      try {
        const text = await fs.readText(path)
        const parsed = JSON.parse(text) as { schemaVersion: number; entries: SkinRegistryEntry[] }
        if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.entries)) return undefined
        return parsed.entries
      } catch {
        return undefined
      }
    },
    async save(entries) {
      const persistable = entries.map(({ path: _path, ...rest }) => rest)
      const text = JSON.stringify({ schemaVersion: 1, entries: persistable }, null, 2)
      if (atomicWrite !== undefined) await atomicWrite(path, text)
      else await fs.writeFile(path, text)
    },
  }
}

export class SkinRegistry {
  private snapshot: SkinRegistrySnapshot = { entries: [] }

  constructor(
    private readonly fs: FsLike,
    private readonly roots: SkinRoots,
    private readonly builtinRoot: string | undefined,
    private readonly storage: RegistryStorage,
  ) {}

  /** 当前快照（refresh 后更新）。 */
  current(): SkinRegistrySnapshot {
    return this.snapshot
  }

  /** 从磁盘重新发现并更新内存快照；损坏包不抛错。 */
  async refresh(): Promise<SkinRegistrySnapshot> {
    const discovered = await discoverPackages(this.fs, this.builtinRoot, this.roots.installed, this.roots.generated, this.roots.downloaded)
    const entries: SkinRegistryEntry[] = []
    for (const skin of discovered) {
      let updatedAtMs = 0
      try { updatedAtMs = (await this.fs.stat(skin.path)).mtimeMs } catch { updatedAtMs = 0 }
      entries.push({
        id: skin.id,
        source: skin.source,
        path: skin.path,
        relPath: skin.source === 'builtin' ? skin.path : this.toRel(skin.path),
        version: skin.manifest?.version ?? '0.0.0',
        name: skin.manifest?.name ?? skin.id,
        author: skin.manifest?.author ?? '',
        description: skin.manifest?.description ?? '',
        tags: skin.manifest?.tags ?? [],
        skinApiVersion: skin.manifest?.skinApiVersion ?? 0,
        preview: skin.manifest?.preview ?? {},
        state: skin.state,
        issues: skin.issues,
        integrityVerified: skin.integrityVerified,
        shadowsBuiltin: skin.source !== 'builtin' && skin.issues.some(i => i.includes('遮蔽')),
        updatedAtMs,
        trust: trustOf(skin.source),
      })
    }
    this.snapshot = { entries }
    return this.snapshot
  }

  /** 把最新快照写入 Storage（失败不破坏内存态）。 */
  async persist(): Promise<void> {
    await this.storage.save(this.snapshot.entries)
  }

  /** 启动顺序：load 缓存 → refresh 磁盘（磁盘是权威）→ persist 回写。 */
  async hydrate(): Promise<SkinRegistrySnapshot> {
    await this.storage.load()
    const snapshot = await this.refresh()
    try {
      await this.persist()
    } catch {
      // 回写失败不阻断：磁盘发现结果已生效，下次刷新自愈
    }
    return snapshot
  }

  get(id: string): SkinRegistryEntry | undefined {
    return this.snapshot.entries.find(entry => entry.id === id)
  }

  list(): SkinRegistryEntry[] {
    return [...this.snapshot.entries]
  }

  /** registry 内已存在（含遮蔽关系） */
  has(id: string): boolean {
    return this.get(id) !== undefined
  }

  /** 包绝对路径 → 相对 $DSH_HOME 的路径（'/' 分隔，持久化用）。 */
  private toRel(path: string): string {
    return relative(dirname(this.roots.root), path).replace(/\\/g, '/')
  }
}
