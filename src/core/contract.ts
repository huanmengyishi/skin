/**
 * Phase 1 契约冻结（宿主面）：SkinManifest / SkinPackage / SkinSource / SkinTrust /
 * SkinCompatibility / SkinResolutionPolicy / SkinRepository。
 * 本文件只把 v1.0.0 既有事实写成正式形状，不引入新行为；
 * 冻结后任何改动须走架构否决门 + minor 版本升级流程（见 docs/BASELINE.md）。
 * @module dsh-skin/src/core/contract
 */

import { SKIN_API_VERSION } from './manifest.ts'
import type { SkinManifest, SkinManifestPreview } from './manifest.ts'
import type { SkinSource } from '../repository/registry.ts'
import type { SkinPackageSource } from '../repository/discover.ts'
import type { SkinRegistryEntry } from '../repository/registry.ts'
import type { SkinFileRef } from '../repository/repository.ts'

export type { SkinManifest, SkinManifestPreview }
export type { SkinSource, SkinPackageSource }
export { SKIN_API_VERSION }

/** 信任标注：与 Source 正交的独立维度（不随 source 名称之外的任何条件变化）。 */
export type SkinTrust = 'trusted' | 'untrusted'

/** 信任推导（静态边界）：downloaded = untrusted，其余 = trusted。 */
export function trustOf(source: SkinSource): SkinTrust {
  return source === 'downloaded' ? 'untrusted' : 'trusted'
}

/** 兼容性状态：supported=compatible；>supported=incompatible；<supported=invalid。 */
export type SkinCompatibilityStatus = 'compatible' | 'incompatible' | 'invalid'

export interface SkinCompatibility {
  skinApiVersion: number
  status: SkinCompatibilityStatus
  supportedVersions: readonly number[]
}

/** 兼容性判定：当前唯一受支持版本 = SKIN_API_VERSION（v1.0.0 校验事实：≠1 一律拒绝）。 */
export function compatibilityOf(skinApiVersion: number): SkinCompatibility {
  const supportedVersions: readonly number[] = [SKIN_API_VERSION]
  return {
    skinApiVersion,
    supportedVersions,
    status: skinApiVersion === SKIN_API_VERSION ? 'compatible' : skinApiVersion > SKIN_API_VERSION ? 'incompatible' : 'invalid',
  }
}

/** 包内文件引用（SkinInfo.files 的契约形状）：资源由 Repository 层供给，不是 Runtime 操作。 */
export interface SkinPackageFiles {
  bundle: string
  styles: string
  themeLight: string
  themeDark: string
  previewLight?: string
  previewDark?: string
}

/** Skin Package 契约：清单 + 文件引用 + 完整性状态（theme/styles/client 缺失时容忍为空，v1.0.0 事实）。 */
export interface SkinPackage {
  manifest: SkinManifest
  files: SkinPackageFiles
  integrityVerified: boolean
}

/** 解析策略（discover 的既有事实）：后写者胜，遮蔽记录 issue。 */
export interface SkinResolutionPolicy {
  /** 同 id 冲突时的优先级：installed > generated > downloaded > builtin */
  precedence: readonly SkinSource[]
  sameIdRule: 'later-wins-with-shadow-record'
  installConflictRule: 'reject-existing-id' | 'replace-with-rollback'
  builtinRule: 'immutable'
}

export const SKIN_RESOLUTION_POLICY: SkinResolutionPolicy = {
  precedence: ['installed', 'generated', 'downloaded', 'builtin'],
  sameIdRule: 'later-wins-with-shadow-record',
  installConflictRule: 'reject-existing-id',
  builtinRule: 'immutable',
}

/** SkinRepository 契约面（install/replace 语义见 IMPLEMENTATION_PLAN：replace-with-rollback）。 */
export interface SkinRepositoryFace {
  hydrate(): Promise<void>
  list(): SkinRegistryEntry[]
  get(id: string): SkinRegistryEntry | undefined
  readFile(id: string, rel: string): Promise<Uint8Array | undefined>
  fileRef(id: string, rel: string): Promise<SkinFileRef | undefined>
  install(sourceDir: string, options?: { kind?: 'installed' | 'generated' | 'downloaded' }): Promise<{ ok: true } | { ok: false; issues: string[] }>
  replace(sourceDir: string, options?: { kind?: 'installed' | 'generated' | 'downloaded' }): Promise<{ ok: true } | { ok: false; issues: string[] }>
  remove(id: string): Promise<{ ok: true } | { ok: false; issues: string[] }>
  readonly registry: {
    current(): { entries: SkinRegistryEntry[] }
    get(id: string): SkinRegistryEntry | undefined
    list(): SkinRegistryEntry[]
  }
}

