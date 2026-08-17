import { describe, expect, it } from 'vitest'
import { SkinRuntime, type RuntimeEnv, type SkinInfo, type SkinListInfo } from '../../src/client/runtime/runtime'
import type { AttrTarget, ParentLike, SkinDomLike } from '../../src/client/runtime/skin-context'
import { ApplyError, LoadError, RollbackError } from '../../src/core/errors'
import { trackingDom, cleanResidue } from './tracking-dom'

interface SkinSpec {
  info: SkinInfo
  module: { apply?: (ctx: unknown) => void | Promise<void> }
  loadFails?: Error
}

function makeInfo(id: string, state: SkinInfo['state'] = 'ok'): SkinInfo {
  return {
    id, source: 'installed', state, issues: [], rev: 'r', updatedAtMs: 0, trust: 'trusted',
    manifest: { id, version: '1.0.0', name: id, author: 'g', description: 'd', tags: [], skinApiVersion: 1, preview: {} },
    files: { bundle: '/b/' + id + '.js', styles: '/s/' + id + '.css', themeLight: '/t/l.json', themeDark: '/t/d.json' },
  }
}

function makeEnv(skins: Record<string, SkinSpec>) {
  const dom = trackingDom()
  const invalidated: string[] = []
  const setCalls: Array<string | null> = []
  let persisted: string | null = null
  const listInfo: SkinListInfo[] = Object.values(skins).map(s => ({
    id: s.info.id, source: s.info.source, version: s.info.manifest.version, name: s.info.manifest.name,
    author: s.info.manifest.author, description: s.info.manifest.description, tags: [], skinApiVersion: 1,
    preview: {}, state: s.info.state, issues: [], updatedAtMs: 0, trust: 'trusted',
  }))
  const env: RuntimeEnv = {
    themeOverride: () => () => undefined,
    bundleHost: {
      invalidate: (id) => { invalidated.push(id) },
      importModule: async (id: string) => {
        const skinId = String(id).replace(/^dsh-skin\//, '')
        return skins[skinId]?.module ?? {}
      },
      loadScript: async (url: string) => {
        const match = String(url).match(/\/b\/([^/.]+)\.js$/)
        const spec = match !== null ? skins[match[1]] : undefined
        if (spec?.loadFails !== undefined) throw spec.loadFails
      },
    },
    api: {
      list: async () => listInfo,
      get: async (id) => {
        const spec = skins[id]
        if (spec === undefined) throw new Error('HTTP 404')
        return spec.info
      },
    },
    settings: {
      get: () => persisted,
      set: (v) => { setCalls.push(v); persisted = v },
      writable: () => true,
    },
    dom,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' }),
  }
  return { runtime: new SkinRuntime(env), dom, setCalls, persisted: () => persisted, invalidated }
}

describe('Phase 2.1 G：Failed Apply（A active → apply(B) 失败 → B 残留=0 → A 保持）', () => {
  it('G1：B 在 apply 内注册样式/属性/观察器/定时器/元素后抛错 → 六类 residue 全 0，A 不动，activeSkin 不变', async () => {
    const skins: Record<string, SkinSpec> = {
      a: { info: makeInfo('a'), module: { apply: (ctx) => { (ctx as { addStyle(c: string): void }).addStyle('a-style') } } },
      b: { info: makeInfo('b'), module: {} },
    }
    const made = makeEnv(skins)
    // B 模块在拿到测试 body 后回填：apply 内注册五类副作用再抛错
    skins.b.module = {
      apply: (ctx) => {
        const c = ctx as { addStyle(s: string): void; addAttribute(t: AttrTarget, n: string, v: string): void; addObserver(t: unknown, cb: (r: unknown[]) => void): void; addTimer(fn: () => void, ms: number): void; addElement(e: { alive: boolean }): void }
        c.addStyle('b-style')
        c.addAttribute(made.dom.body(), 'data-g-b', '1')
        c.addObserver({}, () => undefined)
        c.addTimer(() => undefined, 100)
        const el = { alive: false, remove: () => { el.alive = false } }
        c.addElement(el)
        throw new Error('G: b 故意失败')
      },
    }
    await made.runtime.applySkin('a', { persist: true })
    expect(made.persisted()).toBe('a')
    const before = { ...cleanResidue, css: 1, attribute: 1 }
    expect(made.dom.residue()).toEqual(before)
    await expect(made.runtime.applySkin('b', { persist: true })).rejects.toBeInstanceOf(ApplyError)
    expect(made.dom.residue()).toEqual(before)
    expect(made.dom.body().getAttribute('data-dsh-skin')).toBe('a')
    expect(made.dom.body().getAttribute('data-g-b')).toBeNull()
    expect(made.runtime.currentId).toBe('a')
    expect(made.runtime.activeId()).toBe('a')
    expect(made.persisted()).toBe('a')
    expect(made.setCalls).toEqual(['a'])
    expect(made.invalidated).toContain('dsh-skin/b')
  })

  it('G2：switchSkin(B) 失败 → 自动恢复 A，persisted 保持 A，RollbackError，无 B 残留', async () => {
    const skins: Record<string, SkinSpec> = {
      a: { info: makeInfo('a'), module: { apply: (ctx) => { (ctx as { addStyle(c: string): void }).addStyle('a-style') } } },
      b: { info: makeInfo('b'), module: {} },
    }
    const made = makeEnv(skins)
    skins.b.module = { apply: () => { throw new Error('G: b 失败') } }
    await made.runtime.applySkin('a', { persist: true })
    await expect(made.runtime.switchSkin('b')).rejects.toBeInstanceOf(RollbackError)
    expect(made.dom.body().getAttribute('data-dsh-skin')).toBe('a')
    expect(made.runtime.currentId).toBe('a')
    expect(made.persisted()).toBe('a')
    expect(made.setCalls).toEqual(['a'])
    expect(made.dom.residue()).toEqual({ ...cleanResidue, css: 1, attribute: 1 })
  })

  it('G3：B bundle 加载失败 → 零副作用，A 不动，LoadError', async () => {
    const skins: Record<string, SkinSpec> = {
      a: { info: makeInfo('a'), module: { apply: (ctx) => { (ctx as { addStyle(c: string): void }).addStyle('a-style') } } },
      b: { info: makeInfo('b'), module: {}, loadFails: new Error('网络错误') },
    }
    const made = makeEnv(skins)
    await made.runtime.applySkin('a', { persist: true })
    await expect(made.runtime.applySkin('b', { persist: true })).rejects.toBeInstanceOf(LoadError)
    expect(made.dom.residue()).toEqual({ ...cleanResidue, css: 1, attribute: 1 })
    expect(made.persisted()).toBe('a')
    expect(made.runtime.currentId).toBe('a')
  })

  it('G4：B 状态 invalid → 加载前拒绝，A 不动，activeSkin 不变，不触发模块加载', async () => {
    const skins: Record<string, SkinSpec> = {
      a: { info: makeInfo('a'), module: { apply: (ctx) => { (ctx as { addStyle(c: string): void }).addStyle('a-style') } } },
      b: { info: makeInfo('b', 'invalid'), module: {} },
    }
    const made = makeEnv(skins)
    await made.runtime.applySkin('a', { persist: true })
    await expect(made.runtime.applySkin('b', { persist: true })).rejects.toBeInstanceOf(LoadError)
    expect(made.runtime.currentId).toBe('a')
    expect(made.persisted()).toBe('a')
    expect(made.invalidated).not.toContain('dsh-skin/b')
  })

  it('G5：无激活皮肤时 A 自身 apply 失败（partial）→ 回到 default，六类 residue 全 0，persisted 不变', async () => {
    const skins: Record<string, SkinSpec> = {
      a: { info: makeInfo('a'), module: {} },
    }
    const made = makeEnv(skins)
    skins.a.module = { apply: (ctx) => {
      const c = ctx as { addStyle(s: string): void }
      c.addStyle('a-partial')
      throw new Error('a 失败')
    } }
    await expect(made.runtime.applySkin('a', { persist: true })).rejects.toBeInstanceOf(ApplyError)
    expect(made.dom.residue()).toEqual(cleanResidue)
    expect(made.runtime.currentId).toBeNull()
    expect(made.persisted()).toBeNull()
    expect(made.setCalls).toEqual([])
  })
})

