import { describe, expect, it, vi } from 'vitest'
import { SkinController } from '../../src/client/controller/controller'
import { AIGenerationController } from '../../src/client/controller/generation-controller'
import { ApplyError, LoadError, RollbackError } from '../../src/core/errors'
import { readFileSync } from 'node:fs'

interface FakeRuntime {
  calls: string[]
  getSnapshot(): unknown
  subscribe(listener: () => void): () => void
  listSkins(): Promise<void>
  switchSkin(id: string): Promise<void>
  restoreDefault(): Promise<void>
  tryOn(id: string): Promise<{ id: string; exit(): Promise<void> }>
  exitTryOn(): Promise<void>
  removeSkin(id: string): Promise<void>
}

function fakeRuntime(): FakeRuntime {
  const calls: string[] = []
  return {
    calls,
    getSnapshot: () => ({ skins: [], activeId: null, tryOnId: null, status: 'ready', error: null, persisted: true }),
    subscribe: () => { calls.push('subscribe'); return () => undefined },
    listSkins: async () => { calls.push('listSkins') },
    switchSkin: async (id) => { calls.push('switchSkin:' + id) },
    restoreDefault: async () => { calls.push('restoreDefault') },
    tryOn: async (id) => { calls.push('tryOn:' + id); return { id, exit: async () => { calls.push('exit:' + id) } } },
    exitTryOn: async () => { calls.push('exitTryOn') },
    removeSkin: async (id) => { calls.push('removeSkin:' + id) },
  }
}

function makeController(runtime: FakeRuntime) {
  const api = {
    list: async () => [] as never[],
    get: async () => ({}) as never,
  }
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' })
  return new SkinController({ runtime: runtime as never, api, fetchImpl })
}

describe('Phase 4 SkinController（唯一编排面）', () => {
  it('契约面方法齐备（Phase 1 SkinControllerFace 落地）', () => {
    const c = makeController(fakeRuntime())
    for (const name of ['getSnapshot', 'subscribe', 'list', 'apply', 'switch', 'restore', 'enter', 'exit', 'removeSkin', 'listSkins', 'getSkin', 'exportUrl', 'saveMeta', 'generate', 'regenerate', 'browseWorkshop', 'workshopAction', 'publish', 'report', 'describeError'] as const) {
      expect(typeof c[name]).toBe('function')
    }
  })

  it('生命周期映射：apply→switchSkin、enter→tryOn、exit→exitTryOn、restore→restoreDefault、removeSkin→removeSkin', async () => {
    const rt = fakeRuntime()
    const c = makeController(rt)
    await c.apply('a')
    await c.switch('b')
    await c.restore()
    const handle = await c.enter('c')
    await handle.exit()
    await c.exit()
    await c.removeSkin('d')
    await c.list()
    expect(rt.calls).toEqual(['switchSkin:a', 'switchSkin:b', 'restoreDefault', 'tryOn:c', 'exit:c', 'exitTryOn', 'removeSkin:d', 'listSkins'])
  })

  it('host 操作经 controller 转发（路径与方法正确）', async () => {
    const paths: string[] = []
    const bodies: unknown[] = []
    const rt = fakeRuntime()
    const api = { list: async () => [] as never[], get: async () => ({}) as never }
    const fetchImpl = async (input: string, init?: unknown) => {
      paths.push(input.split('?')[0])
      bodies.push((init as { body?: string } | undefined)?.body ?? null)
      return { ok: true, status: 200, json: async () => ({ ok: true }), text: async () => '' }
    }
    const c = new SkinController({ runtime: rt as never, api, fetchImpl })
    await c.generate({ imageBase64: 'x', name: 'n', description: 'd', tags: [] })
    await c.regenerate('g')
    await c.saveMeta('m', { name: 'n', author: 'a', description: 'd', tags: [] })
    await c.publish('p', 'new')
    await c.publish('p', 'version')
    await c.report('r')
    await c.workshopAction('download', 'w')
    await c.browseWorkshop('q')
    expect(paths).toEqual(['/dsh-skin/api/generate', '/dsh-skin/api/regenerate', '/dsh-skin/api/skins/m/meta', '/dsh-skin/api/workshop/publish', '/dsh-skin/api/workshop/publish-version', '/dsh-skin/api/workshop/report', '/dsh-skin/api/workshop/download', '/dsh-skin/api/workshop/skins'])
    expect(JSON.parse(bodies[0] as string)).toMatchObject({ imageBase64: 'x', name: 'n' })
    expect(c.exportUrl('skin-id')).toBe('/dsh-skin/api/skins/skin-id/export')
  })

  it('错误面：SkinError → 消息；普通 Error → message；其它 → String', () => {
    const c = makeController(fakeRuntime())
    expect(c.describeError(new ApplyError('apply 失败', { skinId: 'a' }))).toBe('apply 失败')
    expect(c.describeError(new LoadError('bundle 加载失败：x'))).toBe('bundle 加载失败：x')
    expect(c.describeError(new RollbackError('切换失败：已恢复原皮肤 clean'))).toBe('切换失败：已恢复原皮肤 clean')
    expect(c.describeError(new Error('普通错误'))).toBe('普通错误')
    expect(c.describeError('字符串错误')).toBe('字符串错误')
  })
})

describe('v1.5 AIGenerationController（Generation 域编排面）', () => {
  it('Generation 操作全部经宿主 API 转发（路径/方法正确；不触 runtime/repository）', async () => {
    const paths: string[] = []
    const bodies: unknown[] = []
    const fetchImpl = async (input: string, init?: unknown) => {
      paths.push(input.split('?')[0])
      bodies.push((init as { body?: string } | undefined)?.body ?? null)
      return { ok: true, status: 200, json: async () => ({ generations: [], ok: true }) }
    }
    const c = new AIGenerationController({ fetchImpl })
    await c.createGeneration({ name: 'n', id: 'ai-1', imageBase64: 'x' })
    await c.run('gen-1')
    await c.get('gen-1')
    await c.list('ai-1')
    await c.cancel('gen-1')
    await c.specEdit('ai-1', { specChanges: [] })
    await c.reinstall('ai-1')
    expect(paths).toEqual([
      '/dsh-skin/api/generations',
      '/dsh-skin/api/generate',
      '/dsh-skin/api/generations/gen-1',
      '/dsh-skin/api/generations',
      '/dsh-skin/api/generations/gen-1/cancel',
      '/dsh-skin/api/skins/ai-1/spec-edit',
      '/dsh-skin/api/skins/ai-1/reinstall',
    ])
    expect(JSON.parse(bodies[0] as string)).toMatchObject({ name: 'n', id: 'ai-1' })
    expect(JSON.parse(bodies[1] as string)).toMatchObject({ generationId: 'gen-1' })
  })

  it('get：404/非 JSON → null；list：失败 → []（UI 面安全降级）', async () => {
    const c = new AIGenerationController({ fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}) }) })
    expect(await c.get('missing')).toBeNull()
    expect(await c.list()).toEqual([])
  })
})

describe('Phase 4 架构隔离（UI 不 import 内部实现）', () => {
  it('skin-card.tsx 只 import controller 与公共契约面，不触 runtime/repository 内部', () => {
    const source = readFileSync('src/client/ui/skin-card.tsx', 'utf8')
    expect(source).not.toMatch(/from '\.\.\/runtime\/runtime'/g)
    expect(source).not.toMatch(/from '\.\.\/runtime\/skin-context'/g)
    expect(source).not.toMatch(/from '\.\.\/runtime\/loader'/g)
    expect(source).not.toMatch(/from ['"][^'"]*repository[^'"]*['"]/g)
    expect(source).not.toMatch(/from '\.\.\/\.\.\/repository\//g)
    expect(source).toMatch(/from '\.\.\/controller\/controller/g)
    // v1.5：UI 只经 AIGenerationController 触达 generation API
    expect(source).toMatch(/from '\.\.\/controller\/generation-controller/g)
    // UI 不得直接 fetch 皮肤 API（全部经 controller）
    expect(source).not.toMatch(/fetch\(['"]\/dsh-skin/g)
  })
})

