import { describe, expect, it } from 'vitest'
import { validateManifest, isValidSkinId, SKIN_API_VERSION } from '../../src/core/manifest'
import { compatibilityOf, type SkinPackageFiles } from '../../src/core/contract'
import { nodeFs } from '../../src/repository/fs'
import { SkinRepository } from '../../src/repository/repository'
import { resolveSkinRoots } from '../../src/repository/store'
import { cleanup, tempDir, writeSkinFixture } from '../helpers'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const legal = {
  id: 'contract-skin', version: '1.2.3', name: '契约皮肤', author: 'tester',
  description: 'contract test', tags: ['contract'], skinApiVersion: 1, preview: {},
}

describe('Phase 1 契约：SkinManifest 合法/非法矩阵', () => {
  it('合法最小与合法全量', () => {
    expect(validateManifest(legal).ok).toBe(true)
    expect(validateManifest({ ...legal, preview: { light: 'preview/light.svg', dark: 'preview/dark.svg' } }).ok).toBe(true)
    expect(isValidSkinId('gallery-01')).toBe(true)
    expect(isValidSkinId('default')).toBe(false)
  })

  it('非法矩阵：每行都必须失败并给出对应路径', () => {
    const rows: Array<[Record<string, unknown>, string]> = [
      [{ ...legal, id: 42 }, '$.id'],
      [{ ...legal, id: 'Bad' }, '$.id'],
      [{ ...legal, id: 'official' }, '$.id'],
      [{ ...legal, version: '1.0' }, '$.version'],
      [{ ...legal, version: 'not-semver' }, '$.version'],
      [{ ...legal, name: '' }, '$.name'],
      [{ ...legal, name: 'x'.repeat(65) }, '$.name'],
      [{ ...legal, author: '' }, '$.author'],
      [{ ...legal, description: '' }, '$.description'],
      [{ ...legal, description: 'x'.repeat(513) }, '$.description'],
      [{ ...legal, tags: Array.from({ length: 17 }, (_, i) => 'tag' + i) }, '$.tags'],
      [{ ...legal, tags: ['Bad Tag!'] }, '$.tags[0]'],
      [{ ...legal, skinApiVersion: 0 }, '$.skinApiVersion'],
      [{ ...legal, skinApiVersion: 2 }, '$.skinApiVersion'],
      [{ ...legal, skinApiVersion: undefined }, '$.skinApiVersion'],
      [{ ...legal, preview: { light: 'https://x/y.png' } }, '$.preview.light'],
      [{ ...legal, preview: { dark: '../up.svg' } }, '$.preview.dark'],
      [{ ...legal, preview: { light: '/abs.png' } }, '$.preview.light'],
    ]
    for (const [raw, path] of rows) {
      const result = validateManifest(raw)
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.issues.map(i => i.path)).toContain(path)
      }
    }
  })

  it('兼容性事实：skinApiVersion ≠ 1 一律拒绝；compatibilityOf 与之对齐', () => {
    expect(SKIN_API_VERSION).toBe(1)
    expect(compatibilityOf(1).status).toBe('compatible')
    expect(compatibilityOf(2).status).toBe('incompatible')
    expect(compatibilityOf(0).status).toBe('invalid')
    expect(validateManifest({ ...legal, skinApiVersion: 2 }).ok).toBe(false)
    expect(validateManifest({ ...legal, skinApiVersion: 0 }).ok).toBe(false)
  })
})

describe('Phase 1 契约：SkinPackage 结构 + preview 归 Package/Repository 层', () => {
  it('包文件引用形状（SkinPackageFiles 冻结字段）', () => {
    const files: SkinPackageFiles = {
      bundle: 'client/index.js', styles: 'styles/theme.css',
      themeLight: 'theme/light.json', themeDark: 'theme/dark.json',
      previewLight: 'preview/light.svg', previewDark: 'preview/dark.svg',
    }
    expect(Object.keys(files).sort()).toEqual(['bundle', 'previewDark', 'previewLight', 'styles', 'themeDark', 'themeLight'])
  })

  it('preview 资源经 Repository.fileRef/readFile 供给（包层，非 Runtime 操作）', async () => {
    const home = tempDir('dsh-skin-contract-')
    try {
      const roots = resolveSkinRoots(home)
      for (const dir of [roots.installed, roots.generated, roots.downloaded, roots.staging, roots.cache]) mkdirSync(dir, { recursive: true })
      const source = writeSkinFixture(join(home, 'source'), 'preview-skin')
      mkdirSync(join(source, 'preview'), { recursive: true })
      writeFileSync(join(source, 'preview', 'light.svg'), '<svg/>')
      const repo = new SkinRepository(nodeFs(), roots, undefined)
      await repo.hydrate()
      expect((await repo.install(source)).ok).toBe(true)
      const ref = await repo.fileRef('preview-skin', 'preview/light.svg')
      expect(ref).toBeDefined()
      const bytes = await repo.readFile('preview-skin', 'preview/light.svg')
      expect(bytes !== undefined && new TextDecoder().decode(bytes)).toBe('<svg/>')
      // 路径守卫：穿越被拒
      expect(await repo.fileRef('preview-skin', '../manifest.json')).toBeUndefined()
    } finally { cleanup(home) }
  })
})

