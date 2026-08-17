import { describe, expect, it } from 'vitest'
import { mkdirSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { computeTargetDims } from '../../src/generator/downscale'
import { classifyVisionFailure } from '../../src/generator/failure'
import { VisionQueue } from '../../src/generator/vision-queue'
import { nodeFs } from '../../src/repository/fs'
import { SkinRepository } from '../../src/repository/repository'
import { resolveSkinRoots } from '../../src/repository/store'
import { generateSkin } from '../../src/generator/iterate'
import { fixtureBrain, type GeneratorBrain } from '../../src/generator/vision'

const TINY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

describe('Q5 Vision Provider Resilience（队列/缓存键/预算/分类；无重复 retry）', () => {
  it('computeTargetDims：预算内原样；超预算按比例且保纵横比', () => {
    expect(computeTargetDims(1200, 720, 4_000_000)).toEqual({ width: 1200, height: 720, downscaled: false })
    const big = computeTargetDims(4000, 3000, 4_000_000)
    expect(big.downscaled).toBe(true)
    expect(big.width * big.height).toBeLessThanOrEqual(4_000_000)
    expect(Math.abs(big.width / big.height - 4 / 3)).toBeLessThan(0.01)
  })

  it('classifyVisionFailure：FIXTURE 错误文本分类矩阵', () => {
    expect(classifyVisionFailure(new Error('429 API rate limit exceeded'))).toBe('RATE_LIMITED')
    expect(classifyVisionFailure(new Error('request timed out'))).toBe('TIMEOUT')
    expect(classifyVisionFailure(new Error('401 unauthorized'))).toBe('AUTH_FAILURE')
    expect(classifyVisionFailure(new Error('model INVALID_MODEL'))).toBe('MODEL_UNAVAILABLE')
    expect(classifyVisionFailure(new Error('不支持的图片格式'))).toBe('INVALID_INPUT')
    expect(classifyVisionFailure(new Error('ECONNREFUSED'))).toBe('PROVIDER_UNAVAILABLE')
    const queued = new Error('queue full'); Object.assign(queued, { visionFailureClass: 'QUEUE_CANCELLED' })
    expect(classifyVisionFailure(queued)).toBe('QUEUE_CANCELLED')
    expect(classifyVisionFailure(new Error('something else'))).toBe('UNKNOWN')
  })

  it('VisionQueue：同 key 串行（顺序保持）、异 key 并行、队列满 QUEUE_CANCELLED、记录可观测', async () => {
    const records: Array<Record<string, unknown>> = []
    const queue = new VisionQueue({ maxQueueSize: 2, observer: r => records.push({ ...r }) })
    const order: string[] = []
    const p1 = queue.run('vision-http', async () => { await sleep(60); order.push('a1'); return 1 })
    const p2 = queue.run('vision-http', async () => { order.push('a2'); return 2 })
    const p3 = queue.run('other-provider', async () => { order.push('b1'); return 3 })
    const [r1, r2, r3] = await Promise.all([p1, p2, p3])
    expect(r1).toBe(1); expect(r2).toBe(2); expect(r3).toBe(3)
    expect(order.indexOf('a2')).toBeGreaterThan(order.indexOf('a1'))
    expect(records.length).toBe(3)
    expect(records.every(r => r.ok === true)).toBe(true)
    // 队列满：占住 2 个位置后第 3 个同 key 任务被分类拒绝
    const full = new VisionQueue({ maxQueueSize: 2 })
    const slow = full.run('vision-http', async () => { await sleep(200); return 1 })
    await sleep(10)
    const second = full.run('vision-http', async () => { await sleep(200); return 2 })
    await sleep(10)
    await expect(full.run('vision-http', async () => 3)).rejects.toMatchObject({ visionFailureClass: 'QUEUE_CANCELLED' })
    await Promise.all([slow, second])
  })

  it('缓存键含 provider/model/analysisVersion；v2 与 v1 不相容（版本即失效）', async () => {
    const home = join(tmpdir(), 'dsh-skin-q5-' + Date.now())
    const roots = resolveSkinRoots(home)
    for (const dir of [roots.installed, roots.generated, roots.downloaded, roots.staging, roots.cache]) mkdirSync(dir, { recursive: true })
    const repository = new SkinRepository(nodeFs(), roots, undefined)
    await repository.hydrate()
    const brain: GeneratorBrain = {
      ...fixtureBrain(),
      visionTarget: () => ({ provider: 'vision-http', model: 'ovh/Qwen2.5-VL-72B-Instruct' }),
    }
    const normalize = async (inputPath: string, outPath: string) => ({ original: { width: 16, height: 16 }, processed: { width: 16, height: 16 }, pixelBudget: 4000000, downscaled: false, path: inputPath, outPath })
    const env = { fs: nodeFs(), workspaceRoot: join(roots.cache, 'generation'), brain, repository, normalizeForVision: normalize as never, screenshot: async (_h: string, out: string) => { await nodeFs().writeFile(out, TINY_PNG); return 'fp' }, renderReference: async (_i: string, out: string) => { await nodeFs().writeFile(out, TINY_PNG) } }
    const first = await generateSkin(env, { imageBytes: new Uint8Array([9, 9, 9]), name: 'Cache Key', id: 'ck1', maxIterations: 1 })
    expect(first.ok, first.ok ? '' : first.issues.join('；')).toBe(true)
    const runId = first.ok ? first.runId : ''
    const cacheLog1 = JSON.parse(await nodeFs().readText(join(env.workspaceRoot, runId, 'cache-log.json')))
    expect(cacheLog1.entries[0].cacheHit).toBe(false)
    expect(cacheLog1.entries[0].cacheKey).toMatch(/^[0-9a-f]{16}-[0-9a-f]{12}$/)
    const second = await generateSkin(env, { imageBytes: new Uint8Array([9, 9, 9]), name: 'Cache Key 2', id: 'ck2', maxIterations: 1 })
    expect(second.ok).toBe(true)
    const runId2 = second.ok ? second.runId : ''
    const cacheLog2 = JSON.parse(await nodeFs().readText(join(env.workspaceRoot, runId2, 'cache-log.json')))
    expect(cacheLog2.entries[0].cacheHit).toBe(true)
    rmSync(home, { recursive: true, force: true })
  })

  it('无重复 retry：视觉抛 429 时 analyzeImage 只被调用一次，失败带 RATE_LIMITED 分类且仓库不变', async () => {
    const home = join(tmpdir(), 'dsh-skin-q5b-' + Date.now())
    const roots = resolveSkinRoots(home)
    for (const dir of [roots.installed, roots.generated, roots.downloaded, roots.staging, roots.cache]) mkdirSync(dir, { recursive: true })
    const repository = new SkinRepository(nodeFs(), roots, undefined)
    await repository.hydrate()
    let calls = 0
    const brain: GeneratorBrain = {
      visionAvailable: () => true,
      visionTarget: () => ({ provider: 'vision-http', model: 'm' }),
      analyzeImage: async () => { calls += 1; throw new Error('429 API rate limit exceeded') },
      designSpec: async () => { throw new Error('不应到达') },
    }
    const env = { fs: nodeFs(), workspaceRoot: join(roots.cache, 'generation'), brain, repository, normalizeForVision: async (inputPath: string) => ({ original: { width: 1, height: 1 }, processed: { width: 1, height: 1 }, pixelBudget: 4000000, downscaled: false, path: inputPath }) as never }
    const result = await generateSkin(env, { imageBytes: new Uint8Array([1]), name: 'Rate', maxIterations: 1 })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.failureDomain).toBe('VISION')
      expect(result.failureClass).toBe('RATE_LIMITED')
      expect(result.issues.join('；')).toContain('RATE_LIMITED')
    }
    expect(calls).toBe(1)
    expect(readdirSync(roots.installed)).toEqual([])
    rmSync(home, { recursive: true, force: true })
  })
})

