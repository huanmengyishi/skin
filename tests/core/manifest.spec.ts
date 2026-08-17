import { describe, expect, it } from 'vitest'
import { isValidRelativePath, isValidSkinId, SKIN_API_VERSION, validateManifest } from '../../src/core/manifest.ts'

const valid = {
  id: 'terminal', version: '1.2.3', name: 'Phosphor Terminal', author: 'dsh-skin',
  description: 'crt', tags: ['retro', 'crt'], skinApiVersion: SKIN_API_VERSION, preview: { light: 'preview/light.svg' },
}

describe('validateManifest', () => {
  it('接受最小合法 manifest', () => {
    const result = validateManifest(valid)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.manifest.id).toBe('terminal')
  })

  it('拒绝非对象', () => {
    expect(validateManifest(null).ok).toBe(false)
    expect(validateManifest([]).ok).toBe(false)
    expect(validateManifest('x').ok).toBe(false)
  })

  it('拒绝缺失字段并给出多条问题', () => {
    const result = validateManifest({})
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.issues.length).toBeGreaterThanOrEqual(6)
  })

  it('拒绝非法 id（大写/空格/保留字）', () => {
    for (const id of ['MySkin', 'my skin', 'default', 'dsh-skin', 'a'.repeat(65)]) {
      const result = validateManifest({ ...valid, id })
      expect(result.ok, id).toBe(false)
    }
  })

  it('拒绝非法 version 与 skinApiVersion', () => {
    expect(validateManifest({ ...valid, version: '1.2' }).ok).toBe(false)
    expect(validateManifest({ ...valid, version: 'not-semver' }).ok).toBe(false)
    expect(validateManifest({ ...valid, skinApiVersion: 2 }).ok).toBe(false)
    expect(validateManifest({ ...valid, skinApiVersion: '1' }).ok).toBe(false)
  })

  it('拒绝非法 tags', () => {
    expect(validateManifest({ ...valid, tags: 'retro' }).ok).toBe(false)
    expect(validateManifest({ ...valid, tags: ['OK'] }).ok).toBe(false)
    expect(validateManifest({ ...valid, tags: ['a-b', 'bad tag'] }).ok).toBe(false)
  })

  it('拒绝路径穿越/绝对路径/协议预览图', () => {
    for (const light of ['../x.svg', '/etc/passwd', 'C:/x.svg', 'https://e/x.svg', 'a\\b.svg', 'a/b/../../x']) {
      const result = validateManifest({ ...valid, preview: { light } })
      expect(result.ok, light).toBe(false)
    }
  })
})

describe('isValidSkinId / isValidRelativePath', () => {
  it('id 规则', () => {
    expect(isValidSkinId('clean')).toBe(true)
    expect(isValidSkinId('my-windows-98')).toBe(true)
    expect(isValidSkinId('default')).toBe(false)
    expect(isValidSkinId('')).toBe(false)
  })
  it('相对路径规则', () => {
    expect(isValidRelativePath('preview/light.svg')).toBe(true)
    expect(isValidRelativePath('..\\x')).toBe(false)
    expect(isValidRelativePath('/abs')).toBe(false)
    expect(isValidRelativePath('')).toBe(false)
  })
})
