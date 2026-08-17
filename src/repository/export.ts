/**
 * Skin Package 导出：包目录 → zip（统一交换格式；zip 安装随 Workshop/Phase 7 接入）。
 * @module dsh-skin/src/repository/export
 */

import { join } from 'node:path'
import { zipSync } from 'fflate'
import type { FsLike } from './fs.ts'

/** 收集包内全部文件（相对路径 → 字节）。 */
export async function collectPackageFiles(fs: FsLike, dir: string): Promise<Record<string, Uint8Array>> {
  const entries: Record<string, Uint8Array> = {}
  const walk = async (current: string, prefix: string): Promise<void> => {
    for (const item of await fs.readdir(current)) {
      const rel = prefix.length === 0 ? item.name : prefix + '/' + item.name
      const full = join(current, item.name)
      if (item.isSymbolicLink()) throw new Error('拒绝 symlink：' + full)
      if (item.isDirectory()) await walk(full, rel)
      else entries[rel] = await fs.readFile(full)
    }
  }
  await walk(dir, '')
  return entries
}

/** 包目录 → zip 字节。 */
export async function buildPackageZip(fs: FsLike, dir: string): Promise<Uint8Array> {
  const entries = await collectPackageFiles(fs, dir)
  return zipSync(entries, { level: 6 })
}
