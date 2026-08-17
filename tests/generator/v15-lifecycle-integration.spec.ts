/**
 * v1.5 集成矩阵（FIXTURE）：create→generate→install；regenerate 成功（版本++/父子链）；
 * failed regenerate 保留旧版；cancel 保留旧版；uninstall→reinstall（无模型调用）；设计编辑；崩溃恢复。
 * 全部使用确定性夹具（fixtureBrain + 截图替身），标注 FIXTURE。
 */
import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { nodeFs } from '../../src/repository/fs.ts'
import { SkinRepository } from '../../src/repository/repository.ts'
import { resolveSkinRoots } from '../../src/repository/store.ts'
import { generateSkin } from '../../src/generator/iterate.ts'
import { fixtureBrain, type GeneratorBrain } from '../../src/generator/vision.ts'
import { GenerationService, GenerationStore, bumpPatchVersion, evidenceHashOf } from '../../src/generator/lifecycle.ts'
import { packageTreeSha256 } from '../../src/generator/package-build.ts'
import { validateSkinDesignSpec } from '../../src/core/spec.ts'
import { applySpecPatch, validateRepairDecision } from '../../src/generator/repair.ts'
import type { FsLike } from '../../src/repository/fs.ts'
import type { SkinDesignSpec } from '../../src/core/spec.ts'

const atomic = (p: string, text: string): Promise<void> => nodeFs().writeFile(p, text)
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

async function flatPng(r: number, g: number, b: number): Promise<Uint8Array> {
  const { PNG } = await import('pngjs') as unknown as { PNG: { new (options: { width: number; height: number }): { data: Buffer }; sync: { write(png: unknown): Buffer } } }
  const canvas = new PNG({ width: 1200, height: 720 })
  for (let i = 0; i < canvas.data.length; i += 4) {
    canvas.data[i] = r; canvas.data[i + 1] = g; canvas.data[i + 2] = b; canvas.data[i + 3] = 255
  }
  return new Uint8Array(PNG.sync.write(canvas))
}

interface Env {
  fs: FsLike
  workspaceRoot: string
  brain: GeneratorBrain
  repository: SkinRepository
  service: GenerationService
  store: GenerationStore
  home: string
  stages: string[]
  screenshotDelayMs: number
  screenshotColors: number[][]
}

async function makeEnv(brain?: GeneratorBrain): Promise<Env> {
  const home = join(tmpdir(), 'dsh-skin-v15-int-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6))
  const roots = resolveSkinRoots(home)
  for (const dir of [roots.installed, roots.generated, roots.downloaded, roots.staging, roots.cache]) mkdirSync(dir, { recursive: true })
  const repository = new SkinRepository(nodeFs(), roots, undefined)
  await repository.hydrate()
  const workspaceRoot = join(roots.cache, 'generation')
  const store = new GenerationStore(nodeFs(), join(workspaceRoot, 'records.json'), atomic)
  const service = new GenerationService(nodeFs(), workspaceRoot, store)
  const stages: string[] = []
  let calls = 0
  return {
    fs: nodeFs(), workspaceRoot, brain: brain ?? fixtureBrain(), repository, service, store, home, stages,
    screenshotDelayMs: 0,
    screenshotColors: [[30, 40, 30], [10, 20, 10]],
  }
}

/** 测试侧管线（镜像 index.ts runGeneration：start→generateSkin→complete + 哈希回填）。 */
async function runPipeline(env: Env, params: { generationId: string; skinId: string; name: string; imageBytes: Uint8Array; initialSpec?: SkinDesignSpec; initialEvidence?: unknown; version?: string; replaceExisting?: boolean; maxIterations?: number; slowRenderMs?: number }): Promise<Awaited<ReturnType<typeof generateSkin>>> {
  const started = await env.service.start(params.generationId)
  if (!started.ok) {
    await env.service.complete(params.generationId, { status: 'FAILED', failureDomain: started.failureDomain, failureMessage: started.issues.join('；') })
    return { ok: false, issues: started.issues, failureDomain: started.failureDomain as never }
  }
  let calls = 0
  const result = await generateSkin(
    {
      fs: env.fs,
      workspaceRoot: env.workspaceRoot,
      brain: env.brain,
      repository: env.repository,
      signal: started.signal,
      onStage: (stage, detail) => { env.stages.push(stage); void env.service.onStage(params.generationId, stage as never, detail).catch(() => undefined) },
      screenshot: async (_htmlPath, outPath) => {
        if (params.slowRenderMs !== undefined) await sleep(params.slowRenderMs)
        const [r, g, b] = env.screenshotColors[Math.min(calls, env.screenshotColors.length - 1)]
        calls += 1
        await nodeFs().writeFile(outPath, await flatPng(r, g, b))
        return 'fp-' + calls
      },
      renderReference: async (_inputPath, outPath) => {
        await nodeFs().writeFile(outPath, await flatPng(10, 20, 10))
      },
    },
    {
      imageBytes: params.imageBytes,
      name: params.name,
      id: params.skinId,
      maxIterations: params.maxIterations ?? 2,
      version: params.version,
      initialSpec: params.initialSpec,
      initialEvidence: params.initialEvidence as never,
      replaceExisting: params.replaceExisting ?? false,
      runId: params.generationId,
    },
  )
  const runDir = join(env.workspaceRoot, params.generationId)
  let evidenceHash: string | undefined
  let specHash: string | undefined
  let packageHash: string | undefined
  try { evidenceHash = evidenceHashOf(JSON.parse(await env.fs.readText(join(runDir, 'evidence.json')))) } catch { /* 无证据面 */ }
  try { specHash = (JSON.parse(await env.fs.readText(join(runDir, 'build-manifest.json'))) as { inputIdentity?: { specSha256?: string } }).inputIdentity?.specSha256 } catch { /* 未达 */ }
  try { packageHash = await packageTreeSha256(env.fs, join(runDir, 'final')) } catch { /* 未封存 */ }
  if (result.ok) await env.service.complete(params.generationId, { status: 'COMPLETED', evidenceHash, specHash, packageHash })
  else await env.service.complete(params.generationId, { status: result.failureDomain === 'CANCELLED' ? 'CANCELLED' : 'FAILED', failureDomain: result.failureDomain, failureMessage: result.issues.join('；'), evidenceHash, specHash })
  return result
}

const imageBytes = new Uint8Array([9, 9, 9, 9, 9])

describe('v1.5 集成（FIXTURE 确定性夹具）', () => {
  it('create → generate → install：记录 COMPLETED + 阶段可观察 + 包落 generated', async () => {
    const env = await makeEnv()
    const created = await env.service.create({ skinId: 'v15-a', name: 'V15 A', tags: ['ai'], imageBytes, source: 'create' })
    if (!created.ok) throw new Error(created.issues.join(';'))
    const result = await runPipeline(env, { generationId: created.record.generationId, skinId: 'v15-a', name: 'V15 A', imageBytes })
    expect(result.ok, result.ok ? '' : result.issues.join('；')).toBe(true)
    const record = await env.service.get(created.record.generationId)
    expect(record?.status).toBe('COMPLETED')
    expect(record?.packageHash?.length).toBe(64)
    expect(record?.specHash?.length).toBe(64)
    expect(record?.evidenceHash?.length).toBe(64)
    expect(env.repository.get('v15-a')?.source).toBe('generated')
    expect(env.stages).toContain('ANALYZING')
    expect(env.stages).toContain('SPEC_GENERATED')
    expect(env.stages).toContain('BUILDING')
    expect(env.stages).toContain('RENDERING')
    expect(env.stages).toContain('VALIDATING')
    rmSync(env.home, { recursive: true, force: true })
  })

  it('regenerate 成功：同 skinId + 版本 patch++ + 新 generationId + parent 链 + 原子 replace', async () => {
    const env = await makeEnv()
    const g1 = await env.service.create({ skinId: 'v15-b', name: 'V15 B', imageBytes, source: 'create', version: '0.1.0' })
    if (!g1.ok) throw new Error(g1.issues.join(';'))
    const first = await runPipeline(env, { generationId: g1.record.generationId, skinId: 'v15-b', name: 'V15 B', imageBytes, version: '0.1.0' })
    expect(first.ok, first.ok ? '' : first.issues.join('；')).toBe(true)
    expect(env.repository.get('v15-b')?.version).toBe('0.1.0')
    const version = bumpPatchVersion('0.1.0')
    const g2 = await env.service.create({ skinId: 'v15-b', name: 'V15 B', imageBytes, source: 'regenerate', version, parentGenerationId: g1.record.generationId })
    if (!g2.ok) throw new Error(g2.issues.join(';'))
    // 复用历史 best spec（读 iteration-0 spec=design-spec.json）+ 历史证据
    const runDir = join(env.workspaceRoot, g1.record.generationId)
    const initialSpec = JSON.parse(await env.fs.readText(join(runDir, 'design-spec.json')))
    const initialEvidence = JSON.parse(await env.fs.readText(join(runDir, 'evidence.json')))
    const second = await runPipeline(env, { generationId: g2.record.generationId, skinId: 'v15-b', name: 'V15 B', imageBytes, initialSpec, initialEvidence, version, replaceExisting: true })
    expect(second.ok, second.ok ? '' : second.issues.join('；')).toBe(true)
    expect(env.repository.get('v15-b')?.version).toBe('0.1.1')
    const record = await env.service.get(g2.record.generationId)
    expect(record?.parentGenerationId).toBe(g1.record.generationId)
    expect((await env.service.list('v15-b')).length).toBe(2)
    rmSync(env.home, { recursive: true, force: true })
  })

  it('failed regenerate：旧版包保持（记录 FAILED + 版本不变）', async () => {
    const env = await makeEnv()
    const g1 = await env.service.create({ skinId: 'v15-c', name: 'V15 C', imageBytes, source: 'create', version: '0.1.0' })
    if (!g1.ok) throw new Error(g1.issues.join(';'))
    const first = await runPipeline(env, { generationId: g1.record.generationId, skinId: 'v15-c', name: 'V15 C', imageBytes, version: '0.1.0' })
    expect(first.ok).toBe(true)
    const g2 = await env.service.create({ skinId: 'v15-c', name: 'V15 C', imageBytes, source: 'regenerate', version: '0.1.1', parentGenerationId: g1.record.generationId })
    if (!g2.ok) throw new Error(g2.issues.join(';'))
    // 非法 initialSpec → 管线 SPEC_VALIDATION 失败（模拟失败重生成）
    const badSpec = { ...JSON.parse(await env.fs.readText(join(env.workspaceRoot, g1.record.generationId, 'design-spec.json'))) as SkinDesignSpec, colorPalette: [{ hex: 'red', role: 'x', share: 9 }] }
    const second = await runPipeline(env, { generationId: g2.record.generationId, skinId: 'v15-c', name: 'V15 C', imageBytes, initialSpec: badSpec, version: '0.1.1', replaceExisting: true })
    expect(second.ok).toBe(false)
    const record = await env.service.get(g2.record.generationId)
    expect(record?.status).toBe('FAILED')
    expect(record?.failureDomain).toBe('SPEC_VALIDATION')
    // §12/§78：旧版仍有效（repository 未动）
    const entry = env.repository.get('v15-c')
    expect(entry?.version).toBe('0.1.0')
    expect(entry?.state).toBe('ok')
    expect(existsSync(join(env.workspaceRoot, g1.record.generationId, 'final', 'manifest.json'))).toBe(true)
    rmSync(env.home, { recursive: true, force: true })
  })

  it('cancel：旧版包保持；记录 CANCELLED', async () => {
    const env = await makeEnv()
    const g1 = await env.service.create({ skinId: 'v15-d', name: 'V15 D', imageBytes, source: 'create', version: '0.1.0' })
    if (!g1.ok) throw new Error(g1.issues.join(';'))
    const first = await runPipeline(env, { generationId: g1.record.generationId, skinId: 'v15-d', name: 'V15 D', imageBytes, version: '0.1.0' })
    expect(first.ok).toBe(true)
    const g2 = await env.service.create({ skinId: 'v15-d', name: 'V15 D', imageBytes, source: 'regenerate', version: '0.1.1', parentGenerationId: g1.record.generationId })
    if (!g2.ok) throw new Error(g2.issues.join(';'))
    // 运行中途取消（渲染替身阻塞 800ms；150ms 后取消；start 由 runPipeline 内部执行）
    const pipeline = runPipeline(env, { generationId: g2.record.generationId, skinId: 'v15-d', name: 'V15 D', imageBytes, initialSpec: JSON.parse(await env.fs.readText(join(env.workspaceRoot, g1.record.generationId, 'design-spec.json'))), version: '0.1.1', replaceExisting: true, slowRenderMs: 800 })
    void pipeline
    await sleep(150)
    const cancelled = await env.service.cancel(g2.record.generationId)
    expect(cancelled.ok, cancelled.ok ? '' : cancelled.issues.join('；')).toBe(true)
    await pipeline.catch(() => undefined)
    await sleep(400)
    const record = await env.service.get(g2.record.generationId)
    expect(record?.status).toBe('CANCELLED')
    // 旧版保持
    expect(env.repository.get('v15-d')?.version).toBe('0.1.0')
    rmSync(env.home, { recursive: true, force: true })
  })

  it('uninstall → reinstall：仅包生命周期（不调用 Vision/DeepSeek），final 包重建可安装', async () => {
    const env = await makeEnv()
    const g1 = await env.service.create({ skinId: 'v15-e', name: 'V15 E', imageBytes, source: 'create', version: '0.1.0' })
    if (!g1.ok) throw new Error(g1.issues.join(';'))
    const first = await runPipeline(env, { generationId: g1.record.generationId, skinId: 'v15-e', name: 'V15 E', imageBytes, version: '0.1.0' })
    expect(first.ok).toBe(true)
    expect(env.repository.get('v15-e')).toBeDefined()
    // uninstall：repository.remove；generation workspace 保留
    expect((await env.repository.remove('v15-e')).ok).toBe(true)
    expect(env.repository.get('v15-e')).toBeUndefined()
    expect(existsSync(join(env.workspaceRoot, g1.record.generationId, 'final', 'manifest.json'))).toBe(true)
    // reinstall：latestCompleted.final → repository.install（无模型调用）
    const latest = await env.service.latestCompleted('v15-e')
    expect(latest?.generationId).toBe(g1.record.generationId)
    const reinstall = await env.repository.install(join(env.workspaceRoot, latest!.generationId, 'final'), { kind: 'generated' })
    expect(reinstall.ok).toBe(true)
    expect(env.repository.get('v15-e')?.version).toBe('0.1.0')
    expect(env.stages.filter(s => s === 'ANALYZING').length).toBe(1) // 重装未触发任何生成阶段
    rmSync(env.home, { recursive: true, force: true })
  })

  it('设计编辑：Spec Patch → 新 generation（design-edit/parent）→ 版本++ → replace', async () => {
    const env = await makeEnv()
    const g1 = await env.service.create({ skinId: 'v15-f', name: 'V15 F', imageBytes, source: 'create', version: '0.1.0' })
    if (!g1.ok) throw new Error(g1.issues.join(';'))
    const first = await runPipeline(env, { generationId: g1.record.generationId, skinId: 'v15-f', name: 'V15 F', imageBytes, version: '0.1.0' })
    expect(first.ok).toBe(true)
    const currentSpec = JSON.parse(await env.fs.readText(join(env.workspaceRoot, g1.record.generationId, 'design-spec.json')))
    const decision = { targetRegions: ['global'], problemAssessment: '设计编辑：视觉风格更新', specChanges: [{ path: 'visualStyle', newValue: 'design-edited-style', reason: '用户设计编辑', targetRegion: 'global', expectedEffect: '更新风格描述' }] }
    const validated = validateRepairDecision(decision, { worstRegionIds: [], maxChangedFields: 4 })
    expect(validated.ok).toBe(true)
    if (!validated.ok) throw new Error(validated.issues.join(';'))
    const patched = applySpecPatch(currentSpec as SkinDesignSpec, validated.decision)
    expect(patched.ok).toBe(true)
    if (!patched.ok) throw new Error(patched.issues.join(';'))
    expect(validateSkinDesignSpec(patched.spec).ok).toBe(true)
    const g2 = await env.service.create({ skinId: 'v15-f', name: 'V15 F', imageBytes, source: 'design-edit', version: '0.1.1', parentGenerationId: g1.record.generationId })
    if (!g2.ok) throw new Error(g2.issues.join(';'))
    const initialEvidence = JSON.parse(await env.fs.readText(join(env.workspaceRoot, g1.record.generationId, 'evidence.json')))
    const second = await runPipeline(env, { generationId: g2.record.generationId, skinId: 'v15-f', name: 'V15 F', imageBytes, initialSpec: patched.spec, initialEvidence, version: '0.1.1', replaceExisting: true })
    expect(second.ok, second.ok ? '' : second.issues.join('；')).toBe(true)
    expect(env.repository.get('v15-f')?.version).toBe('0.1.1')
    const record = await env.service.get(g2.record.generationId)
    expect(record?.source).toBe('design-edit')
    expect(record?.parentGenerationId).toBe(g1.record.generationId)
    rmSync(env.home, { recursive: true, force: true })
  })

  it('崩溃恢复：运行中断 → recover 标记 FAILED/RECOVERY；repository 不受影响', async () => {
    const env = await makeEnv()
    const g1 = await env.service.create({ skinId: 'v15-g', name: 'V15 G', imageBytes, source: 'create', version: '0.1.0' })
    if (!g1.ok) throw new Error(g1.issues.join(';'))
    const first = await runPipeline(env, { generationId: g1.record.generationId, skinId: 'v15-g', name: 'V15 G', imageBytes, version: '0.1.0' })
    expect(first.ok).toBe(true)
    const g2 = await env.service.create({ skinId: 'v15-g', name: 'V15 G', imageBytes, source: 'regenerate', version: '0.1.1', parentGenerationId: g1.record.generationId })
    if (!g2.ok) throw new Error(g2.issues.join(';'))
    await env.service.start(g2.record.generationId)
    await env.service.onStage(g2.record.generationId, 'BUILDING')
    // 模拟进程重启：同一 store 上执行 recover（等价于重启后的对账）
    const stale = await env.service.recover()
    expect(stale.some(record => record.generationId === g2.record.generationId)).toBe(true)
    const record = await env.service.get(g2.record.generationId)
    expect(record?.status).toBe('FAILED')
    expect(record?.failureDomain).toBe('RECOVERY')
    // §66/§77：旧版仍有效
    expect(env.repository.get('v15-g')?.version).toBe('0.1.0')
    rmSync(env.home, { recursive: true, force: true })
  })
})
