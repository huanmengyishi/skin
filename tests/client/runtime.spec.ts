import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SkinRuntime, type RuntimeEnv, type SkinInfo, type SkinListInfo } from '../../src/client/runtime/runtime'
import type { AttrTarget, ParentLike, SkinDomLike, ThemeTokenOverrides } from '../../src/client/runtime/skin-context'

// ---------- 测试替身 ----------

function fakeDom(bodyAttrs?: Map<string, string>): SkinDomLike & { bodyEl: FakeBody } {
  const bodyEl: FakeBody = {
    attrs: bodyAttrs ?? new Map(),
    hasAttribute: n => bodyEl.attrs.has(n),
    getAttribute: n => bodyEl.attrs.has(n) ? bodyEl.attrs.get(n) ?? null : null,
    setAttribute: (n, v) => { bodyEl.attrs.set(n, v) },
    removeAttribute: n => { bodyEl.attrs.delete(n) },
    appendChild: () => undefined,
  }
  return {
    bodyEl,
    createStyle: () => ({ remove: () => undefined }),
    createObserver: () => ({ observe: () => undefined, disconnect: () => undefined }),
    setTimer: () => ({ clear: () => undefined }),
    body: () => bodyEl,
    removeOwnedStyles: () => undefined,
  }
}

interface FakeBody extends AttrTarget, ParentLike {
  attrs: Map<string, string>
}

interface FakeModule {
  id: string
  apply?: (ctx: unknown) => void | Promise<void>
  applyError?: Error
}

function makeEnv(options: {
  info: SkinInfo
  skins?: SkinListInfo[]
  failGet?: Error
  applyError?: Error
  persistError?: Error
}) {
  const bodyDom = fakeDom()
  const overrides: { source: string; tokens: ThemeTokenOverrides; disposed: boolean }[] = []
  const factories = new Map<string, () => unknown>()
  const scripts: string[] = []
  const invalidated: string[] = []
  let persisted: string | null = null
  const env: RuntimeEnv = {
    themeOverride: (source, tokens) => {
      const record = { source, tokens, disposed: false }
      overrides.push(record)
      return () => { record.disposed = true }
    },
    bundleHost: {
      invalidate: id => { invalidated.push(id) },
      importModule: async id => {
        const factory = factories.get(id)
        if (factory === undefined) throw new Error('no module ' + id)
        return factory()
      },
      loadScript: async url => {
        scripts.push(url)
        const module = { apply: options.applyError === undefined ? () => undefined : () => { throw options.applyError } }
        factories.set('dsh-skin/' + options.info.id, () => module)
      },
    },
    api: {
      list: async () => options.skins ?? [{
        id: options.info.id, source: options.info.source, version: '1.0.0', name: options.info.id, author: 't', description: 'd',
        tags: [], skinApiVersion: 1, preview: {}, state: options.info.state, issues: [], updatedAtMs: 1, trust: 'trusted' as const,
      }],
      get: async id => {
        if (options.failGet !== undefined) throw options.failGet
        if (id !== options.info.id) throw new Error('404')
        return options.info
      },
    },
    settings: {
      get: () => persisted,
      set: value => {
        if (options.persistError !== undefined) throw options.persistError
        persisted = value
      },
      writable: () => options.persistError === undefined,
    },
    dom: bodyDom,
    fetchImpl: async (input) => {
      const url = String(input)
      if (url.includes('theme/light.json')) return { ok: true, status: 200, json: async () => ({ '--x': '#fff' }), text: async () => '{}' }
      if (url.includes('theme/dark.json')) return { ok: true, status: 200, json: async () => ({ '--x': '#000' }), text: async () => '{}' }
      if (url.includes('styles/theme.css')) return { ok: true, status: 200, json: async () => ({}), text: async () => 'body[data-dsh-skin="' + options.info.id + '"]{}' }
      return { ok: false, status: 404, json: async () => ({}), text: async () => '' }
    },
  }
  return { env, bodyDom, overrides, scripts, invalidated, persisted: () => persisted }
}

function baseInfo(id: string, state: 'ok' | 'invalid' | 'corrupt' = 'ok'): SkinInfo {
  return {
    id, source: 'builtin', state, issues: [],
    manifest: { id, version: '1.0.0', name: id, author: 't', description: 'd', tags: [], skinApiVersion: 1, preview: {} },
    files: {
      bundle: '/dsh-skin/skins/' + id + '/files/client/index.js?v=1',
      styles: '/dsh-skin/skins/' + id + '/files/styles/theme.css',
      themeLight: '/dsh-skin/skins/' + id + '/files/theme/light.json',
      themeDark: '/dsh-skin/skins/' + id + '/files/theme/dark.json',
    },
    rev: '1',
    updatedAtMs: 1,
    trust: 'trusted' as const,
  }
}

// ---------- 用例 ----------

describe('SkinRuntime apply', () => {
  it('apply：加载→token 覆盖→样式→作用域属性→verify→持久化', async () => {
    const { env, bodyDom, overrides, persisted } = makeEnv({ info: baseInfo('terminal') })
    const runtime = new SkinRuntime(env)
    await runtime.applySkin('terminal')
    expect(runtime.currentId).toBe('terminal')
    expect(bodyDom.bodyEl.attrs.get('data-dsh-skin')).toBe('terminal')
    expect(overrides.length).toBe(1)
    expect(overrides[0].source).toBe('dsh-skin:terminal')
    expect(persisted()).toBe('terminal')
    expect(runtime.getSnapshot().activeId).toBe('terminal')
  })

  it('apply 失败：清理 partial effects，activeSkin 不变', async () => {
    const { env, bodyDom, persisted } = makeEnv({ info: baseInfo('broken'), applyError: new Error('boom') })
    const runtime = new SkinRuntime(env)
    await expect(runtime.applySkin('broken')).rejects.toThrow(/apply 失败/)
    expect(runtime.currentId).toBeNull()
    expect(bodyDom.bodyEl.attrs.has('data-dsh-skin')).toBe(false)
    expect(persisted()).toBeNull()
    expect(runtime.getSnapshot().activeId).toBeNull()
  })

  it('拒绝损坏/非法包', async () => {
    const corrupt = makeEnv({ info: baseInfo('corrupt', 'corrupt') })
    await expect(new SkinRuntime(corrupt.env).applySkin('corrupt')).rejects.toThrow(/损坏/)
    const invalid = makeEnv({ info: baseInfo('invalid', 'invalid') })
    await expect(new SkinRuntime(invalid.env).applySkin('invalid')).rejects.toThrow(/非法/)
  })

  it('css/token 缺失时仍可 apply（结构层允许为空，body 作用域由运行时提供）', async () => {
    const { env, bodyDom } = makeEnv({ info: baseInfo('empty') })
    env.fetchImpl = async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => '' })
    const runtime = new SkinRuntime(env)
    await runtime.applySkin('empty')
    expect(runtime.currentId).toBe('empty')
    expect(bodyDom.bodyEl.attrs.get('data-dsh-skin')).toBe('empty')
  })
})

describe('SkinRuntime switch / rollback', () => {
  it('A→B：dispose A，仅 B 生效，activeSkin=B', async () => {
    const both = makeEnvWithTwo(baseInfo('clean'), baseInfo('terminal'))
    const r = new SkinRuntime(both.env)
    await r.applySkin('clean')
    await r.switchSkin('terminal')
    expect(r.currentId).toBe('terminal')
    expect(both.bodyDom.bodyEl.attrs.get('data-dsh-skin')).toBe('terminal')
    expect(both.persisted()).toBe('terminal')
  })

  it('B apply 失败：恢复 A，activeSkin 保持 A', async () => {
    const both = makeEnvWithTwo(baseInfo('clean'), baseInfo('bad'), { badApplyError: new Error('boom') })
    const r = new SkinRuntime(both.env)
    await r.applySkin('clean')
    await expect(r.switchSkin('bad')).rejects.toThrow(/已恢复原皮肤 clean/)
    expect(r.currentId).toBe('clean')
    expect(both.persisted()).toBe('clean')
    expect(both.bodyDom.bodyEl.attrs.get('data-dsh-skin')).toBe('clean')
  })
})

describe('SkinRuntime try-on / restore', () => {
  it('try-on 不持久化；exit 恢复原皮肤', async () => {
    const both = makeEnvWithTwo(baseInfo('clean'), baseInfo('terminal'))
    const r = new SkinRuntime(both.env)
    await r.applySkin('clean')
    const handle = await r.tryOn('terminal')
    expect(r.currentId).toBe('terminal')
    expect(both.persisted()).toBe('clean') // 未变
    expect(r.getSnapshot().tryOnId).toBe('terminal')
    await handle.exit()
    expect(r.currentId).toBe('clean')
    expect(both.persisted()).toBe('clean')
    expect(r.getSnapshot().tryOnId).toBeNull()
  })

  it('epoch：旧试穿句柄的 exit 是新会话的 no-op；链式 enter 的 exit 恢复试穿基准（H1 澄清）', async () => {
    const both = makeEnvWithTwo(baseInfo('clean'), baseInfo('terminal'))
    const r = new SkinRuntime(both.env)
    await r.applySkin('clean')
    const first = await r.tryOn('terminal')
    expect(r.currentId).toBe('terminal')
    // 第二次试穿取代第一次（epoch 递增）
    const second = await r.tryOn('clean')
    expect(r.currentId).toBe('clean')
    expect(r.getSnapshot().tryOnId).toBe('clean')
    // 旧句柄 exit 必须是 no-op：不能破坏新会话
    await first.exit()
    expect(r.currentId).toBe('clean')
    expect(r.getSnapshot().tryOnId).toBe('clean')
    // 新句柄 exit 恢复试穿基准（正式激活皮肤 clean；H1 证据驱动的契约澄清）
    await second.exit()
    expect(r.currentId).toBe('clean')
    expect(r.getSnapshot().tryOnId).toBeNull()
  })

  it('restoreDefault：dispose + activeSkin=null', async () => {
    const both = makeEnvWithTwo(baseInfo('clean'), baseInfo('terminal'))
    const r = new SkinRuntime(both.env)
    await r.applySkin('terminal')
    await r.restoreDefault()
    expect(r.currentId).toBeNull()
    expect(both.persisted()).toBeNull()
    expect(both.bodyDom.bodyEl.attrs.has('data-dsh-skin')).toBe(false)
  })
})

describe('SkinRuntime bootstrap', () => {
  it('按持久值恢复；失败保留持久值并记录错误', async () => {
    const both = makeEnvWithTwo(baseInfo('clean'), baseInfo('terminal'))
    const r = new SkinRuntime(both.env)
    await r.bootstrap('clean')
    expect(r.currentId).toBe('clean')
    await r.bootstrap('ghost')
    expect(r.currentId).toBe('clean') // bootstrap 失败不替换当前
    expect(r.getSnapshot().error).toContain('恢复失败')
  })
})

// ---------- 双皮肤环境 ----------

interface TwoEnvOptions {
  badApplyError?: Error
  getDelayMs?: number
}

function makeEnvWithTwo(a: SkinInfo, b: SkinInfo, opts: TwoEnvOptions = {}) {
  const bodyDom = fakeDom()
  const overrides: { disposed: boolean }[] = []
  const factories = new Map<string, () => unknown>()
  let persisted: string | null = null
  const infoById = new Map([[a.id, a], [b.id, b]])
  const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
  const env: RuntimeEnv = {
    themeOverride: (_source, _tokens) => {
      const record = { disposed: false }
      overrides.push(record)
      return () => { record.disposed = true }
    },
    bundleHost: {
      invalidate: () => undefined,
      importModule: async id => {
        const factory = factories.get(id)
        if (factory === undefined) throw new Error('no module ' + id)
        return factory()
      },
      loadScript: async url => {
        let skinId: string
        if (url.includes('/clean/')) skinId = 'clean'
        else if (url.includes('/bad/')) skinId = 'bad'
        else skinId = 'terminal'
        const throws = skinId === 'bad' ? opts.badApplyError : undefined
        factories.set('dsh-skin/' + skinId, () => ({
          apply: throws === undefined ? () => undefined : () => { throw throws },
        }))
      },
    },
    api: {
      list: async () => [a, b].map(i => ({ id: i.id, source: i.source, version: '1.0.0', name: i.id, author: 't', description: 'd', tags: [], skinApiVersion: 1, preview: {}, state: i.state, issues: [], updatedAtMs: 1, trust: 'trusted' as const })),
      get: async id => {
        if (opts.getDelayMs !== undefined) await delay(opts.getDelayMs)
        const info = infoById.get(id)
        if (info === undefined) throw new Error('404')
        return info
      },
    },
    settings: {
      get: () => persisted,
      set: value => { persisted = value },
      writable: () => true,
    },
    dom: bodyDom,
    fetchImpl: async (input) => {
      const url = String(input)
      if (url.includes('light.json')) return { ok: true, status: 200, json: async () => ({ '--x': '#fff' }), text: async () => '{}' }
      if (url.includes('dark.json')) return { ok: true, status: 200, json: async () => ({ '--x': '#000' }), text: async () => '{}' }
      if (url.includes('theme.css')) return { ok: true, status: 200, json: async () => ({}), text: async () => 'body[data-dsh-skin="x"]{}' }
      return { ok: false, status: 404, json: async () => ({}), text: async () => '' }
    },
  }
  return { env, bodyDom, persisted: () => persisted }
}
