/**
 * v1.5 单元矩阵：GenerationStore（原子/恢复）、版本策略、GenerationService（状态机/取消/并发锁/父子链）、
 * 失败安全不变量（record 层）、输入校验。
 */
import { describe, expect, it } from 'vitest'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { nodeFs } from '../../src/repository/fs.ts'
import {
  bumpPatchVersion, evidenceHashOf, GenerationService, GenerationStore, inputHashOf, RUNNING_STAGES,
  type GenerationRecord,
} from '../../src/generator/lifecycle.ts'

const atomic = (p: string, text: string): Promise<void> => nodeFs().writeFile(p, text)

function makeService(): { service: GenerationService; store: GenerationStore; home: string } {
  const home = join(tmpdir(), 'dsh-skin-v15-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6))
  mkdirSync(home, { recursive: true })
  const store = new GenerationStore(nodeFs(), join(home, 'records.json'), atomic)
  const service = new GenerationService(nodeFs(), home, store)
  return { service, store, home }
}

const imageBytes = new Uint8Array([1, 2, 3, 4])
const createInput = (overrides: Record<string, unknown> = {}) => ({ skinId: 'ai-skin-1', name: 'AI Skin', description: 'd', tags: ['ai'], imageBytes, ...overrides })

describe('GenerationStore', () => {
  it('upsert/list/get 原子索引；schemaVersion=1 与半写容忍', async () => {
    const { store, home } = makeService()
    const record: GenerationRecord = {
      generationId: 'gen-1', skinId: 's1', source: 'create', status: 'QUEUED', stage: 'QUEUED',
      inputHash: 'h', packageVersion: '0.1.0', name: 'S1', tags: [], startedAt: new Date().toISOString(),
    }
    await store.upsert(record)
    expect(await store.get('gen-1')).toMatchObject({ skinId: 's1', status: 'QUEUED' })
    expect((await store.list()).length).toBe(1)
    await store.upsert({ ...record, status: 'COMPLETED', stage: 'COMPLETED' })
    expect((await store.get('gen-1'))?.status).toBe('COMPLETED')
    const raw = JSON.parse(readFileSync(join(home, 'records.json'), 'utf8'))
    expect(raw.schemaVersion).toBe(1)
    expect(raw.records.length).toBe(1)
    // 半写/非法 JSON → 读取按空索引处理（不抛、不崩）
    await nodeFs().writeFile(join(home, 'records.json'), '{broken')
    const fresh = new GenerationStore(nodeFs(), join(home, 'records.json'), atomic)
    expect((await fresh.list()).length).toBe(0)
  })
  it('recover：RUNNING 态 → FAILED/RECOVERY；终态不动', async () => {
    const { store } = makeService()
    const base: GenerationRecord = {
      generationId: 'gen-r1', skinId: 's1', source: 'create', status: 'BUILDING', stage: 'BUILDING',
      inputHash: 'h', packageVersion: '0.1.0', name: 'S1', tags: [], startedAt: new Date().toISOString(),
    }
    const done: GenerationRecord = { ...base, generationId: 'gen-r2', status: 'COMPLETED', stage: 'COMPLETED' }
    await store.upsert(base)
    await store.upsert(done)
    const stale = await store.recover()
    expect(stale.length).toBe(1)
    const recovered = await store.get('gen-r1')
    expect(recovered?.status).toBe('FAILED')
    expect(recovered?.failureDomain).toBe('RECOVERY')
    expect((await store.get('gen-r2'))?.status).toBe('COMPLETED')
  })
})

describe('bumpPatchVersion / 哈希身份', () => {
  it('patch++ 与非法版本回退', () => {
    expect(bumpPatchVersion('0.1.0')).toBe('0.1.1')
    expect(bumpPatchVersion('1.2.9')).toBe('1.2.10')
    expect(bumpPatchVersion(undefined)).toBe('0.1.0')
    expect(bumpPatchVersion('bad')).toBe('0.1.0')
  })
  it('inputHash/evidenceHash 确定性', () => {
    expect(inputHashOf(new Uint8Array([1, 2, 3]))).toBe(inputHashOf(new Uint8Array([1, 2, 3])))
    expect(inputHashOf(new Uint8Array([1, 2, 3]))).not.toBe(inputHashOf(new Uint8Array([1, 2, 4])))
    expect(evidenceHashOf({ a: 1 })).toBe(evidenceHashOf({ a: 1 }))
    expect(evidenceHashOf({ a: 1 })).not.toBe(evidenceHashOf({ a: 2 }))
  })
})

describe('GenerationService', () => {
  it('create 校验矩阵 + QUEUED 记录 + pending 图片落盘', async () => {
    const { service, home } = makeService()
    const bad = await service.create(createInput({ skinId: 'Bad ID' }))
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.failureDomain).toBe('GENERATION_INPUT')
    expect((await service.create(createInput({ tags: ['Bad Tag'] }))).ok).toBe(false)
    expect((await service.create(createInput({ version: 'x.y' }))).ok).toBe(false)
    const ok = await service.create(createInput())
    expect(ok.ok).toBe(true)
    if (!ok.ok) throw new Error(ok.issues.join(';'))
    expect(ok.record.status).toBe('QUEUED')
    expect(ok.record.inputHash).toBe(inputHashOf(imageBytes))
    expect(readFileSync(join(home, 'pending-' + ok.record.generationId, 'input.png')).length).toBe(4)
  })
  it('start/onStage/complete 状态机 + 同 skin keyed lock', async () => {
    const { service } = makeService()
    const created = await service.create(createInput())
    if (!created.ok) throw new Error(created.issues.join(';'))
    const id = created.record.generationId
    const started = await service.start(id)
    expect(started.ok).toBe(true)
    // 同 skin 第二个任务被拒（§51）
    const second = await service.create(createInput())
    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.issues.join(';')).toContain('进行中')
    await service.onStage(id, 'ANALYZING')
    await service.onStage(id, 'SPEC_GENERATED', { specHash: 'sh' })
    expect((await service.get(id))?.stage).toBe('SPEC_GENERATED')
    await service.complete(id, { status: 'COMPLETED', specHash: 'sh', packageHash: 'ph' })
    const done = await service.get(id)
    expect(done?.status).toBe('COMPLETED')
    expect(done?.specHash).toBe('sh')
    expect(service.isRunning('ai-skin-1')).toBe(false)
    // 完成后可再生成（锁释放）
    const third = await service.create(createInput())
    expect(third.ok).toBe(true)
  })
  it('cancel：RUNNING → CANCELLED + 锁释放；终态拒绝取消', async () => {
    const { service } = makeService()
    const created = await service.create(createInput())
    if (!created.ok) throw new Error(created.issues.join(';'))
    const id = created.record.generationId
    await service.start(id)
    const cancelled = await service.cancel(id)
    expect(cancelled.ok).toBe(true)
    if (!cancelled.ok) throw new Error(cancelled.issues.join(';'))
    expect(cancelled.record.status).toBe('CANCELLED')
    expect(cancelled.record.failureDomain).toBe('CANCELLED')
    expect(service.isRunning('ai-skin-1')).toBe(false)
    const again = await service.cancel(id)
    expect(again.ok).toBe(false) // 终态不可取消（§33：取消 ≠ 删除）
    expect((await service.get(id))?.status).toBe('CANCELLED')
  })
  it('latestCompleted + 父子链 + 版本演进', async () => {
    const { service } = makeService()
    const g1 = await service.create(createInput({ version: '0.1.0' }))
    if (!g1.ok) throw new Error(g1.issues.join(';'))
    await service.start(g1.record.generationId)
    await service.complete(g1.record.generationId, { status: 'COMPLETED' })
    const g2 = await service.create(createInput({ version: bumpPatchVersion('0.1.0'), source: 'regenerate', parentGenerationId: g1.record.generationId }))
    if (!g2.ok) throw new Error(g2.issues.join(';'))
    await service.start(g2.record.generationId)
    await service.onStage(g2.record.generationId, 'BUILDING')
    await service.complete(g2.record.generationId, { status: 'FAILED', failureDomain: 'PACKAGE_VALIDATION' })
    // latestCompleted 只算 COMPLETED：仍是 g1（§39：generation 计数 ≠ 版本）
    const latest = await service.latestCompleted('ai-skin-1')
    expect(latest?.generationId).toBe(g1.record.generationId)
    const records = await service.list('ai-skin-1')
    expect(records.length).toBe(2)
    expect(records.find(r => r.generationId === g2.record.generationId)?.parentGenerationId).toBe(g1.record.generationId)
  })
  it('run 前的取消（QUEUED）→ start 拒绝；记录 CANCELLED', async () => {
    const { service } = makeService()
    const created = await service.create(createInput())
    if (!created.ok) throw new Error(created.issues.join(';'))
    const id = created.record.generationId
    const cancelled = await service.cancel(id)
    expect(cancelled.ok).toBe(true)
    const started = await service.start(id)
    expect(started.ok).toBe(false)
    if (!started.ok) expect(started.issues.join(';')).toContain('CANCELLED')
  })
})

describe('RUNNING_STAGES', () => {
  it('运行态集合覆盖阶段机', () => {
    expect(RUNNING_STAGES.has('QUEUED')).toBe(true)
    expect(RUNNING_STAGES.has('VALIDATING')).toBe(true)
    expect(RUNNING_STAGES.has('COMPLETED')).toBe(false)
    expect(RUNNING_STAGES.has('FAILED')).toBe(false)
    expect(RUNNING_STAGES.has('CANCELLED')).toBe(false)
  })
})
