import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SkinRuntime, type RuntimeEnv, type SkinInfo, type SkinListInfo } from '../../src/client/runtime/runtime'

import type { AttrTarget, ParentLike, SkinDomLike, ThemeTokenOverrides } from '../../src/client/runtime/skin-context'

function fakeDom(): SkinDomLike {
  const bodyEl = {
    attrs: new Map<string, string>(),
    hasAttribute: (n: string) => bodyEl.attrs.has(n),
    getAttribute: (n: string) => bodyEl.attrs.get(n) ?? null,
    setAttribute: (n: string, v: string) => { bodyEl.attrs.set(n, v) },
    removeAttribute: (n: string) => { bodyEl.attrs.delete(n) },
    appendChild: () => undefined,
  } as AttrTarget & ParentLike & { attrs: Map<string, string> }
  return {
    createStyle: () => ({ remove: () => undefined }),
    createObserver: () => ({ observe: () => undefined, disconnect: () => undefined }),
    setTimer: () => ({ clear: () => undefined }),
    body: () => bodyEl,
    removeOwnedStyles: () => undefined,
  }
}

function skinInfo(id: string): SkinInfo {
  return {
    id, source: 'builtin', state: 'ok', issues: [], rev: 'rev1', updatedAtMs: 0, trust: 'trusted',
    manifest: { id, version: '1.0.0', name: id, author: 't', description: 'd', tags: [], skinApiVersion: 1, preview: {} },
    files: { bundle: '/plugins/x.js', styles: '/x.css', themeLight: '/l.json', themeDark: '/d.json' },
  }
}

function makeRuntime(overrides: Partial<RuntimeEnv> = {}) {
  const info = skinInfo('contract-skin')
  const skins: SkinListInfo[] = [{ id: 'contract-skin', source: 'builtin', version: '1.0.0', name: 'n', author: 'a', description: 'd', tags: [], skinApiVersion: 1, preview: {}, state: 'ok', issues: [], updatedAtMs: 0, trust: 'trusted' }]
  let persisted: string | null = null
  const settings = { get: () => persisted, set: (v: string | null) => { persisted = v }, writable: () => true }
  const env: RuntimeEnv = {
    themeOverride: () => () => undefined,
    bundleHost: { invalidate: () => undefined, importModule: async () => ({ apply: () => undefined }), loadScript: async () => undefined },
    api: { list: async () => skins, get: async () => info },
    settings,
    dom: fakeDom(),
    fetchImpl: async (input) => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' }),
    ...overrides,
  }
  return { runtime: new SkinRuntime(env), settings }
}

describe('Phase 1 契约：SkinRuntimeFace 结构一致性 + 命名映射', () => {
  let runtime: SkinRuntime
  let settings: { get(): string | null; set(v: string | null): void }

  beforeEach(() => {
    const made = makeRuntime()
    runtime = made.runtime
    settings = made.settings
  })

  it('实现满足冻结契约面（契约名→实现名一一映射，方法齐备，且无 preview 成员）', () => {
    // 契约名与实现名的固定映射（v1.0.0 验收事实；改名是 Phase 2 候选）
    const mapping: Record<string, string> = {
      apply: 'applySkin', switch: 'switchSkin', restore: 'restoreDefault',
      enter: 'tryOn', exit: 'exitTryOn', list: 'listSkins', remove: 'removeSkin',
      bootstrap: 'bootstrap', getSnapshot: 'getSnapshot', subscribe: 'subscribe', activeId: 'activeId',
    }
    const impl = runtime as unknown as Record<string, unknown>
    for (const [contractName, implName] of Object.entries(mapping)) {
      expect(typeof impl[implName]).toBe('function')
      expect(contractName).toBeTruthy()
    }
    expect('preview' in runtime).toBe(false)
  })

  it('命名映射语义：apply=applySkin(persist:true)、enter=tryOn、exit=exitTryOn、restore=restoreDefault', async () => {
    // apply（=applySkin persist:true）→ 持久化 activeSkin
    await runtime.applySkin('contract-skin', { persist: true })
    expect(settings.get()).toBe('contract-skin')
    // enter（=tryOn）→ 试穿句柄，不持久化；exit（=handle.exit / exitTryOn）→ 退出
    const handle = await runtime.tryOn('contract-skin')
    expect(handle.id).toBe('contract-skin')
    await runtime.exitTryOn()
    // restore（=restoreDefault）→ activeSkin 置 null
    await runtime.restoreDefault()
    expect(settings.get()).toBeNull()
  })
})

