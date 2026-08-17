/**
 * 安装期安全门（Phase 7）：包内容静态扫描。
 * 皮肤是 untrusted 代码：安装前拒绝可执行文件与远程资源引用。
 * 这是静态防线，不是执行沙箱——浏览器内执行边界由 SkinContext 承担（见 docs/skin-security.md）。
 * @module dsh-skin/src/repository/security
 */

import { join } from 'node:path'
import type { FsLike } from './fs.ts'

/** 可执行文件扩展名黑名单（大小写不敏感，Windows 兼容）。 */
export const EXECUTABLE_EXTENSIONS = new Set([
  '.exe', '.dll', '.bat', '.cmd', '.ps1', '.vbs', '.scr', '.msi', '.com', '.reg', '.lnk', '.sys', '.pif', '.cpl',
])

/** 判断扩展名是否可执行（大小写不敏感）。 */
export function isExecutablePath(path: string): boolean {
  const dot = path.lastIndexOf('.')
  if (dot < 0) return false
  return EXECUTABLE_EXTENSIONS.has(path.slice(dot).toLowerCase())
}

/** 扫描目录：可执行文件 → 拒绝。 */
export async function scanExecutables(fs: FsLike, dir: string, prefix = ''): Promise<string[]> {
  const issues: string[] = []
  for (const entry of await fs.readdir(dir)) {
    const rel = prefix.length === 0 ? entry.name : prefix + '/' + entry.name
    const full = join(dir, entry.name)
    if (entry.isSymbolicLink()) { issues.push('symlink：' + rel); continue }
    if (entry.isDirectory()) { issues.push(...await scanExecutables(fs, full, rel)); continue }
    if (isExecutablePath(rel)) issues.push('可执行文件被拒绝：' + rel)
  }
  return issues
}

/** 扫描文本文件（css/js/html）中的远程 URL：皮肤不得悄悄加载远程资源（跟踪/注入风险）。 */
export async function scanRemoteUrls(fs: FsLike, dir: string): Promise<string[]> {
  const issues: string[] = []
  const walk = async (current: string, prefix: string): Promise<void> => {
    for (const entry of await fs.readdir(current)) {
      const rel = prefix.length === 0 ? entry.name : prefix + '/' + entry.name
      const full = join(current, entry.name)
      if (entry.isSymbolicLink()) { issues.push('symlink：' + rel); continue }
      if (entry.isDirectory()) { await walk(full, rel); continue }
      const lower = rel.toLowerCase()
      if (!(lower.endsWith('.css') || lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.html'))) continue
      try {
        const text = await fs.readText(full)
        const match = /https?:\/\//.exec(text)
        if (match !== null) issues.push('远程 URL 引用被拒绝：' + rel)
      } catch {
        issues.push('文本文件不可读：' + rel)
      }
    }
  }
  await walk(dir, '')
  return issues
}

/** 完整安装期安全扫描（可执行 + 远程资源）。 */
export async function scanPackageSecurity(fs: FsLike, dir: string): Promise<string[]> {
  const issues: string[] = []
  issues.push(...await scanExecutables(fs, dir))
  issues.push(...await scanRemoteUrls(fs, dir))
  return issues
}
