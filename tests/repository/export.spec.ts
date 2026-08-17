import { describe, expect, it } from 'vitest'
import { mkdirSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unzipSync } from 'fflate'
import { nodeFs } from '../../src/repository/fs'
import { buildPackageZip } from '../../src/repository/export'
import { writeSkinFixture } from '../helpers'

describe('Skin Package 导出', () => {
  it('zip 往返：文件清单与内容一致（统一交换格式）', async () => {
    const dir = join(tmpdir(), 'dsh-skin-export-' + Date.now())
    const pkg = writeSkinFixture(dir, 'export-me')
    const zip = await buildPackageZip(nodeFs(), pkg)
    expect(zip[0]).toBe(0x50) // PK
    const unpacked = unzipSync(zip)
    const names = Object.keys(unpacked).sort()
    expect(names).toContain('manifest.json')
    expect(names).toContain('client/index.js')
    const manifest = JSON.parse(new TextDecoder().decode(unpacked['manifest.json']))
    expect(manifest.id).toBe('export-me')
    expect(new TextDecoder().decode(unpacked['client/index.js'])).toContain('dsh-skin/export-me')
  })

  it('拒绝 symlink（导出不做静默穿透）', async () => {
    const dir = join(tmpdir(), 'dsh-skin-export-' + Date.now() + '-s')
    const pkg = writeSkinFixture(dir, 'export-me')
    const outside = join(dir, 'outside')
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(outside, 'secret.txt'), 's')
    let canSymlink = true
    try { symlinkSync(outside, join(pkg, 'evil'), 'junction') } catch { canSymlink = false }
    if (!canSymlink) return
    await expect(buildPackageZip(nodeFs(), pkg)).rejects.toThrow(/symlink/)
  })
})
