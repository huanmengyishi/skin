/**
 * 仓库层最小文件系统抽象：把 SkinRepository 与具体 FS 后端解耦。
 * 宿主注入 node:fs/promises 实现；测试注入内存/故障注入实现。
 * 安全规则集中在复制与路径守卫：拒绝 symlink、拒绝包根外路径。
 * @module dsh-skin/src/repository/fs
 */

import { copyFile, lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

export interface FsDirent {
  name: string
  isDirectory(): boolean
  isSymbolicLink(): boolean
}

export interface FsStat {
  size: number
  mtimeMs: number
  isDirectory(): boolean
  isSymbolicLink(): boolean
}

/** SkinRepository 使用的最小 FS 面。 */
export interface FsLike {
  readFile(path: string): Promise<Uint8Array>
  readText(path: string): Promise<string>
  writeFile(path: string, data: Uint8Array | string): Promise<void>
  mkdir(path: string, opts?: { recursive?: boolean }): Promise<void>
  rename(from: string, to: string): Promise<void>
  rm(path: string, opts?: { recursive?: boolean; force?: boolean }): Promise<void>
  readdir(path: string): Promise<FsDirent[]>
  lstat(path: string): Promise<FsStat>
  stat(path: string): Promise<FsStat>
  copyFile(from: string, to: string): Promise<void>
}

/** 基于 node:fs/promises 的真实实现（宿主专用）。 */
export function nodeFs(): FsLike {
  const toDirent = (d: { name: string; isDirectory(): boolean; isSymbolicLink(): boolean }): FsDirent => ({
    name: d.name,
    isDirectory: () => d.isDirectory(),
    isSymbolicLink: () => d.isSymbolicLink(),
  })
  return {
    readFile: path => readFile(path),
    readText: async path => (await readFile(path)).toString('utf8'),
    writeFile: async (path, data) => { await writeFile(path, data) },
    mkdir: async (path, opts) => { await mkdir(path, opts) },
    rename: (from, to) => rename(from, to),
    rm: (path, opts) => rm(path, opts ?? { recursive: true, force: true }),
    readdir: async path => (await readdir(path, { withFileTypes: true })).map(toDirent),
    lstat: async path => { const s = await lstat(path); return { size: s.size, mtimeMs: s.mtimeMs, isDirectory: () => s.isDirectory(), isSymbolicLink: () => s.isSymbolicLink() } },
    stat: async path => { const s = await stat(path); return { size: s.size, mtimeMs: s.mtimeMs, isDirectory: () => s.isDirectory(), isSymbolicLink: () => s.isSymbolicLink() } },
    copyFile: (from, to) => copyFile(from, to),
  }
}

/**
 * 把 dir 下的相对路径安全解析为绝对路径：
 * 拒绝绝对/盘符/.. 穿越，并逐段 lstat 拒绝 symlink 组件。
 * @returns 解析结果；目标不存在由调用方决定语义。
 */
export async function resolveInside(fs: FsLike, root: string, rel: string): Promise<string | undefined> {
  if (typeof rel !== 'string' || rel.length === 0) return undefined
  if (isAbsolute(rel) || rel.includes('..') || rel.includes('\\') || rel.includes('\0')) return undefined
  const target = resolve(root, rel)
  const relCheck = relative(root, target)
  if (relCheck.startsWith('..') || isAbsolute(relCheck)) return undefined
  const segments = rel.split('/').filter(s => s.length > 0)
  let current = root
  for (let i = 0; i < segments.length - 1; i++) {
    current = join(current, segments[i])
    try {
      const s = await fs.lstat(current)
      if (s.isSymbolicLink()) return undefined
      if (!s.isDirectory()) return undefined
    } catch {
      return undefined
    }
  }
  return target
}

/** 递归复制目录：拒绝 symlink（文件与目录组件均拒），目标不存在则创建。 */
export async function copyDirRecursive(fs: FsLike, from: string, to: string): Promise<void> {
  await fs.mkdir(to, { recursive: true })
  const entries = await fs.readdir(from)
  for (const entry of entries) {
    const source = join(from, entry.name)
    const target = join(to, entry.name)
    if (entry.isSymbolicLink()) {
      throw new Error('拒绝 symlink：' + source)
    }
    if (entry.isDirectory()) {
      await copyDirRecursive(fs, source, target)
    } else {
      await fs.copyFile(source, target)
    }
  }
}

/** 计算相对路径（用于错误信息与 registry 持久化），不在根内返回 undefined。 */
export function relativePath(root: string, target: string): string | undefined {
  const rel = relative(root, target)
  if (rel.startsWith('..') || isAbsolute(rel)) return undefined
  return rel.split(sep).join('/')
}
