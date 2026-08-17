/**
 * v1.4 生成编排：Image → Evidence → Spec → Package → Render → Fidelity → Diagnose → Re-observe → RepairDecision → Spec Patch → Rebuild 循环。
 * - 诊断（WorstRegion/metricDelta）= Evidence；修复（RepairDecision）= Design Decision（docs/v1.4-render-repair-audit.md）。
 * - 每轮经 v1.3 确定性 builder 重建；状态机 IMPROVED/UNCHANGED/REGRESSED/CONVERGED/OSCILLATION/MAX_ITERATIONS/FAILED
 *   （停止策略唯一规范：docs/v1.4-repair-policy.md）。
 * - maxIterations = repair 轮数上限（默认 3）；总渲染 ≤ maxIterations + 1。
 * - 任何失败：上一轮有效 Spec/Package 保持；最终门只安装"最后非退化"包。
 * @module dsh-skin/src/generator/iterate
 */

import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { slugifySkinId, validateSkinDesignSpec, type SkinDesignSpec } from '../core/spec.ts'
import { cssStylesheetIssues } from '../core/css-strings.ts'
import { cssFromSpec, tokensFromSpec } from './codegen.ts'
import { buildSkinPackage, DEFAULT_BUILD_CONFIG, PACKAGE_BUILDER_VERSION, packageTreeSha256, sealPackage, validateBuiltPackage, type BuildConfig } from './package-build.ts'
import { computePixelDiff, type DiffReport } from './diff.ts'
import { decodePngRgba, quantizeTop, computeFidelityReport, type FidelityMetrics, type FidelityReport } from './fidelity.ts'
import { buildPreviewHtml } from './render.ts'
import { screenshotHtml, renderImageToPng } from './screenshot.ts'
import { VisionQueue, type VisionQueueRecord } from './vision-queue.ts'
import { normalizeImageForVision, DEFAULT_PIXEL_BUDGET } from './downscale.ts'
import { classifyVisionFailure } from './failure.ts'
import { buildSpecProvenance, checkEvidenceConsistency } from './provenance.ts'
import { buildWorstRegions, computeMetricDelta, cropPng, regionEvidenceFromObservation, type MetricDelta, type RegionEvidence, type WorstRegion } from './diagnosis.ts'
import { applySpecPatch, OscillationGuard, specSha256, validateRepairDecision, type AppliedChange, type RepairDecision } from './repair.ts'
import { GenerationCancelledError } from './lifecycle.ts'
import { type GeneratorBrain, type RepairInput, type VisionEvidence } from './vision.ts'
import type { FsLike } from '../repository/fs.ts'
import type { SkinRepository } from '../repository/repository.ts'

export interface GenerateInput {
  /** 参考图字节 */
  imageBytes: Uint8Array
  /** 展示名（必填） */
  name: string
  /** 可选 id 建议（缺省 slugify(name)，冲突由仓库拒绝） */
  id?: string
  author?: string
  description?: string
  tags?: string[]
  /** repair 轮数上限（默认 3；总渲染 ≤ maxIterations + 1） */
  maxIterations?: number
  /** Package version（SemVer；缺省稳定常量 0.1.0——确定性策略，禁止时间戳版本） */
  version?: string
  /** 预置设计规格（重新生成：跳过视觉分析与首轮 spec 生成） */
  initialSpec?: SkinDesignSpec
  /** 覆盖同 id 的 generated 皮肤（重新生成语义，带回滚） */
  replaceExisting?: boolean
  /** v1.5：托管生成的工作区目录名（generationId；缺省由编排生成） */
  runId?: string
  /** v1.5：预置视觉证据（重新生成/设计编辑时复用历史证据，跳过视觉分析但保留证据面） */
  initialEvidence?: VisionEvidence
}

export type IterationStatus = 'INITIAL' | 'IMPROVED' | 'UNCHANGED' | 'REGRESSED' | 'CONVERGED' | 'OSCILLATION' | 'MAX_ITERATIONS' | 'FAILED'

export interface IterationRecord {
  index: number
  status: IterationStatus
  spec: SkinDesignSpec
  inputSpecHash: string
  outputSpecHash: string
  packageHash: string
  packageDir: string
  screenshotPath: string
  previewPath: string
  diff: DiffReport | null
  diffRatio: number
  converged: boolean
  fingerprint: string
  fingerprintChanged: boolean
  fidelity: FidelityMetrics | null
  worstRegionIds: string[]
  repairDecision: RepairDecision | null
  specPatch: AppliedChange[] | null
  metricDelta: MetricDelta | null
}

/** v1.4 修复策略（阈值语义见 docs/v1.4-repair-policy.md；可经 GenerationEnv.repairPolicy 覆盖）。 */
export interface RepairPolicy {
  maxChangedFieldsPerIteration: number
  noRepairGate: { pixel: number; region: number; palette: number; layout: number }
  meaningful: { palette: number; region: number; pixel: number; layout: number }
  regression: { region: number; layout: number; palette: number; pixel: number }
  maxRepairAttempts: number
  visionCropScale: number
}

export const DEFAULT_REPAIR_POLICY: RepairPolicy = {
  maxChangedFieldsPerIteration: 4,
  noRepairGate: { pixel: 0.02, region: 12, palette: 0.8, layout: 0.9 },
  meaningful: { palette: 0.05, region: 5, pixel: 0.01, layout: 0.05 },
  regression: { region: 10, layout: 0.05, palette: 0.1, pixel: 0.05 },
  maxRepairAttempts: 2,
  visionCropScale: 3,
}

export type FailureDomain = 'VISION' | 'EVIDENCE_NORMALIZATION' | 'EVIDENCE_VALIDATION' | 'SPEC' | 'SPEC_VALIDATION' | 'PROVENANCE' | 'CODEGEN' | 'CODEGEN_OUTPUT' | 'CSS_VALIDATION' | 'MANIFEST_BUILD' | 'ASSET_BUILD' | 'PACKAGE_BUILD' | 'PACKAGE_VALIDATION' | 'INTEGRITY' | 'RENDER' | 'FIDELITY' | 'REGION_DIAGNOSIS' | 'VISION_RECHECK' | 'REPAIR_DECISION' | 'SPEC_PATCH' | 'CANCELLED' | 'REPOSITORY' | 'UNKNOWN'

export interface RequestStats {
  visionCalls: number
  visionCacheHits: number
  deepseekCalls: number
  repairRounds: number
  durationMs: number
}

export type GenerationResult =
  | { ok: true; runId: string; skinId: string; iterations: IterationRecord[]; finalDiffRatio: number; reportPath: string; loopStatus: string; requestStats: RequestStats }
  | { ok: false; issues: string[]; failureDomain?: FailureDomain; failureClass?: string }

export interface GenerationEnv {
  fs: FsLike
  /** 生成工作区根（$DSH_HOME/skins/cache/generation） */
  workspaceRoot: string
  brain: GeneratorBrain
  repository: SkinRepository
  /** 默认 3 */
  defaultMaxIterations?: number
  /** v1.4 修复策略（缺省 DEFAULT_REPAIR_POLICY） */
  repairPolicy?: RepairPolicy
  /** 截图注入点（测试替身；缺省走无头浏览器）；返回渲染样式指纹 */
  screenshot?: (htmlPath: string, outPath: string) => Promise<string>
  /** 参考图归一化注入点（测试替身；缺省走无头浏览器 canvas，Q1/Q2 用） */
  renderReference?: (inputPath: string, outPath: string, width: number, height: number) => Promise<void>
  /** 视觉输入降采样注入点（测试替身；缺省走 normalizeImageForVision，Q5） */
  normalizeForVision?: (inputPath: string, outPath: string, budget?: number) => ReturnType<typeof normalizeImageForVision>
  /** 视觉队列注入点（测试替身；缺省按 provider 串行 + 上限 4，Q5） */
  visionQueue?: VisionQueue
  /** v1.5：取消信号（阶段检查点之间生效）；abort 后 generateSkin 以 CANCELLED 失败域结束 */
  signal?: AbortSignal
  /** v1.5：生命周期阶段回调（生成进度可观察；QUEUED/COMPLETED 由 GenerationService 维护） */
  onStage?: (stage: 'ANALYZING' | 'SPEC_GENERATED' | 'BUILDING' | 'RENDERING' | 'REPAIRING' | 'VALIDATING', detail?: Record<string, unknown>) => void
}

const CONVERGENCE_THRESHOLD = 0.02

function nowTag(): string {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

function checkAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw new GenerationCancelledError()
}

/** 用 pngjs 解码 PNG → RGBA（纯 JS，Windows 稳定）。 */
import { readFileSync } from 'node:fs'

interface PngModule {
  PNG: { sync: { read(buffer: Buffer): { width: number; height: number; data: Buffer } } }
}

async function decodePng(path: string): Promise<{ width: number; height: number; data: Uint8Array }> {
  const module = await import('pngjs') as unknown as PngModule
  const png = module.PNG.sync.read(readFileSync(path))
  return { width: png.width, height: png.height, data: new Uint8Array(png.data) }
}

async function resizePng(path: string, width: number, height: number): Promise<{ width: number; height: number; data: Uint8Array }> {
  const source = await decodePng(path)
  const out = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    const sy = Math.min(source.height - 1, Math.floor((y * source.height) / height))
    for (let x = 0; x < width; x++) {
      const sx = Math.min(source.width - 1, Math.floor((x * source.width) / width))
      const srcOffset = (sy * source.width + sx) * 4
      const dstOffset = (y * width + x) * 4
      out[dstOffset] = source.data[srcOffset]
      out[dstOffset + 1] = source.data[srcOffset + 1]
      out[dstOffset + 2] = source.data[srcOffset + 2]
      out[dstOffset + 3] = source.data[srcOffset + 3]
    }
  }
  return { width, height, data: out }
}

/** 每轮渲染的元数据（截图来源可回答：什么包/什么 viewport/什么环境）。 */
export interface RenderResult {
  screenshotPath: string
  viewport: { width: number; height: number }
  crop: string
  environment: { renderer: string; headless: boolean; browser: string }
  packageHash: string
  runtimeStatus: 'ok'
  fingerprint: string
  warnings: string[]
  artifacts: string[]
}

function noRepairSatisfied(metrics: FidelityMetrics, policy: RepairPolicy): boolean {
  return metrics.pixel.diffRatio <= policy.noRepairGate.pixel
    && metrics.region.meanDelta <= policy.noRepairGate.region
    && metrics.palette.intersection >= policy.noRepairGate.palette
    && metrics.layout.cosine >= policy.noRepairGate.layout
    && metrics.structure.nonBlank
}

function isRegressed(delta: MetricDelta, policy: RepairPolicy): boolean {
  return delta.regionMeanDelta > policy.regression.region
    || delta.layoutCosine < -policy.regression.layout
    || delta.paletteIntersection < -policy.regression.palette
    || delta.pixelDiffRatio > policy.regression.pixel
    || delta.structureNonBlank === 'true->false'
}

function isMeaningful(delta: MetricDelta, policy: RepairPolicy): boolean {
  return delta.paletteIntersection >= policy.meaningful.palette
    || delta.regionMeanDelta <= -policy.meaningful.region
    || delta.pixelDiffRatio <= -policy.meaningful.pixel
    || delta.layoutCosine >= policy.meaningful.layout
}

const EMPTY_EVIDENCE: VisionEvidence = { summary: '', layout: [], entities: [], colors: [], text: '', colorSource: 'none' }

export async function generateSkin(env: GenerationEnv, input: GenerateInput): Promise<GenerationResult> {
  const startedAt = Date.now()
  const issues: string[] = []
  const maxIterations = Math.max(1, Math.min(8, input.maxIterations ?? env.defaultMaxIterations ?? 3))
  const policy = env.repairPolicy ?? DEFAULT_REPAIR_POLICY
  const runId = input.runId ?? 'gen-' + nowTag() + '-' + Math.random().toString(36).slice(2, 8)
  const runDir = join(env.workspaceRoot, runId)
  const skinId = slugifySkinId(input.id ?? input.name)
  const naming = {
    id: skinId,
    name: input.name.trim(),
    author: input.author?.trim() || 'dsh-skin',
    description: input.description?.trim() || input.name.trim(),
    tags: input.tags ?? [],
  }
  // v1.3 确定性构建：BuildConfig 显式化（不读 env/cwd/时间）；evidenceRef 只进 build-manifest。
  const buildConfig: BuildConfig = {
    packageVersion: input.version ?? DEFAULT_BUILD_CONFIG.packageVersion,
    generatorVersion: PACKAGE_BUILDER_VERSION,
    previewMode: 'svg',
  }
  let evidenceRef: { imageKey?: string; provider?: string; model?: string; analysisVersion?: string } | undefined
  const requestStats: RequestStats = { visionCalls: 0, visionCacheHits: 0, deepseekCalls: 0, repairRounds: 0, durationMs: 0 }

  try {
    await env.fs.mkdir(runDir, { recursive: true })
    await env.fs.writeFile(join(runDir, 'input.png'), input.imageBytes)
    let spec: SkinDesignSpec
    let evidence: VisionEvidence | undefined
    if (input.initialSpec !== undefined) {
      // 重新生成/设计编辑：复用既有设计规格（视觉分析可跳过；无视觉依赖也不阻断）
      const specCheck = validateSkinDesignSpec(input.initialSpec)
      if (!specCheck.ok) return { ok: false, issues: ['既有设计规格校验失败：' + specCheck.issues.join('；')], failureDomain: 'SPEC_VALIDATION' }
      spec = specCheck.spec
      await env.fs.writeFile(join(runDir, 'design-spec.json'), JSON.stringify(spec, null, 2))
      // v1.5：历史证据复用（证据面保留给修复决策/记录；不重跑视觉分析）
      if (input.initialEvidence !== undefined) {
        evidence = input.initialEvidence
        await env.fs.writeFile(join(runDir, 'evidence.json'), JSON.stringify({ ...evidence, meta: evidenceRef ?? {} }, null, 2))
        await env.fs.writeFile(join(runDir, 'colors.json'), JSON.stringify({ colors: evidence.colors, colorSource: evidence.colorSource ?? 'vision' }, null, 2))
      }
    } else {
      if (!env.brain.visionAvailable()) {
        return { ok: false, issues: ['视觉依赖不可用：未检测到 dsh-vision-router（vision-http 路由）。请安装启用 dsh-vision-router 后重试。'], failureDomain: 'VISION' }
      }
      // Q2 缓存：同图（sha256）+ analysisVersion 复用视觉证据；provider/model 变化经 version 失效
      env.onStage?.('ANALYZING')
      checkAborted(env.signal)
      const visionCacheDir = join(dirname(env.workspaceRoot), 'vision-cache')
      const imageKey = createHash('sha256').update(input.imageBytes).digest('hex').slice(0, 16)
      const target = env.brain.visionTarget?.()
      const provider = target?.provider ?? 'none'
      const model = target?.model ?? 'none'
      // Q5 缓存键：影响分析结果的因素全部入键（不含任何凭据）；analysisVersion 变更自动失效旧缓存。
      const cacheKey = imageKey + '-' + createHash('sha256').update(provider + ':' + model + ':v2').digest('hex').slice(0, 12)
      const cachePath = join(visionCacheDir, cacheKey + '.json')
      let cacheHit = false
      let cacheError: string | null = null
      let cachedEvidence: VisionEvidence | null = null
      try {
        const cached = JSON.parse(await env.fs.readText(cachePath)) as { evidence?: VisionEvidence } | VisionEvidence
        const unwrapped = ('evidence' in cached && cached.evidence !== undefined) ? cached.evidence : cached
        cachedEvidence = unwrapped as VisionEvidence
      } catch {
        cachedEvidence = null
      }
      let evidence: VisionEvidence
      if (cachedEvidence !== null) {
        evidence = cachedEvidence
        cacheHit = true
        requestStats.visionCacheHits += 1
      } else if (target !== undefined) {
        try {
          // Q5 像素预算：超预算先降采样再送 Vision（不无条件缩小正常图片）
          const normalize = env.normalizeForVision ?? normalizeImageForVision
          const downscale = await normalize(join(runDir, 'input.png'), join(runDir, 'vision-normalized.png'), DEFAULT_PIXEL_BUDGET)
          await env.fs.writeFile(join(runDir, 'downscale-log.json'), JSON.stringify({ imageKey, provider, model, ...downscale }, null, 2))
          // Q5 队列：同 provider 串行、有界、可观测；不做 provider retry（vision-router 职责）
          const queueRecords: VisionQueueRecord[] = []
          const queue = env.visionQueue ?? new VisionQueue({ maxQueueSize: 4, observer: record => { queueRecords.push(record) } })
          try {
            requestStats.visionCalls += 1
            evidence = await queue.run(provider, async () => env.brain.analyzeImage(downscale.path))
          } finally {
            if (queueRecords.length > 0) await env.fs.writeFile(join(runDir, 'queue-log.json'), JSON.stringify({ entries: queueRecords }, null, 2))
          }
        } catch (error) {
          const failureClass = classifyVisionFailure(error)
          return { ok: false, issues: ['视觉观察失败（' + failureClass + '）：' + String((error as Error).message)], failureDomain: 'VISION', failureClass }
        }
        try {
          await env.fs.mkdir(visionCacheDir, { recursive: true })
          await env.fs.writeFile(cachePath, JSON.stringify({ provider, model, analysisVersion: 'v2', imageKey, evidence }, null, 2))
        } catch { cacheError = '缓存写失败（CACHE_ERROR 类，仅记录不阻断）' }
      } else {
        try {
          requestStats.visionCalls += 1
          evidence = await env.brain.analyzeImage(join(runDir, 'input.png'))
        } catch (error) {
          const failureClass = classifyVisionFailure(error)
          return { ok: false, issues: ['视觉观察失败（' + failureClass + '）：' + String((error as Error).message)], failureDomain: 'VISION', failureClass }
        }
        try {
          await env.fs.mkdir(visionCacheDir, { recursive: true })
          await env.fs.writeFile(cachePath, JSON.stringify({ provider, model, analysisVersion: 'v2', imageKey, evidence }, null, 2))
        } catch { cacheError = '缓存写失败（CACHE_ERROR 类，仅记录不阻断）' }
      }
      await env.fs.writeFile(join(runDir, 'cache-log.json'), JSON.stringify({ entries: [{ imageKey, cacheKey, cacheHit, provider, model, analysisVersion: 'v2', cacheError }] }, null, 2))
      // Q2 可追踪：原始视觉响应落盘
      await env.fs.writeFile(join(runDir, 'vision-raw.json'), JSON.stringify({ raw: (evidence as { raw?: string }).raw ?? '', source: evidence.source ?? null }, null, 2))
      // Q2 颜色兜底：模型无合法颜色时用本地确定性量化（非空、可验证、可复现）
      if ((evidence.colors ?? []).length === 0) {
        try {
          const refPng = join(runDir, 'reference.png')
          const renderReference = env.renderReference ?? renderImageToPng
          await renderReference(join(runDir, 'input.png'), refPng, 1200, 720)
          const refRgba = await decodePngRgba(refPng)
          evidence = { ...evidence, colors: quantizeTop(refRgba, 8), colorSource: 'local-quantization' }
        } catch (error) {
          return { ok: false, issues: ['颜色提取失败：' + String((error as Error).message)], failureDomain: 'RENDER' }
        }
      }
      await env.fs.writeFile(join(runDir, 'analysis.json'), JSON.stringify(evidence, null, 2))
      const evidenceWithMeta = { ...evidence, meta: { imageKey, provider, model, analysisVersion: 'v2', cacheHit, at: nowTag() } }
      await env.fs.writeFile(join(runDir, 'evidence.json'), JSON.stringify(evidenceWithMeta, null, 2))
      evidenceRef = { imageKey, provider, model, analysisVersion: 'v2' }
      await env.fs.writeFile(join(runDir, 'colors.json'), JSON.stringify({ colors: evidence.colors, colorSource: evidence.colorSource ?? 'vision' }, null, 2))
      await env.fs.writeFile(join(runDir, 'design-prompt.txt'), String((env.brain as { promptRecords?: { system: string } }).promptRecords?.system ?? '') + '\n\n' + JSON.stringify({ evidence, hints: { name: naming.name, description: naming.description } }, null, 2))
      const writeRaw = async () => {
        const rawText = (env.brain as { promptRecords?: { raw?: string } }).promptRecords?.raw ?? ''
        if (rawText.length > 0) await env.fs.writeFile(join(runDir, 'design-raw.txt'), rawText)
      }
      try {
        requestStats.deepseekCalls += 1
        spec = await env.brain.designSpec(evidence, { name: naming.name, description: naming.description })
      } catch (error) {
        await writeRaw()
        return { ok: false, issues: ['设计规格生成失败：' + String((error as Error).message)], failureDomain: 'SPEC' }
      }
      await writeRaw()
      const specCheck = validateSkinDesignSpec(spec)
      if (!specCheck.ok) return { ok: false, issues: ['设计规格校验失败：' + specCheck.issues.join('；')], failureDomain: 'SPEC_VALIDATION' }
      spec = specCheck.spec
      // v1.2：provenance 构建 + 证据一致性检查（分层三：schema/字段语义已过，此处为证据一致性）
      try {
        const interpretation = (env.brain as { lastInterpretation?: () => string[] }).lastInterpretation?.() ?? []
        const provenance = buildSpecProvenance(spec, evidence, { imageKey, provider, model, analysisVersion: 'v2' })
        const consistency = checkEvidenceConsistency(spec, evidence)
        if (interpretation.length === 0) {
          provenance.interpretation = consistency.issues.length > 0
            ? ['模型未提供 interpretation；一致性检查记录：' + consistency.issues.map(i => i.severity + ':' + i.message).join('；')]
            : ['模型未提供 interpretation；一致性检查无偏离']
        } else {
          provenance.interpretation = interpretation
        }
        spec = { ...spec, provenance }
        await env.fs.writeFile(join(runDir, 'provenance.json'), JSON.stringify(provenance, null, 2))
        await env.fs.writeFile(join(runDir, 'validation.json'), JSON.stringify({ specSchema: 'PASS', fieldSemantics: 'PASS', evidenceConsistency: consistency }, null, 2))
      } catch (error) {
        return { ok: false, issues: ['provenance 构建失败：' + String((error as Error).message)], failureDomain: 'PROVENANCE' }
      }
      await env.fs.writeFile(join(runDir, 'design-spec.json'), JSON.stringify(spec, null, 2))
    }

    env.onStage?.('SPEC_GENERATED', { specSha256: specSha256(spec) })
    checkAborted(env.signal)
    const iterations: IterationRecord[] = []
    const fidelityReports: FidelityReport[] = []
    const regionEvidenceCache = new Map<string, RegionEvidence>()
    const oscillationGuard = new OscillationGuard([spec])
    let currentSpec = spec
    let previousScreenshot: string | null = null
    let previousFingerprint: string | null = null
    let previousFidelityMetrics: FidelityMetrics | null = null
    let lastPatch: { decision: RepairDecision; patch: AppliedChange[] } | null = null
    let loopStatus = 'RUNNING'
    let stopReason = ''
    let finalDiffRatio = 1
    let bestIterationIndex = 0

    for (let round = 0; round <= maxIterations; round++) {
      const index = round
      const iterationDir = join(runDir, 'iteration-' + index)
      const packageDir = join(iterationDir, 'skin')
      env.onStage?.('BUILDING', { iteration: index })
      checkAborted(env.signal)
      // 1. v1.3 确定性构建（每轮同 builder；PACKAGE_BUILD/CSS_VALIDATION）
      const build = await buildSkinPackage(env.fs, packageDir, currentSpec, naming, buildConfig, evidenceRef)
      if (!build.ok) {
        return { ok: false, issues: ['包构建失败（' + build.failureDomain + '）：' + build.issues.join('；')], failureDomain: build.failureDomain }
      }
      const cssText = await env.fs.readText(join(packageDir, 'styles', 'theme.css'))
      const cssIssues = cssStylesheetIssues(cssText)
      if (cssIssues.length > 0) {
        return { ok: false, issues: ['代码生成输出校验失败：' + cssIssues.map(i => i.kind + ':' + i.message).join('；')], failureDomain: 'CSS_VALIDATION' }
      }
      let packageHash = ''
      try {
        packageHash = await packageTreeSha256(env.fs, packageDir)
      } catch (error) {
        return { ok: false, issues: ['包哈希计算失败：' + String((error as Error).message)], failureDomain: 'PACKAGE_BUILD' }
      }
      // 2. Render：真实包内容 + 预览壳 + 真实浏览器（RENDER）
      const previewPath = join(iterationDir, 'preview.html')
      await env.fs.writeFile(previewPath, buildPreviewHtml({
        id: skinId,
        name: naming.name,
        tokens: tokensFromSpec(currentSpec),
        css: cssFromSpec(currentSpec, skinId),
        clientJs: 'window.__ModuleLoader__.load({ id: "dsh-skin/' + skinId + '", factory: function () { return { apply: function () {} }; } });',
      }))
      env.onStage?.('RENDERING', { iteration: index })
      checkAborted(env.signal)
      const screenshotPath = join(iterationDir, 'screenshot.png')
      const takeScreenshot = env.screenshot ?? ((htmlPath: string, outPath: string) => screenshotHtml(htmlPath, outPath, 1200, 720))
      let fingerprint: string
      try {
        fingerprint = await takeScreenshot(previewPath, screenshotPath)
      } catch (error) {
        return { ok: false, issues: ['渲染截图失败：' + String((error as Error).message)], failureDomain: 'RENDER' }
      }
      const renderResult: RenderResult = {
        screenshotPath,
        viewport: { width: 1200, height: 720 },
        crop: 'none（参考侧 cover+center 归一；两图同坐标系）',
        environment: { renderer: 'screenshotHtml（puppeteer-core + Edge/Chrome 发现）', headless: true, browser: 'Edge/Chrome（平台发现）' },
        packageHash,
        runtimeStatus: 'ok',
        fingerprint,
        warnings: [],
        artifacts: ['preview.html', 'screenshot.png'],
      }
      await env.fs.writeFile(join(iterationDir, 'render.json'), JSON.stringify(renderResult, null, 2))
      // 3. Fidelity（Q1 evaluator 原样复用；FIDELITY）
      let fidelityReport: FidelityReport
      try {
        const refPath = join(runDir, 'reference.png')
        const renderReference = env.renderReference ?? renderImageToPng
        if (!existsSync(refPath)) await renderReference(join(runDir, 'input.png'), refPath, 1200, 720)
        const refRgba = await decodePngRgba(refPath)
        const shotRgba = await decodePngRgba(screenshotPath)
        const iterationDiff = previousScreenshot === null ? null : (await (async () => { const original = await decodePng(previousScreenshot as string); const rebuilt = await resizePng(screenshotPath, original.width, original.height); return computePixelDiff(original, rebuilt).diffRatio })())
        fidelityReport = computeFidelityReport({
          reference: refRgba,
          screenshot: shotRgba,
          referencePath: 'reference.png',
          screenshotPath: 'iteration-' + index + '/screenshot.png',
          iterationDiffRatio: iterationDiff,
          fingerprintChanged: previousFingerprint === null ? null : previousFingerprint !== fingerprint,
          converged: previousFingerprint === null ? null : iterationDiff !== null && iterationDiff <= CONVERGENCE_THRESHOLD && previousFingerprint === fingerprint,
          previousFidelity: previousFidelityMetrics,
        })
        await env.fs.writeFile(join(iterationDir, 'fidelity.json'), JSON.stringify(fidelityReport, null, 2))
      } catch (error) {
        return { ok: false, issues: ['保真度计算失败：' + String((error as Error).message)], failureDomain: 'FIDELITY' }
      }
      // 4. 诊断：最差区域 + 页面区域映射 + 候选字段 + 裁剪件（REGION_DIAGNOSIS）
      let worstRegions: WorstRegion[] = []
      try {
        const refRgba = await decodePngRgba(join(runDir, 'reference.png'))
        const shotRgba = await decodePngRgba(screenshotPath)
        const diagnosis = buildWorstRegions(refRgba, shotRgba, fidelityReport.metrics)
        worstRegions = diagnosis.regions
        for (const region of worstRegions.slice(0, 1)) {
          const refCropPath = join(iterationDir, 'region-' + region.id + '-reference.png')
          const genCropPath = join(iterationDir, 'region-' + region.id + '-generated.png')
          try {
            await cropPng(join(runDir, 'reference.png'), region.bbox, refCropPath, policy.visionCropScale)
            region.referenceCropPath = refCropPath
          } catch (cropError) {
            renderResult.warnings.push('参考裁剪失败：' + String((cropError as Error).message))
          }
          try {
            await cropPng(screenshotPath, region.bbox, genCropPath, policy.visionCropScale)
            region.generatedCropPath = genCropPath
          } catch (cropError) {
            renderResult.warnings.push('截图裁剪失败：' + String((cropError as Error).message))
          }
        }
        await env.fs.writeFile(join(iterationDir, 'worst-regions.json'), JSON.stringify({ regions: worstRegions.map(r => ({ ...r, referenceCropPath: undefined, generatedCropPath: undefined })), diagnosisIssues: diagnosis.issues }, null, 2))
      } catch (error) {
        return { ok: false, issues: ['区域诊断失败：' + String((error as Error).message)], failureDomain: 'REGION_DIAGNOSIS' }
      }
      // 5. 稳定性辅指标
      let diff: DiffReport | null = null
      if (previousScreenshot !== null) {
        const original = await decodePng(previousScreenshot)
        const rebuilt = await resizePng(screenshotPath, original.width, original.height)
        diff = computePixelDiff(original, rebuilt)
        finalDiffRatio = diff.diffRatio
      }
      const fingerprintChanged = previousFingerprint !== null && previousFingerprint !== fingerprint
      const converged = diff !== null && diff.diffRatio <= CONVERGENCE_THRESHOLD && !fingerprintChanged
      // 6. 状态判定（round>0）与停止
      let status: IterationStatus = 'INITIAL'
      let metricDelta: MetricDelta | null = null
      if (round > 0 && previousFidelityMetrics !== null) {
        metricDelta = computeMetricDelta(previousFidelityMetrics, fidelityReport.metrics)
        await env.fs.writeFile(join(iterationDir, 'metric-delta.json'), JSON.stringify(metricDelta, null, 2))
        if (isRegressed(metricDelta, policy)) {
          status = 'REGRESSED'
          bestIterationIndex = index - 1
        } else if (isMeaningful(metricDelta, policy) && converged) {
          status = 'CONVERGED'
          bestIterationIndex = index
        } else if (isMeaningful(metricDelta, policy)) {
          status = 'IMPROVED'
          bestIterationIndex = index
        } else {
          status = 'UNCHANGED'
          bestIterationIndex = index - 1
        }
      }
      const iteration: IterationRecord = {
        index,
        status,
        spec: currentSpec,
        inputSpecHash: specSha256(currentSpec),
        outputSpecHash: specSha256(currentSpec),
        packageHash,
        packageDir,
        screenshotPath,
        previewPath,
        diff,
        diffRatio: diff?.diffRatio ?? 1,
        converged,
        fingerprint,
        fingerprintChanged,
        fidelity: fidelityReport.metrics,
        worstRegionIds: worstRegions.map(region => region.id),
        repairDecision: round > 0 && lastPatch !== null ? lastPatch.decision : null,
        specPatch: round > 0 && lastPatch !== null ? lastPatch.patch : null,
        metricDelta,
      }
      iterations.push(iteration)
      fidelityReports.push(fidelityReport)
      // 关键顺序：delta 必须先于基线更新（否则 prev==next 全零）
      previousFidelityMetrics = fidelityReport.metrics
      lastPatch = null
      previousScreenshot = screenshotPath
      previousFingerprint = fingerprint
      // 停止判定
      if (round === 0) {
        if (noRepairSatisfied(fidelityReport.metrics, policy)) {
          status = 'CONVERGED'
          iteration.status = 'CONVERGED'
          loopStatus = 'CONVERGED'
          stopReason = 'NO_REPAIR_NEEDED'
          bestIterationIndex = 0
          break
        }
      } else {
        if (status === 'REGRESSED' || status === 'UNCHANGED') {
          loopStatus = status
          stopReason = status === 'REGRESSED' ? 'MULTI_OBJECTIVE_REGRESSION' : 'NO_IMPROVEMENT'
          break
        }
        if (status === 'CONVERGED') {
          loopStatus = 'CONVERGED'
          stopReason = 'IMPROVED_AND_STABLE'
          break
        }
        if (round >= maxIterations) {
          loopStatus = 'MAX_ITERATIONS'
          stopReason = 'REPAIR_BUDGET_EXHAUSTED'
          iteration.status = 'MAX_ITERATIONS'
          break
        }
      }
      if (round >= maxIterations) {
        loopStatus = 'MAX_ITERATIONS'
        stopReason = 'REPAIR_BUDGET_EXHAUSTED'
        break
      }
      // ---- Repair Round（round < maxIterations）----
      requestStats.repairRounds += 1
      env.onStage?.('REPAIRING', { round })
      checkAborted(env.signal)
      const repairRoundDir = iterationDir
      // 7. Vision 二次观察（top worst region；同 run 内同 region 复用；429 → VISION_RECHECK 安全停止）
      const topRegion = worstRegions[0]
      let regionEvidence: RegionEvidence[] = []
      if (topRegion !== undefined) {
        const cachedRegion = regionEvidenceCache.get(topRegion.id)
        if (cachedRegion !== undefined) {
          regionEvidence = [cachedRegion]
        } else if (env.brain.reobserveRegion !== undefined && env.brain.visionAvailable() && topRegion.referenceCropPath !== undefined) {
          const provider = env.brain.visionTarget?.().provider ?? 'none'
          const queueRecords: VisionQueueRecord[] = []
          const queue = env.visionQueue ?? new VisionQueue({ maxQueueSize: 4, observer: record => { queueRecords.push(record) } })
          try {
            requestStats.visionCalls += 1
            const observation = await queue.run(provider, async () => env.brain.reobserveRegion?.(topRegion.referenceCropPath as string, topRegion.id) ?? EMPTY_EVIDENCE)
            const normalized = regionEvidenceFromObservation(observation, { id: topRegion.id, bbox: topRegion.bbox }, evidenceRef ?? {}, false)
            regionEvidenceCache.set(topRegion.id, normalized)
            regionEvidence = [normalized]
          } catch (error) {
            const message = String((error as Error).message)
            if (/attachments/.test(message)) {
              // 重新生成路径（attachments 未挂载）：降级为无区域观察（全局证据仍可用），不视为失败
              regionEvidence = [regionEvidenceFromObservation(EMPTY_EVIDENCE, { id: topRegion.id, bbox: topRegion.bbox }, evidenceRef ?? {}, true)]
            } else {
              const failureClass = classifyVisionFailure(error)
              await env.fs.writeFile(join(repairRoundDir, 'region-evidence.json'), JSON.stringify({ regions: [], degraded: true, error: failureClass + '：' + message }, null, 2))
              loopStatus = 'FAILED'
              stopReason = 'VISION_RECHECK'
              break
            }
          } finally {
            if (queueRecords.length > 0) await env.fs.writeFile(join(runDir, 'queue-log.json'), JSON.stringify({ entries: queueRecords }, null, 2))
          }
        } else {
          regionEvidence = []
        }
      }
      if (loopStatus === 'FAILED') break
      await env.fs.writeFile(join(repairRoundDir, 'region-evidence.json'), JSON.stringify({ regions: regionEvidence }, null, 2))
      // 8. Repair Decision（REPAIR_DECISION；maxRepairAttempts 内允许单次重问）
      const baseEvidence = evidence ?? EMPTY_EVIDENCE
      let decision: RepairDecision | null = null
      for (let attempt = 1; attempt <= policy.maxRepairAttempts; attempt++) {
        try {
          if (env.brain.repairDecision === undefined) throw new Error('修复决策能力未挂载（brain.repairDecision）')
          requestStats.deepseekCalls += 1
          const raw = await env.brain.repairDecision({
            spec: currentSpec,
            evidence: baseEvidence,
            metrics: fidelityReport.metrics,
            worstRegions,
            regionEvidence,
          } satisfies RepairInput)
          const validated = validateRepairDecision(raw, { worstRegionIds: worstRegions.map(region => region.id), maxChangedFields: policy.maxChangedFieldsPerIteration })
          if (validated.ok) {
            decision = validated.decision
            break
          }
          await env.fs.writeFile(join(repairRoundDir, 'repair-decision-attempt-' + attempt + '.json'), JSON.stringify({ raw, issues: validated.issues }, null, 2))
        } catch (error) {
          await env.fs.writeFile(join(repairRoundDir, 'repair-decision-attempt-' + attempt + '.json'), JSON.stringify({ error: String((error as Error).message) }, null, 2))
        }
      }
      if (decision === null) {
        loopStatus = 'FAILED'
        stopReason = 'REPAIR_DECISION'
        break
      }
      await env.fs.writeFile(join(repairRoundDir, 'repair-decision.json'), JSON.stringify(decision, null, 2))
      await env.fs.writeFile(join(runDir, 'repair-prompt-' + round + '.txt'), String((env.brain as { promptRecords?: { repair: string; repairRaw: string } }).promptRecords?.repair ?? ''))
      // 9. Spec Patch（SPEC_PATCH）+ Spec 校验 + 振荡检测
      const patched = applySpecPatch(currentSpec, decision)
      if (!patched.ok) {
        await env.fs.writeFile(join(repairRoundDir, 'spec-patch.json'), JSON.stringify({ ok: false, issues: patched.issues }, null, 2))
        loopStatus = 'FAILED'
        stopReason = 'SPEC_PATCH'
        break
      }
      const specCheck = validateSkinDesignSpec(patched.spec)
      if (!specCheck.ok) {
        await env.fs.writeFile(join(repairRoundDir, 'spec-patch.json'), JSON.stringify({ ok: false, issues: ['patch 后 spec 校验失败：' + specCheck.issues.join('；')] }, null, 2))
        loopStatus = 'FAILED'
        stopReason = 'SPEC_VALIDATION'
        break
      }
      if (!oscillationGuard.add(specCheck.spec)) {
        await env.fs.writeFile(join(repairRoundDir, 'spec-patch.json'), JSON.stringify({ ok: true, oscillationDetected: true, changes: patched.changes }, null, 2))
        loopStatus = 'OSCILLATION'
        stopReason = 'SEEN_SPEC_HASH'
        break
      }
      await env.fs.writeFile(join(repairRoundDir, 'spec-patch.json'), JSON.stringify({ ok: true, oscillationDetected: false, changes: patched.changes }, null, 2))
      lastPatch = { decision, patch: patched.changes }
      currentSpec = specCheck.spec
      await env.fs.writeFile(join(runDir, 'design-spec-iteration-' + (round + 1) + '.json'), JSON.stringify(currentSpec, null, 2))
    }

    // v1.3 最终门：最佳（最后非退化）Spec → 确定性构建 → 校验 → 封存 → 安装（Phase 3 管线）
    env.onStage?.('VALIDATING')
    checkAborted(env.signal)
    const bestIteration = iterations[Math.max(0, bestIterationIndex)] ?? iterations[iterations.length - 1]
    const finalDir = join(runDir, 'final')
    const finalBuild = await buildSkinPackage(env.fs, finalDir, bestIteration.spec, naming, buildConfig, evidenceRef)
    if (!finalBuild.ok) {
      return { ok: false, issues: ['最终包构建失败（' + finalBuild.failureDomain + '）：' + finalBuild.issues.join('；')], failureDomain: finalBuild.failureDomain }
    }
    await env.fs.writeFile(join(runDir, 'build-config.json'), JSON.stringify(buildConfig, null, 2))
    await env.fs.writeFile(join(runDir, 'build-manifest.json'), JSON.stringify(finalBuild.buildManifest, null, 2))
    const validation = await validateBuiltPackage(env.fs, finalDir)
    await env.fs.writeFile(join(runDir, 'package-validation.json'), JSON.stringify(validation.ok ? { ok: true, files: validation.files } : { ok: false, issues: validation.issues }, null, 2))
    if (!validation.ok) {
      return { ok: false, issues: ['最终包校验失败：' + validation.issues.map(i => i.path + ' ' + i.message).join('；')], failureDomain: 'PACKAGE_VALIDATION' }
    }
    const sealed = await sealPackage(env.fs, finalDir)
    if (!sealed.ok) {
      return { ok: false, issues: ['最终包完整性生成失败：' + sealed.issues.join('；')], failureDomain: 'INTEGRITY' }
    }
    if (bestIteration.fidelity !== null) {
      const bestFidelity = fidelityReports[bestIteration.index]
      if (bestFidelity !== undefined) await env.fs.writeFile(join(runDir, 'fidelity.json'), JSON.stringify(bestFidelity, null, 2))
    }
    if (!existsSync(bestIteration.screenshotPath)) {
      return { ok: false, issues: ['截图产物缺失'], failureDomain: 'RENDER' }
    }

    // 安装进仓库 generated 根（staging→atomic，失败不落半成品）；重新生成 = 覆盖安装（带回滚）
    const installed = input.replaceExisting === true
      ? await env.repository.replace(finalDir, { kind: 'generated' })
      : await env.repository.install(finalDir, { kind: 'generated' })
    if (!installed.ok) {
      return { ok: false, issues: ['安装失败：' + installed.issues.join('；')] }
    }

    requestStats.durationMs = Date.now() - startedAt
    const report = {
      runId,
      skinId,
      input: naming,
      iterations: iterations.map(iteration => ({
        index: iteration.index,
        status: iteration.status,
        inputSpecHash: iteration.inputSpecHash,
        outputSpecHash: iteration.outputSpecHash,
        packageHash: iteration.packageHash,
        stability: { diffRatio: iteration.diffRatio, converged: iteration.converged },
        worstRegions: iteration.worstRegionIds.slice(0, 3),
        repairDecision: iteration.repairDecision !== null ? { targetRegions: iteration.repairDecision.targetRegions, specChanges: iteration.repairDecision.specChanges.map(c => ({ path: c.path, reason: c.reason, targetRegion: c.targetRegion, expectedEffect: c.expectedEffect })) } : null,
        metricDelta: iteration.metricDelta,
        screenshot: iteration.screenshotPath,
      })),
      fidelity: bestIteration.fidelity,
      finalDiffRatio,
      loopStatus,
      stopReason,
      bestIteration: bestIteration.index,
      requestStats,
      artifacts: {
        worstRegions: 'iteration-N/worst-regions.json',
        regionEvidence: 'iteration-N/region-evidence.json',
        repairDecision: 'iteration-N/repair-decision.json',
        specPatch: 'iteration-N/spec-patch.json',
        metricDelta: 'iteration-N/metric-delta.json',
        render: 'iteration-N/render.json',
      },
    }
    const reportPath = join(runDir, 'report.json')
    await env.fs.writeFile(reportPath, JSON.stringify(report, null, 2))
    return { ok: true, runId, skinId, iterations, finalDiffRatio, reportPath, loopStatus, requestStats }
  } catch (error) {
    if (error instanceof GenerationCancelledError) {
      return { ok: false, issues: ['生成已取消'], failureDomain: 'CANCELLED', failureClass: 'CANCELLED' }
    }
    return { ok: false, issues: ['生成失败：' + String((error as Error).message)], failureDomain: 'UNKNOWN' }
  }
}
