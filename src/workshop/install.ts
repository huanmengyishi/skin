/**
 * Workshop 下载 → 安装管线（网络层唯一的落盘入口）：
 * 下载 zip → sha256 校验 → zip-slip 安全解包到 staging → 写 provenance（metadata/remote.json）
 * → integrity 重算 → repository.install(kind:'downloaded')（staging→atomic，失败零残留）。
 * 禁止任何直接写 installed/ 的路径。
 * @module dsh-skin/src/workshop/install
 */

import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { unzipSync } from 'fflate'
import { hashPackage } from '../core/integrity.ts'
import { nodeFs, type FsLike } from '../repository/fs.ts'
import type { SkinRepository } from '../repository/repository.ts'
import { MANIFEST_FILENAME, INTEGRITY_FILENAME } from '../repository/store.ts'
import { randomBytes } from 'node:crypto'

export interface DownloadInstallResult {
  ok: boolean
  skinId?: string
  issues: string[]
}

/** zip 条目名安全校验：拒绝绝对路径/盘符/.. /反斜杠/空名。 */
export function isSafeZipEntry(name: string): boolean {
  if (name.length === 0 || name.length > 512) return false
  if (name.startsWith('/') || name.startsWith('\\\\')) return false
  if (/^[a-zA-Z]:/.test(name)) return false
  if (name.includes('..') || name.includes('\\')) return false
  return true
}

/** zip 字节解包到目录（zip-slip 防护）。 */
export async function extractZipSafe(bytes: Uint8Array, destDir: string, fs: FsLike): Promise<string[]> {
  const entries = unzipSync(bytes)
  const written: string[] = []
  for (const [name, data] of Object.entries(entries)) {
    if (!isSafeZipEntry(name)) throw new Error('zip 条目非法（zip-slip 拒绝）：' + name)
    const target = join(destDir, name)
    await fs.mkdir(dirname(target), { recursive: true })
    await fs.writeFile(target, data)
    written.push(name)
  }
  return written
}

export interface WorkshopProvenance {
  remoteId: string
  remoteVersion: string
  downloadedAt: string
  checksum: string
}

/** 读包内 provenance（本地记录远端身份，供 update 使用）。 */
export async function readProvenance(fs: FsLike, packageDir: string): Promise<WorkshopProvenance | undefined> {
  try {
    return JSON.parse(await fs.readText(join(packageDir, 'metadata', 'remote.json'))) as WorkshopProvenance
  } catch {
    return undefined
  }
}

/** 下载并安装（或覆盖更新）一个远端皮肤。 */
export async function downloadAndInstall(
  fs: FsLike,
  repository: SkinRepository,
  stagingRoot: string,
  download: () => Promise<{ bytes: Uint8Array; expectedChecksum: string }>,
  remote: { skinId: string; version: string },
  options: { replaceExisting?: boolean } = {},
): Promise<DownloadInstallResult> {
  const issues: string[] = []
  const tmpDir = join(stagingRoot, '.workshop-' + randomBytes(6).toString('hex'))
  try {
    const { bytes, expectedChecksum } = await download()
    // 1) checksum（协议硬要求，缺失/不符即拒绝）
    const actual = createHash('sha256').update(bytes).digest('hex')
    if (expectedChecksum.length === 0) return { ok: false, issues: ['远端版本缺少 checksum，拒绝安装（防篡改要求）'] }
    if (actual !== expectedChecksum) return { ok: false, issues: ['checksum 不匹配（下载损坏或被篡改），拒绝安装'] }
    // 2) 解包（zip-slip 防护）
    await fs.mkdir(tmpDir, { recursive: true })
    const written = await extractZipSafe(bytes, tmpDir, fs)
    if (!written.includes(MANIFEST_FILENAME)) return { ok: false, issues: ['包内缺少 manifest.json'] }
    // 3) provenance + integrity 重算（remote.json 是新增文件）
    await fs.mkdir(join(tmpDir, 'metadata'), { recursive: true })
    await fs.writeFile(join(tmpDir, 'metadata', 'remote.json'), JSON.stringify({
      remoteId: remote.skinId, remoteVersion: remote.version, downloadedAt: new Date().toISOString(), checksum: expectedChecksum,
    } satisfies WorkshopProvenance, null, 2))
    const integrity = await hashPackage(fs, tmpDir)
    await fs.writeFile(join(tmpDir, INTEGRITY_FILENAME), JSON.stringify(integrity, null, 2))
    // 4) 仓库安装（staging→atomic；覆盖更新走 replace 回滚语义）
    const result = options.replaceExisting === true
      ? await repository.replace(tmpDir, { kind: 'downloaded' })
      : await repository.install(tmpDir, { kind: 'downloaded' })
    if (!result.ok) return { ok: false, issues: result.issues }
    return { ok: true, skinId: remote.skinId, issues: [] }
  } catch (error) {
    return { ok: false, issues: ['下载安装失败：' + String((error as Error).message)] }
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

export { nodeFs }
