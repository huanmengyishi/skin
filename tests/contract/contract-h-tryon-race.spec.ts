import { describe, expect, it } from 'vitest'
import { SkinRuntime, type RuntimeEnv, type SkinInfo, type SkinListInfo } from '../../src/client/runtime/runtime'
import { trackingDom, cleanResidue } from './tracking-dom'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(res => { resolve = res })
  return { promise, resolve }
}

interface SkinSpec {
  info: SkinInfo
  module: { apply?: (ctx: unknown) => void | Promise<void> }
}

function makeInfo(id: string): SkinInfo {
  return {
    id, source: 'installed', state: 'ok', issues: [], rev: 'r', updatedAtMs: 0, trust: 'trusted',
    manifest: { id, version: '1.0.0', name: id, author: 'h', description: 'd', tags: [], skinApiVersion: 1, preview: {} },
    files: { bundle: '/b/' + id + '.js', styles: '/s/' + id + '.css', themeLight: '/t/l.json', themeDark: '/t/d.json' },
  }
}

/** 竞态环境：按皮肤 id 排队 loadScript 闸门；release 按任意顺序放行控制完成顺序。 */
function makeRaceEnv(skins: Record<string, SkinSpec>, gated: Set<string>) {
  const dom = trackingDom()
  const gates: Record<string, Array<{ promise: Promise<void>; resolve(): void }>> = {}
  const invalidated: string[] = []
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
        const skinId = match?.[1] ?? ''
        if (!gated.has(skinId)) return
        const gate = deferred()
        gates[skinId] ??= []
        gates[skinId].push(gate)
        await gate.promise
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
      set: (v: string | null) => { persisted = v },
      writable: () => true,
    },
    dom,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' }),
  }
  return { runtime: new SkinRuntime(env), dom, persisted: () => persisted, invalidated, release: (id: string, index = 0) => { gates[id]?.[index]?.resolve() } }
}

function styleSkin(id: string): SkinSpec {
  return { info: makeInfo(id), module: { apply: (ctx) => { (ctx as { addStyle(c: string): void }).addStyle(id + '-style') } } }
}

const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0))

describe('Phase 2.2 H：Try-on Race（操作顺序 ≠ 完成顺序，最后有效意图决定最终状态）', () => {
  it('H1：enter(A) → enter(B) → exit → 试穿态全空、A/B 无残留、恢复正式基准、persisted 不变', async () => {
    const skins: Record<string, SkinSpec> = { clean: styleSkin('clean'), a: styleSkin('a'), b: styleSkin('b') }
    const made = makeRaceEnv(skins, new Set(['a', 'b']))
    const r = made.runtime
    await r.applySkin('clean', { persist: true })
    const pa = r.tryOn('a'); await flush(); made.release('a'); await pa
    expect(r.currentId).toBe('a')
    const pb = r.tryOn('b'); await flush(); made.release('b'); await pb
    expect(r.currentId).toBe('b')
    await r.exitTryOn()
    expect(r.currentId).toBe('clean')
    expect(r.getSnapshot().tryOnId).toBeNull()
    expect(made.persisted()).toBe('clean')
    expect(made.dom.residue()).toEqual({ ...cleanResidue, css: 1, attribute: 1 })
    expect(made.dom.body().getAttribute('data-dsh-skin')).toBe('clean')
  })

  it('H2：enter(A/B/C) 完成顺序反转（C→A→B）→ 最终 C，A/B 零残留', async () => {
    const skins: Record<string, SkinSpec> = { a: styleSkin('a'), b: styleSkin('b'), c: styleSkin('c') }
    const made = makeRaceEnv(skins, new Set(['a', 'b', 'c']))
    const r = made.runtime
    const pa = r.tryOn('a')
    const pb = r.tryOn('b')
    const pc = r.tryOn('c')
    await flush()
    made.release('c'); await pc
    expect(r.currentId).toBe('c')
    made.release('a'); await pa
    made.release('b'); await pb
    expect(r.currentId).toBe('c')
    expect(r.getSnapshot().tryOnId).toBe('c')
    expect(made.dom.residue()).toEqual({ ...cleanResidue, css: 1, attribute: 1 })
    expect(made.dom.body().getAttribute('data-dsh-skin')).toBe('c')
    expect(made.persisted()).toBeNull()
    await r.exitTryOn()
    expect(r.currentId).toBeNull()
    expect(made.dom.residue()).toEqual(cleanResidue)
  })

  it('H3：enter(A) → exit → A 迟到完成 → 判定过期：零注入、基准保持', async () => {
    const skins: Record<string, SkinSpec> = { clean: styleSkin('clean'), a: styleSkin('a') }
    const made = makeRaceEnv(skins, new Set(['a']))
    const r = made.runtime
    await r.applySkin('clean', { persist: true })
    const pa = r.tryOn('a')
    await flush()
    await r.exitTryOn()
    expect(r.currentId).toBe('clean')
    expect(r.getSnapshot().tryOnId).toBeNull()
    made.release('a')
    await pa
    expect(r.currentId).toBe('clean')
    expect(r.getSnapshot().tryOnId).toBeNull()
    expect(made.dom.residue()).toEqual({ ...cleanResidue, css: 1, attribute: 1 })
    expect(made.dom.body().getAttribute('data-dsh-skin')).toBe('clean')
    expect(made.persisted()).toBe('clean')
  })

  it('H4：快速连点 enter(A,B,C,A,B) 完成顺序打乱 → 最终 B（最后意图），无旧皮肤污染', async () => {
    const skins: Record<string, SkinSpec> = { a: styleSkin('a'), b: styleSkin('b'), c: styleSkin('c') }
    const made = makeRaceEnv(skins, new Set(['a', 'b', 'c']))
    const r = made.runtime
    const p1 = r.tryOn('a')
    const p2 = r.tryOn('b')
    const p3 = r.tryOn('c')
    const p4 = r.tryOn('a')
    const p5 = r.tryOn('b')
    await flush()
    made.release('c', 0); await p3
    made.release('a', 0); await p1
    made.release('b', 0); await p2
    made.release('a', 1); await p4
    made.release('b', 1); await p5
    expect(r.currentId).toBe('b')
    expect(r.getSnapshot().tryOnId).toBe('b')
    expect(made.dom.residue()).toEqual({ ...cleanResidue, css: 1, attribute: 1 })
    expect(made.dom.body().getAttribute('data-dsh-skin')).toBe('b')
    expect(made.persisted()).toBeNull()
    await r.exitTryOn()
    expect(r.currentId).toBeNull()
    expect(made.dom.residue()).toEqual(cleanResidue)
  })

  it('H5：过期句柄 exit 是 no-op；新会话 exit 恢复试穿基准', async () => {
    const skins: Record<string, SkinSpec> = { clean: styleSkin('clean'), a: styleSkin('a'), b: styleSkin('b') }
    const made = makeRaceEnv(skins, new Set(['a', 'b']))
    const r = made.runtime
    await r.applySkin('clean', { persist: true })
    const firstP = r.tryOn('a'); await flush(); made.release('a'); const first = await firstP
    expect(r.currentId).toBe('a')
    const secondP = r.tryOn('b'); await flush(); made.release('b'); const second = await secondP
    expect(r.currentId).toBe('b')
    await first.exit()
    expect(r.currentId).toBe('b')
    expect(r.getSnapshot().tryOnId).toBe('b')
    await second.exit()
    expect(r.currentId).toBe('clean')
    expect(made.persisted()).toBe('clean')
  })
})

