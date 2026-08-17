/**
 * v1.5 AI Skin Lifecycle：GenerationRecord / GenerationStore（原子索引）/ GenerationService（状态机、取消、并发锁、恢复、版本策略）。
 * 边界（docs/v1.5-ai-lifecycle-audit.md）：
 * - Skin identity = skinId（SkinPackage.id 唯一身份，不造 aiSkinId）；Generation identity = generationId（=runId）。
 * - GenerationState 与 Skin state（Repository+Runtime）分离；AISkin 列表 = 记录按 skinId 派生投影 + registry join。
 * - 时间戳只进工作区元数据（不进 v1.3 确定性包内容）。
 * - 原子性：records.json 整体原子重写（复用 writeFileAtomic，与 registry 同机制）。
 * @module dsh-skin/src/generator/lifecycle
 */

import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import type { FsLike } from '../repository/fs.ts'

export type GenerationStage =
  | 'QUEUED' | 'ANALYZING' | 'SPEC_GENERATED' | 'BUILDING' | 'RENDERING' | 'REPAIRING' | 'VALIDATING'
  | 'COMPLETED' | 'FAILED' | 'CANCELLED'

export const RUNNING_STAGES: ReadonlySet<GenerationStage> = new Set([
  'QUEUED', 'ANALYZING', 'SPEC_GENERATED', 'BUILDING', 'RENDERING', 'REPAIRING', 'VALIDATING',
])

export type LifecycleFailureDomain =
  | 'GENERATION_INPUT' | 'VISION' | 'EVIDENCE' | 'SPEC' | 'SPEC_VALIDATION' | 'REPAIR'
  | 'PACKAGE_BUILD' | 'PACKAGE_VALIDATION' | 'REPOSITORY' | 'INSTALL' | 'EXPORT'
  | 'CANCELLED' | 'RECOVERY' | 'UNKNOWN'

export interface GenerationRecord {
  generationId: string
  skinId: string
  /** 来源：create / regenerate / design-edit（§19 父子链） */
  source: 'create' | 'regenerate' | 'design-edit'
  parentGenerationId?: string
  status: GenerationStage
  stage: GenerationStage
  failureDomain?: string
  failureMessage?: string
  /** sha256(imageBytes).slice(0,16) */
  inputHash: string
  evidenceHash?: string
  specHash?: string
  packageHash?: string
  packageVersion: string
  category?: string
  name: string
  description?: string
  tags: string[]
  startedAt: string
  completedAt?: string
}

export interface GenerationRecordsFile {
  schemaVersion: 1
  records: GenerationRecord[]
}

/** 原子索引存储（load→merge→save；进程内串行）。 */
export class GenerationStore {
  private records: GenerationRecord[] | null = null
  private chain: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly fs: FsLike,
    private readonly indexPath: string,
    private readonly atomicWrite: (path: string, text: string) => Promise<void>,
  ) {}

  private async loadLocked(): Promise<GenerationRecord[]> {
    if (this.records === null) {
      try {
        const parsed = JSON.parse(await this.fs.readText(this.indexPath)) as GenerationRecordsFile
        this.records = parsed.schemaVersion === 1 && Array.isArray(parsed.records) ? parsed.records : []
      } catch {
        this.records = []
      }
    }
    return this.records
  }

  private async saveLocked(records: GenerationRecord[]): Promise<void> {
    this.records = records
    await this.fs.mkdir(dirname(this.indexPath), { recursive: true })
    await this.atomicWrite(this.indexPath, JSON.stringify({ schemaVersion: 1, records }, null, 2))
  }

  /** 串行化：任何并发 upsert/recover 顺序执行（同进程单线程语义）。 */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.chain.then(task, task)
    this.chain = next.catch(() => undefined)
    return next
  }

  list(): Promise<GenerationRecord[]> { return this.enqueue(() => this.loadLocked().then(r => [...r])) }

  get(generationId: string): Promise<GenerationRecord | undefined> {
    return this.enqueue(() => this.loadLocked().then(r => r.find(record => record.generationId === generationId)))
  }

  upsert(record: GenerationRecord): Promise<void> {
    return this.enqueue(async () => {
      const records = await this.loadLocked()
      const index = records.findIndex(r => r.generationId === record.generationId)
      if (index >= 0) records[index] = record
      else records.push(record)
      await this.saveLocked(records)
    })
  }

  /** 启动恢复：RUNNING 态记录 → FAILED/RECOVERY（崩溃对账；不触碰 repository）。 */
  recover(): Promise<GenerationRecord[]> {
    return this.enqueue(async () => {
      const records = await this.loadLocked()
      const stale = records.filter(record => RUNNING_STAGES.has(record.status))
      if (stale.length === 0) return []
      const now = new Date().toISOString()
      for (const record of stale) {
        record.status = 'FAILED'
        record.stage = 'FAILED'
        record.failureDomain = 'RECOVERY'
        record.failureMessage = '生成进程中断（重启对账标记）；上一有效包不受影响'
        record.completedAt = now
      }
      await this.saveLocked(records)
      return stale
    })
  }
}

export function inputHashOf(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 16)
}

export function evidenceHashOf(evidence: unknown): string {
  return createHash('sha256').update(JSON.stringify(evidence)).digest('hex')
}

/** SemVer patch++（0.1.0 → 0.1.1；非法版本保守回退常量 0.1.0）。 */
export function bumpPatchVersion(version: string | undefined): string {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version ?? '')
  if (match === null) return '0.1.0'
  return match[1] + '.' + match[2] + '.' + String(Number(match[3]) + 1)
}

export interface CreateGenerationInput {
  skinId: string
  name: string
  description?: string
  tags?: string[]
  category?: string
  version?: string
  imageBytes?: Uint8Array
  source?: 'create' | 'regenerate' | 'design-edit'
  parentGenerationId?: string
}

export type CreateResult = { ok: true; record: GenerationRecord } | { ok: false; issues: string[]; failureDomain: LifecycleFailureDomain }

const TAG_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/

export class GenerationService {
  /** skinId → AbortController（同 skin 单 active generation 锁） */
  private readonly running = new Map<string, AbortController>()
  private readonly store: GenerationStore
  private counter = 0

  constructor(
    private readonly fs: FsLike,
    readonly workspaceRoot: string,
    store: GenerationStore,
  ) {
    this.store = store
  }

  /** 同 skin 是否已有进行中的 generation（§51 keyed lock）。 */
  isRunning(skinId: string): boolean { return this.runningEntries.has(skinId) }

  activeGenerationId(skinId: string): string | undefined {
    return this.runningEntries.get(skinId)?.generationId
  }

  private readonly runningEntries = new Map<string, { controller: AbortController; generationId: string }>()

  /** 创建生成记录（QUEUED）。不启动任何模型调用。 */
  async create(input: CreateGenerationInput): Promise<CreateResult> {
    const issues: string[] = []
    if (typeof input.skinId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(input.skinId)) issues.push('skinId 非法：' + String(input.skinId))
    if (typeof input.name !== 'string' || input.name.trim().length === 0) issues.push('name 必填非空')
    if (input.name.length > 64) issues.push('name 长度不得超过 64')
    if (input.description !== undefined && input.description.length > 512) issues.push('description 长度不得超过 512')
    if (input.tags !== undefined) {
      if (input.tags.length > 16) issues.push('tags 最多 16 个')
      for (const tag of input.tags) if (typeof tag !== 'string' || !TAG_PATTERN.test(tag)) issues.push('非法 tag：' + String(tag))
    }
    if (input.version !== undefined && !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(input.version)) issues.push('version 必须遵循 SemVer')
    if (input.imageBytes !== undefined && input.imageBytes.length === 0) issues.push('图片为空')
    if (issues.length > 0) return { ok: false, issues, failureDomain: 'GENERATION_INPUT' }
    if (this.isRunning(input.skinId)) {
      return { ok: false, issues: ['该皮肤已有进行中的生成：' + input.skinId + '（同皮肤同一时间只允许一个 active generation）'], failureDomain: 'GENERATION_INPUT' }
    }
    const generationId = 'gen-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + Math.random().toString(36).slice(2, 8)
    const record: GenerationRecord = {
      generationId,
      skinId: input.skinId,
      source: input.source ?? 'create',
      parentGenerationId: input.parentGenerationId,
      status: 'QUEUED',
      stage: 'QUEUED',
      inputHash: input.imageBytes !== undefined ? inputHashOf(input.imageBytes) : '',
      packageVersion: input.version ?? '0.1.0',
      category: input.category,
      name: input.name.trim(),
      description: input.description,
      tags: input.tags ?? [],
      startedAt: new Date().toISOString(),
    }
    await this.store.upsert(record)
    if (input.imageBytes !== undefined) {
      await this.fs.mkdir(join(this.workspaceRoot, 'pending-' + generationId), { recursive: true })
      await this.fs.writeFile(join(this.workspaceRoot, 'pending-' + generationId, 'input.png'), input.imageBytes)
    }
    return { ok: true, record }
  }

  list(skinId?: string): Promise<GenerationRecord[]> {
    return this.store.list().then(records => skinId === undefined ? records : records.filter(record => record.skinId === skinId))
  }

  get(generationId: string): Promise<GenerationRecord | undefined> { return this.store.get(generationId) }

  /** 启动托管：QUEUED → 锁定 skinId；返回 signal 与 runId；调用方负责跑 generateSkin 并在结束时 complete。 */
  async start(generationId: string): Promise<{ ok: true; record: GenerationRecord; signal: AbortSignal } | { ok: false; issues: string[]; failureDomain: LifecycleFailureDomain }> {
    const record = await this.store.get(generationId)
    if (record === undefined) return { ok: false, issues: ['生成记录不存在：' + generationId], failureDomain: 'GENERATION_INPUT' }
    if (record.status !== 'QUEUED') return { ok: false, issues: ['生成记录不可启动（当前状态 ' + record.status + '）'], failureDomain: 'GENERATION_INPUT' }
    if (this.isRunning(record.skinId)) return { ok: false, issues: ['该皮肤已有进行中的生成：' + record.skinId], failureDomain: 'GENERATION_INPUT' }
    const controller = new AbortController()
    this.runningEntries.set(record.skinId, { controller, generationId })
    return { ok: true, record, signal: controller.signal }
  }

  /** 阶段更新（原子 upsert；每阶段可观察）。 */
  async onStage(generationId: string, stage: GenerationStage, partial: Partial<GenerationRecord> = {}): Promise<void> {
    const record = await this.store.get(generationId)
    if (record === undefined) return
    await this.store.upsert({ ...record, ...partial, stage, status: stage })
  }

  /** 结束（COMPLETED/FAILED/CANCELLED）+ 释放锁。 */
  async complete(generationId: string, result: { status: 'COMPLETED' | 'FAILED' | 'CANCELLED'; failureDomain?: string; failureMessage?: string; evidenceHash?: string; specHash?: string; packageHash?: string }): Promise<void> {
    const record = await this.store.get(generationId)
    if (record !== undefined) {
      await this.store.upsert({
        ...record,
        status: result.status,
        stage: result.status,
        failureDomain: result.failureDomain,
        failureMessage: result.failureMessage,
        evidenceHash: result.evidenceHash,
        specHash: result.specHash,
        packageHash: result.packageHash,
        completedAt: new Date().toISOString(),
      })
    }
    if (record !== undefined) this.release(record.skinId)
  }

  private release(skinId: string): void {
    this.runningEntries.delete(skinId)
  }

  /** 取消：abort 信号 + 立即落 CANCELLED（§33：取消 ≠ 删除；上一版包不受影响）。 */
  async cancel(generationId: string): Promise<{ ok: true; record: GenerationRecord } | { ok: false; issues: string[]; failureDomain: LifecycleFailureDomain }> {
    const record = await this.store.get(generationId)
    if (record === undefined) return { ok: false, issues: ['生成记录不存在：' + generationId], failureDomain: 'GENERATION_INPUT' }
    if (!RUNNING_STAGES.has(record.status)) return { ok: false, issues: ['生成不在进行中（当前状态 ' + record.status + '）'], failureDomain: 'GENERATION_INPUT' }
    const entry = this.runningEntries.get(record.skinId)
    if (entry !== undefined && entry.generationId === generationId) {
      // 运行中：abort 信号（管线在检查点收敛为 CANCELLED）
      entry.controller.abort()
    } else if (entry === undefined && record.status === 'QUEUED') {
      // 已排队未启动：直接 CANCELLED（start 将拒绝）
    } else {
      return { ok: false, issues: ['该生成未处于可取消的运行状态'], failureDomain: 'GENERATION_INPUT' }
    }
    const cancelled: GenerationRecord = {
      ...record,
      status: 'CANCELLED',
      stage: 'CANCELLED',
      failureDomain: 'CANCELLED',
      failureMessage: '用户取消',
      completedAt: new Date().toISOString(),
    }
    await this.store.upsert(cancelled)
    this.release(record.skinId)
    return { ok: true, record: cancelled }
  }

  /** 启动对账（宿主启动时调用一次）。 */
  async recover(): Promise<GenerationRecord[]> { return await this.store.recover() }

  /** 未安装（无 registry 条目）且至少一个 COMPLETED 记录 → 可重装；返回最新 COMPLETED 记录。 */
  async latestCompleted(skinId: string): Promise<GenerationRecord | undefined> {
    const records = await this.list(skinId)
    const completed = records.filter(record => record.status === 'COMPLETED')
    completed.sort((a, b) => a.startedAt.localeCompare(b.startedAt))
    return completed[completed.length - 1]
  }

  nextGenerationId(): string {
    this.counter += 1
    return 'gen-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + this.counter.toString(36) + '-' + Math.random().toString(36).slice(2, 5)
  }
}

/** 取消异常（iterate 捕获 → CANCELLED 失败域；不污染其它 failureDomain）。 */
export class GenerationCancelledError extends Error {
  readonly generationFailureDomain: LifecycleFailureDomain = 'CANCELLED'
  constructor() { super('生成已取消') }
}
