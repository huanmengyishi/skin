/**
 * 发布管线（网络层唯一的上行入口）：
 * 本地包 → validate（manifest/registry state）→ build verification（integrity 复核 + runtime 形态）→
 * integrity（zip + sha256）→ upload。上传失败绝不改动本地皮肤（只读本地、只发远端）。
 * @module dsh-skin/src/workshop/publish
 */

import { createHash } from 'node:crypto'
import { hashPackage, verifyPackage } from '../core/integrity.ts'
import { validateManifest } from '../core/manifest.ts'
import { buildPackageZip } from '../repository/export.ts'
import { nodeFs, type FsLike } from '../repository/fs.ts'
import type { SkinRepository } from '../repository/repository.ts'
import { INTEGRITY_FILENAME } from '../repository/store.ts'
import type { WorkshopClient } from './client.ts'

export type PublishResult = { ok: true; skinId: string; version: string; checksum: string } | { ok: false; issues: string[] }

/** 发布前四门：manifest 合法、registry 状态 ok、integrity 复核、runtime 形态。 */
async function verifyPackageForPublish(fs: FsLike, repository: SkinRepository, skinId: string): Promise<string[]> {
  const issues: string[] = []
  const entry = repository.get(skinId)
  if (entry === undefined) return ['皮肤不存在：' + skinId]
  if (entry.source === 'builtin') return ['内置皮肤不可发布']
  if (entry.source === 'downloaded') return ['下载来源的皮肤不可再发布（避免转售他人作品）']
  if (entry.state !== 'ok') return ['皮肤包状态非 ok（' + entry.state + '），拒绝发布：' + entry.issues.join('；')]
  try {
    const manifestRaw = JSON.parse(await fs.readText(entry.path + '/manifest.json'))
    const check = validateManifest(manifestRaw)
    if (!check.ok) issues.push('manifest 校验失败')
  } catch {
    issues.push('manifest 不可读')
  }
  try {
    const integrityRaw = JSON.parse(await fs.readText(entry.path + '/' + INTEGRITY_FILENAME))
    const integrityCheck = await verifyPackage(fs, entry.path, integrityRaw)
    if (!integrityCheck.ok) issues.push('完整性复核失败：' + integrityCheck.issues.join('；'))
  } catch {
    issues.push('integrity 缺失或不可读')
  }
  try {
    const clientJs = await fs.readText(entry.path + '/client/index.js')
    if (!clientJs.includes('window.__ModuleLoader__.load')) issues.push('runtime 形态校验失败（client bundle 非工厂形态）')
  } catch {
    issues.push('client bundle 缺失')
  }
  return issues
}

/** 发布新皮肤（publishNew）或发布新版本（publishVersion）。 */
export async function publishSkin(
  fs: FsLike,
  repository: SkinRepository,
  client: WorkshopClient,
  skinId: string,
  mode: 'new' | 'version',
): Promise<PublishResult> {
  const entry = repository.get(skinId)
  if (entry === undefined) return { ok: false, issues: ['皮肤不存在：' + skinId] }
  const issues = await verifyPackageForPublish(fs, repository, skinId)
  if (issues.length > 0) return { ok: false, issues }
  try {
    const zip = await buildPackageZip(fs, entry.path)
    if (zip.length > 8 * 1024 * 1024) return { ok: false, issues: ['包超过 8MB，拒绝上传'] }
    const sha256 = createHash('sha256').update(zip).digest('hex')
    const packageBase64 = Buffer.from(zip).toString('base64')
    const remote = mode === 'new'
      ? await client.publishNew({
        packageBase64,
        packageSha256: sha256,
        name: entry.name,
        description: entry.description,
        tags: entry.tags,
      })
      : await client.publishVersion(skinId, { packageBase64, packageSha256: sha256 })
    return { ok: true, skinId: remote.skinId, version: remote.version, checksum: remote.checksum }
  } catch (error) {
    return { ok: false, issues: ['发布失败（本地皮肤未改动）：' + String((error as Error).message)] }
  }
}

export { hashPackage, nodeFs }
