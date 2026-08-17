import { describe, expect, it } from 'vitest'
import { SkinRuntime, type RuntimeEnv, type SkinInfo, type SkinListInfo } from '../../src/client/runtime/runtime'
import { trackingDom, cleanResidue } from './tracking-dom'

function makeInfo(id: string): SkinInfo {
  return {
    id, source: 'installed', state: 'ok', issues: [], rev: 'r', updatedAtMs: 0, trust: 'trusted',
    manifest: { id, version: '1.0.0', name: id, author: 'i', description: 'd', tags: [], skinApiVersion: 1, preview: {} },
    files: { bundle: '/b/' + id + '.js', styles: '/s/' + id + '.css', themeLight: '/t/l.json', themeDark: '/t/d.json' },
  }
}

interface EnvOptions {
  themeTokens?: boolean      // 返回非空主题 token（模拟宿主 ThemePresenter 行为）
  setFails?: boolean         // settings.set 抛错（持久化窗口失败模拟）
}

function makeEnv(id: string, opts: EnvOptions = {}) {
  const dom = trackingDom()
  const info = makeInfo(id)
  const skins: SkinListInfo[] = [{ id, source: 'installed', version: '1.0.0', name: id, author: 'i', description: 'd', tags: [], skinApiVersion: 1, preview: {}, state: 'ok', issues: [], updatedAtMs: 0, trust: 'trusted' }]
  let persisted: string | null = null
  const env: RuntimeEnv = {
    // 模拟宿主 ThemePresenter：override 写 token 进 body.style，dispose 清空为 ''（历史遗留空属性来源）
    themeOverride: (source, tokens) => {
      if (opts.themeTokens !== true) return () => undefined
      const body = dom.body()
      const css = Object.entries(tokens).map(([k, v]) => k + ': ' + v.light + ';').join(' ').trim()
      body.setAttribute('style', css)
      return () => { body.setAttribute('style', '') }
    },
    bundleHost: {
      invalidate: () => undefined,
      importModule: async () => ({ apply: () => undefined }),
      loadScript: async () => undefined,
    },
    api: { list: async () => skins, get: async () => info },
    settings: {
      get: () => persisted,
      set: (v: string | null) => {
        if (opts.setFails === true) throw new Error('写入失败（模拟崩溃/IO）')
        persisted = v
      },
      writable: () => true,
    },
    dom,
    fetchImpl: async (input) => ({
      ok: true, status: 200,
      json: async () => (opts.themeTokens === true ? { '--dsw-alias-brand-primary': '#123456' } : {}),
      text: async () => '',
    }),
  }
  return { runtime: new SkinRuntime(env), dom, persisted: () => persisted }
}

describe('Phase 2.3 I：Crash Recovery（单元层：重建/持久化窗口失败/进程局部状态）', () => {
  it('I1-unit：新 Runtime 实例 + bootstrap(activeId) 完整重建 DOM/属性/样式', async () => {
    const made = makeEnv('clean')
    await made.runtime.applySkin('clean', { persist: true })
    expect(made.persisted()).toBe('clean')
    // 模拟进程重启：全新 Runtime，仅剩持久值
    const made2 = makeEnv('clean')
    await made2.runtime.bootstrap(made.persisted())
    expect(made2.runtime.currentId).toBe('clean')
    expect(made2.dom.body().getAttribute('data-dsh-skin')).toBe('clean')
    // 本桩皮肤模块不注册样式：重建后仅作用域属性（css=0 属预期，attribute=1）
    expect(made2.dom.residue()).toEqual({ dom: 0, css: 0, attribute: 1, listener: 0, observer: 0, timer: 0 })
  })

  it('I2-unit：持久化写入失败 → 状态合法（activeId 已生效、persisted=false、error 记录、不抛穿）', async () => {
    const made = makeEnv('clean', { setFails: true })
    await made.runtime.applySkin('clean', { persist: true })
    expect(made.runtime.currentId).toBe('clean')
    expect(made.runtime.activeId()).toBe('clean')
    expect(made.runtime.getSnapshot().persisted).toBe(false)
    expect(made.runtime.getSnapshot().error).toContain('settings 不可写')
    expect(made.persisted()).toBeNull()
  })

  it('I3-unit：试穿状态是进程局部状态；新实例 bootstrap 只重建正式 activeSkin', async () => {
    const made = makeEnv('clean')
    await made.runtime.applySkin('clean', { persist: true })
    const handle = await made.runtime.tryOn('clean')
    expect(handle.id).toBe('clean')
    expect(made.runtime.getSnapshot().tryOnId).toBe('clean')
    // 模拟 kill：新实例不知道 try-on
    const made2 = makeEnv('clean')
    await made2.runtime.bootstrap('clean')
    expect(made2.runtime.getSnapshot().tryOnId).toBeNull()
    expect(made2.runtime.currentId).toBe('clean')
  })
})

describe('Phase 2.5 style="" 专项（单元回归）', () => {
  it('主题 dispose 遗留空 style="" 时，disposeCurrent 移除之（attribute residue 严格 = 0）', async () => {
    const made = makeEnv('clean', { themeTokens: true })
    await made.runtime.applySkin('clean', { persist: true })
    const body = made.dom.body()
    expect(body.getAttribute('style')).toContain('--dsw-alias-brand-primary')
    await made.runtime.restoreDefault()
    expect(body.getAttribute('data-dsh-skin')).toBeNull()
    expect(body.getAttribute('style')).toBeNull()
    expect(made.dom.residue()).toEqual(cleanResidue)
  })
})

