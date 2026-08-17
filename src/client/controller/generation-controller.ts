/**
 * AIGenerationController：AI Skin Lifecycle 编排面（v1.5）。
 * 负责 generation 记录/运行/取消/设计编辑/重装（Generation 域）；Skin 域操作仍在 SkinController。
 * UI 只经本面 + SkinController 触达宿主 API；不读 generation 工作区文件、不碰 generator 内部。
 * @module dsh-skin/src/client/controller/generation-controller
 */

export type GenerationStatus = 'QUEUED' | 'ANALYZING' | 'SPEC_GENERATED' | 'BUILDING' | 'RENDERING' | 'REPAIRING' | 'VALIDATING' | 'COMPLETED' | 'FAILED' | 'CANCELLED'

export interface GenerationInfo {
  generationId: string
  skinId: string
  source: 'create' | 'regenerate' | 'design-edit'
  parentGenerationId?: string
  status: GenerationStatus
  stage: GenerationStatus
  failureDomain?: string
  failureMessage?: string
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

export interface GenerationFetchResult {
  ok: boolean
  status: number
  payload: unknown
}

export interface GenerationControllerDeps {
  fetchImpl: (input: string, init?: unknown) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>
}

export class AIGenerationController {
  constructor(private readonly deps: GenerationControllerDeps) {}

  private async postJson(path: string, body: unknown): Promise<GenerationFetchResult> {
    const response = await this.deps.fetchImpl(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    let payload: unknown = {}
    try { payload = await response.json() } catch { payload = {} }
    return { ok: response.ok, status: response.status, payload }
  }

  /** 创建生成任务（QUEUED，不调用模型）；返回 generationId。 */
  async createGeneration(input: { name: string; id?: string; description?: string; tags?: string[]; category?: string; version?: string; imageBase64: string }): Promise<GenerationFetchResult> {
    return await this.postJson('/dsh-skin/api/generations', input)
  }

  /** 运行已创建任务（阻塞至终态；期间可轮询 get / 取消）。 */
  async run(generationId: string): Promise<GenerationFetchResult> {
    return await this.postJson('/dsh-skin/api/generate', { generationId })
  }

  async get(generationId: string): Promise<GenerationInfo | null> {
    const response = await this.deps.fetchImpl('/dsh-skin/api/generations/' + encodeURIComponent(generationId))
    if (!response.ok) return null
    try { return (await response.json()) as GenerationInfo } catch { return null }
  }

  async list(skinId?: string): Promise<GenerationInfo[]> {
    const url = '/dsh-skin/api/generations' + (skinId !== undefined ? '?skinId=' + encodeURIComponent(skinId) : '')
    const response = await this.deps.fetchImpl(url)
    if (!response.ok) return []
    try {
      const payload = (await response.json()) as { generations?: GenerationInfo[] }
      return payload.generations ?? []
    } catch { return [] }
  }

  async cancel(generationId: string): Promise<GenerationFetchResult> {
    return await this.postJson('/dsh-skin/api/generations/' + encodeURIComponent(generationId) + '/cancel', {})
  }

  /** 设计编辑：v1.4 RepairDecision 语义的 Spec Patch → 新 generation → 重建 + 修复环 → replace。 */
  async specEdit(skinId: string, decision: unknown, maxIterations?: number): Promise<GenerationFetchResult> {
    return await this.postJson('/dsh-skin/api/skins/' + encodeURIComponent(skinId) + '/spec-edit', { decision, maxIterations })
  }

  /** 重新安装：仅从最新 COMPLETED 历史 final 包（不调用 Vision/DeepSeek）。 */
  async reinstall(skinId: string): Promise<GenerationFetchResult> {
    return await this.postJson('/dsh-skin/api/skins/' + encodeURIComponent(skinId) + '/reinstall', {})
  }
}
