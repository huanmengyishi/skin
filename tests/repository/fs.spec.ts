import { describe, expect, it } from 'vitest'
import { mkdirSync, writeFileSync, symlinkSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { copyDirRecursive, nodeFs, resolveInside } from '../../src/repository/fs'
import { cleanup, tempDir } from '../helpers'

describe('resolveInside', () => {
  it('放行根内相对路径', async () => {
    const dir = tempDir('dsh-skin-fs-')
    try {
      mkdirSync(join(dir, 'sub'), { recursive: true })
      writeFileSync(join(dir, 'sub', 'f.txt'), 'x')
      const resolved = await resolveInside(nodeFs(), dir, 'sub/f.txt')
      expect(resolved).toBe(join(dir, 'sub', 'f.txt'))
    } finally {
      cleanup(dir)
    }
  })

  it('拒绝 .. 穿越与绝对路径', async () => {
    const dir = tempDir('dsh-skin-fs-')
    try {
      expect(await resolveInside(nodeFs(), dir, '../evil.txt')).toBeUndefined()
      expect(await resolveInside(nodeFs(), dir, 'a/../../evil')).toBeUndefined()
      expect(await resolveInside(nodeFs(), dir, join(dir, 'evil.txt'))).toBeUndefined()
    } finally {
      cleanup(dir)
    }
  })
})

describe('copyDirRecursive', () => {
  it('复制目录内容', async () => {
    const dir = tempDir('dsh-skin-fs-')
    try {
      mkdirSync(join(dir, 'src', 'nested'), { recursive: true })
      writeFileSync(join(dir, 'src', 'a.txt'), 'a')
      writeFileSync(join(dir, 'src', 'nested', 'b.txt'), 'b')
      await copyDirRecursive(nodeFs(), join(dir, 'src'), join(dir, 'dst'))
      expect(existsSync(join(dir, 'dst', 'a.txt'))).toBe(true)
      expect(existsSync(join(dir, 'dst', 'nested', 'b.txt'))).toBe(true)
    } finally {
      cleanup(dir)
    }
  })

  it('拒绝 symlink 且不复制其内容', async () => {
    const dir = tempDir('dsh-skin-fs-')
    try {
      mkdirSync(join(dir, 'src'), { recursive: true })
      mkdirSync(join(dir, 'outside'), { recursive: true })
      writeFileSync(join(dir, 'outside', 'secret.txt'), 'secret')
      let symlinkOk = true
      try {
        symlinkSync(join(dir, 'outside'), join(dir, 'src', 'linked'), 'junction')
      } catch {
        symlinkOk = false
      }
      if (!symlinkOk) return // Windows 无 junction 权限的环境跳过（CI 有）
      await expect(copyDirRecursive(nodeFs(), join(dir, 'src'), join(dir, 'dst'))).rejects.toThrow(/symlink/)
      expect(existsSync(join(dir, 'dst', 'linked', 'secret.txt'))).toBe(false)
    } finally {
      cleanup(dir)
    }
  })
})
