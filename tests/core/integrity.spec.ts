import { describe, expect, it } from 'vitest'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { hashPackage, verifyPackage } from '../../src/core/integrity'
import { nodeFs } from '../../src/repository/fs'
import { cleanup, tempDir } from '../helpers'

describe('integrity', () => {
  it('hashPackage 产出排序后的 sha256 清单且排除 integrity.json', async () => {
    const dir = tempDir('dsh-skin-int-')
    try {
      mkdirSync(join(dir, 'a'), { recursive: true })
      writeFileSync(join(dir, 'z.txt'), 'z')
      writeFileSync(join(dir, 'a', 'b.txt'), 'b')
      writeFileSync(join(dir, 'integrity.json'), '{}')
      const manifest = await hashPackage(nodeFs(), dir)
      expect(manifest.algorithm).toBe('sha256')
      expect(manifest.files.map(f => f.path)).toEqual(['a/b.txt', 'z.txt'])
      expect(manifest.files.every(f => /^[0-9a-f]{64}$/.test(f.sha256))).toBe(true)
    } finally {
      cleanup(dir)
    }
  })

  it('verifyPackage 匹配通过', async () => {
    const dir = tempDir('dsh-skin-int-')
    try {
      writeFileSync(join(dir, 'x.txt'), 'hello')
      const expected = await hashPackage(nodeFs(), dir)
      const check = await verifyPackage(nodeFs(), dir, expected)
      expect(check.ok).toBe(true)
    } finally {
      cleanup(dir)
    }
  })

  it('verifyPackage 检测篡改/缺失/多余文件', async () => {
    const dir = tempDir('dsh-skin-int-')
    try {
      writeFileSync(join(dir, 'x.txt'), 'hello')
      const expected = await hashPackage(nodeFs(), dir)
      writeFileSync(join(dir, 'x.txt'), 'tampered')
      const tampered = await verifyPackage(nodeFs(), dir, expected)
      expect(tampered.ok).toBe(false)
      writeFileSync(join(dir, 'x.txt'), 'hello')
      writeFileSync(join(dir, 'extra.txt'), 'extra')
      const extra = await verifyPackage(nodeFs(), dir, expected)
      expect(extra.ok).toBe(false)
      if (!extra.ok) expect(extra.issues.join(';')).toContain('清单外多余文件')
    } finally {
      cleanup(dir)
    }
  })
})
