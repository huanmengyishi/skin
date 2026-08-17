import { describe, expect, it } from 'vitest'
import { loadSkinModule, skinModuleId, unloadSkinModule, type SkinBundleHost } from '../../src/client/runtime/loader'

function fakeHost(factories: Record<string, () => unknown>) {
  const invalidated: string[] = []
  const loaded: string[] = []
  const host: SkinBundleHost = {
    invalidate: id => { invalidated.push(id) },
    importModule: async id => {
      const factory = factories[id]
      if (factory === undefined) throw new Error('no module ' + id)
      return factory()
    },
    loadScript: async url => { loaded.push(url) },
  }
  return { host, invalidated, loaded }
}

describe('loader', () => {
  it('loadSkinModule：invalidate → 脚本注册 → 物化 → 校验 apply', async () => {
    const { host, invalidated, loaded } = fakeHost({
      'dsh-skin/terminal': () => ({ apply: () => undefined }),
    })
    const surface = await loadSkinModule(host, 'terminal', '/bundle.js?v=abc')
    expect(typeof surface.apply).toBe('function')
    expect(invalidated).toEqual(['dsh-skin/terminal'])
    expect(loaded).toEqual(['/bundle.js?v=abc'])
  })

  it('支持 default 导出形态', async () => {
    const { host } = fakeHost({
      'dsh-skin/x': () => ({ default: { apply: () => undefined } }),
    })
    const surface = await loadSkinModule(host, 'x', '/b.js')
    expect(typeof surface.apply).toBe('function')
  })

  it('缺失 apply 时抛错', async () => {
    const { host } = fakeHost({ 'dsh-skin/y': () => ({}) })
    await expect(loadSkinModule(host, 'y', '/b.js')).rejects.toThrow(/apply/)
  })

  it('unloadSkinModule 只 invalidate 自己的模块 id', () => {
    const { host, invalidated } = fakeHost({})
    unloadSkinModule(host, 'terminal')
    expect(invalidated).toEqual([skinModuleId('terminal')])
  })
})
