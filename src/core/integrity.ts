/**
 * Skin Package 完整性：包内文件清单 + sha256。
 * integrity.json 可选存在；存在时必须匹配；首次安装缺失时由安装流程生成。
 * @module dsh-skin/src/core/integrity
 */

import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { FsLike } from '../repository/fs.ts'

export interface IntegrityFileRecord {
  /** 包内相对路径（'/' 分隔） */
  path: string
  size: number
  sha256: string
}

export interface IntegrityManifest {
  algorithm: 'sha256'
  files: IntegrityFileRecord[]
}

const INTEGRITY_FILE = 'integrity.json'

async function walk(fs: FsLike, dir: string, prefix: string, out: IntegrityFileRecord[]): Promise<void> {
  const entries = await fs.readdir(dir)
  entries.sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of entries) {
    if (entry.name === INTEGRITY_FILE) continue
    const rel = prefix.length === 0 ? entry.name : prefix + '/' + entry.name
    const full = join(dir, entry.name)
    if (entry.isSymbolicLink()) {
      throw new Error('拒绝 symlink：' + full)
    }
    if (entry.isDirectory()) {
      await walk(fs, full, rel, out)
    } else {
      const bytes = await fs.readFile(full)
      out.push({ path: rel, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
    }
  }
}

/** 计算包内全部文件（除 integrity.json 自身）的 sha256 清单。 */
export async function hashPackage(fs: FsLike, dir: string): Promise<IntegrityManifest> {
  const files: IntegrityFileRecord[] = []
  await walk(fs, dir, '', files)
  files.sort((a, b) => a.path.localeCompare(b.path))
  return { algorithm: 'sha256', files }
}

export type IntegrityCheckResult = { ok: true } | { ok: false; issues: string[] }

/** 校验目录内容与期望清单一致：路径集合、尺寸、哈希全部匹配。 */
export async function verifyPackage(fs: FsLike, dir: string, expected: IntegrityManifest): Promise<IntegrityCheckResult> {
  if (expected.algorithm !== 'sha256') return { ok: false, issues: ['不支持的完整性算法：' + String(expected.algorithm)] }
  const issues: string[] = []
  let actual: IntegrityManifest
  try {
    actual = await hashPackage(fs, dir)
  } catch (error) {
    return { ok: false, issues: ['无法计算包完整性：' + String((error as Error).message)] }
  }
  const actualByPath = new Map(actual.files.map(f => [f.path, f]))
  for (const expect of expected.files) {
    const found = actualByPath.get(expect.path)
    if (found === undefined) {
      issues.push('缺失文件：' + expect.path)
      continue
    }
    if (found.size !== expect.size) issues.push('尺寸不一致：' + expect.path)
    if (found.sha256 !== expect.sha256) issues.push('哈希不一致：' + expect.path)
    actualByPath.delete(expect.path)
  }
  for (const extra of actualByPath.keys()) issues.push('清单外多余文件：' + extra)
  return issues.length === 0 ? { ok: true } : { ok: false, issues }
}
