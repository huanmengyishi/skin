/**
 * 皮肤包发现：扫描 builtin 根与 installed 根，读取并校验 manifest，
 * 产出带状态的发现结果。损坏/非法包进入 state 而非抛错崩盘。
 * @module dsh-skin/src/repository/discover
 */

import { basename, join } from 'node:path'
import { hashPackage, verifyPackage, type IntegrityManifest } from '../core/integrity.ts'
import { validateManifest, type SkinManifest } from '../core/manifest.ts'
import type { FsLike } from './fs.ts'
import { INTEGRITY_FILENAME, MANIFEST_FILENAME } from './store.ts'

export type SkinPackageState = 'ok' | 'invalid' | 'corrupt'
export type SkinPackageSource = 'builtin' | 'installed' | 'generated' | 'downloaded'

export interface DiscoveredSkin {
  id: string
  /** 包所在来源根 */
  source: SkinPackageSource
  /** 包目录绝对路径 */
  path: string
  manifest: SkinManifest | null
  state: SkinPackageState
  issues: string[]
  integrityVerified: boolean
}

async function readJsonText(fs: FsLike, path: string): Promise<unknown> {
  const text = await fs.readText(path)
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

async function inspectPackage(fs: FsLike, dir: string, source: SkinPackageSource): Promise<DiscoveredSkin> {
  const id = basename(dir)
  const issues: string[] = []
  let manifest: SkinManifest | null = null
  let state: SkinPackageState = 'ok'
  let integrityVerified = false

  let manifestRaw: unknown
  try {
    manifestRaw = await readJsonText(fs, join(dir, MANIFEST_FILENAME))
  } catch {
    return { id, source, path: dir, manifest: null, state: 'corrupt', issues: ['无法读取 manifest.json'], integrityVerified: false }
  }
  if (manifestRaw === undefined) {
    return { id, source, path: dir, manifest: null, state: 'corrupt', issues: ['manifest.json 不是合法 JSON'], integrityVerified: false }
  }
  const result = validateManifest(manifestRaw)
  if (!result.ok) {
    issues.push(...result.issues.map(i => i.path + ' ' + i.message))
    return { id, source, path: dir, manifest: null, state: 'invalid', issues, integrityVerified: false }
  }
  manifest = result.manifest
  if (manifest.id !== id) {
    issues.push('目录名与 manifest.id 不一致：' + id + ' != ' + manifest.id)
    state = 'invalid'
  }
  // 完整性：integrity.json 存在则必须匹配
  let integrityRaw: unknown
  try {
    integrityRaw = await readJsonText(fs, join(dir, INTEGRITY_FILENAME))
  } catch {
    integrityRaw = undefined
  }
  if (integrityRaw !== undefined) {
    const expected = integrityRaw as IntegrityManifest
    try {
      const check = await verifyPackage(fs, dir, expected)
      integrityVerified = check.ok
      if (!check.ok) {
        state = 'corrupt'
        issues.push(...check.issues)
      }
    } catch (error) {
      state = 'corrupt'
      issues.push('完整性校验失败：' + String((error as Error).message))
    }
  } else {
    try {
      await hashPackage(fs, dir)
    } catch (error) {
      state = 'corrupt'
      issues.push('包文件不可读：' + String((error as Error).message))
    }
  }

  return { id: manifest.id, source, path: dir, manifest, state, issues, integrityVerified }
}

/** 扫描一个根目录下所有直接子目录（跳过隐藏与 staging/cache 目录名）。 */
export async function discoverInRoot(fs: FsLike, root: string | undefined, source: SkinPackageSource): Promise<DiscoveredSkin[]> {
  if (root === undefined) return []
  let entries
  try {
    entries = await fs.readdir(root)
  } catch {
    return []
  }
  const result: DiscoveredSkin[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    if (entry.isSymbolicLink()) continue
    const dir = join(root, entry.name)
    result.push(await inspectPackage(fs, dir, source))
  }
  return result
}

/**
 * 合并四来源根：同 id 时优先级 installed > generated > downloaded > builtin（后写入者胜）。
 */
export async function discoverPackages(
  fs: FsLike,
  builtinRoot: string | undefined,
  installedRoot: string,
  generatedRoot: string,
  downloadedRoot: string,
): Promise<DiscoveredSkin[]> {
  const layers: Array<[string | undefined, SkinPackageSource, string]> = [
    [builtinRoot, 'builtin', '内置皮肤'],
    [downloadedRoot, 'downloaded', '下载皮肤'],
    [generatedRoot, 'generated', '生成皮肤'],
    [installedRoot, 'installed', '本地皮肤'],
  ]
  const byId = new Map<string, DiscoveredSkin>()
  for (const [root, source, label] of layers) {
    const discovered = await discoverInRoot(fs, root, source)
    for (const skin of discovered) {
      const existing = byId.get(skin.id)
      if (existing !== undefined && existing.source !== source) {
        skin.issues.push(label + ' ' + skin.id + ' 遮蔽 ' + existing.source + ' 版本')
      }
      byId.set(skin.id, skin)
    }
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id))
}
