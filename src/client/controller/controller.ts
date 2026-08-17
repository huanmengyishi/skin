/**
 * SkinController：Skin Center 的唯一上层编排入口（Phase 1 冻结契约的 Phase 4 落地）。
 * UI 只经本面触达 Repository（经宿主 API）与 Runtime；本层不拼 CSS、不碰 DOM、不直接操作 bundle，
 * 不实现 precedence 与 lifecycle（编排而非实现）。
 * @module dsh-skin/src/client/controller/controller
 */

import type { RuntimeSnapshot, SkinInfo, SkinListInfo, SkinRuntime, TryOnHandle } from '../runtime/runtime.ts'
import { classifySkinError } from '../../core/errors.ts'

export interface WorkshopRemoteSkin {
  skinId: string
  version: string
  name: string
  author: string
  description: string
  tags: string[]
  downloadCount: number
  rating: number
}

export interface ControllerFetchResult {
  ok: boolean
  status: number
  payload: unknown
}

export interface ControllerDeps {
  runtime: SkinRuntime
  api: { list(): Promise<SkinListInfo[]>; get(id: string): Promise<SkinInfo> }
  fetchImpl: (input: string, init?: unknown) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>
}

/** SkinController：编排面（runtime 生命周期 + repository 元数据 + host 操作 + 错误面）。 */
export class SkinController {
  constructor(private readonly deps: ControllerDeps) {}

  private get runtime(): SkinRuntime { return this.deps.runtime }

  private async request(path: string, init: { method: string; body?: string }): Promise<ControllerFetchResult> {
    const response = await this.deps.fetchImpl(path, { method: init.method, headers: { 'Content-Type': 'application/json' }, body: init.body })
    let payload: unknown = {}
    try { payload = await response.json() } catch { payload = {} }
    return { ok: response.ok, status: response.status, payload }
  }

  private async postJson(path: string, body: unknown): Promise<ControllerFetchResult> {
    return await this.request(path, { method: 'POST', body: JSON.stringify(body) })
  }

  // ---- 编排面（Runtime 生命周期唯一入口；UI 不得直连 runtime） ----
  getSnapshot(): RuntimeSnapshot { return this.runtime.getSnapshot() }
  subscribe(listener: () => void): () => void { return this.runtime.subscribe(listener) }
  /** 刷新列表快照（= runtime.listSkins）。 */
  async list(): Promise<void> { await this.runtime.listSkins() }
  /** 应用（UI Apply 语义 = 切换；无当前皮肤时即首次应用）。 */
  async apply(id: string): Promise<void> { await this.runtime.switchSkin(id) }
  async switch(id: string): Promise<void> { await this.runtime.switchSkin(id) }
  async restore(): Promise<void> { await this.runtime.restoreDefault() }
  async enter(id: string): Promise<TryOnHandle> { return await this.runtime.tryOn(id) }
  async exit(): Promise<void> { await this.runtime.exitTryOn() }
  async removeSkin(id: string): Promise<void> { await this.runtime.removeSkin(id) }

  // ---- 仓库元数据面（宿主 API 传输；仓库内部实现不可见） ----
  listSkins(): Promise<SkinListInfo[]> { return this.deps.api.list() }
  getSkin(id: string): Promise<SkinInfo> { return this.deps.api.get(id) }

  // ---- host 操作面 ----
  exportUrl(id: string): string { return '/dsh-skin/api/skins/' + encodeURIComponent(id) + '/export' }

  async saveMeta(id: string, meta: { name: string; author: string; description: string; tags: string[] }): Promise<ControllerFetchResult> {
    return await this.postJson('/dsh-skin/api/skins/' + encodeURIComponent(id) + '/meta', meta)
  }

  async generate(input: { imageBase64: string; name: string; description: string; tags: string[] }): Promise<ControllerFetchResult> {
    return await this.postJson('/dsh-skin/api/generate', input)
  }

  async regenerate(skinId: string): Promise<ControllerFetchResult> {
    return await this.postJson('/dsh-skin/api/regenerate', { skinId })
  }

  async browseWorkshop(query: string): Promise<ControllerFetchResult> {
    const response = await this.deps.fetchImpl('/dsh-skin/api/workshop/skins?q=' + encodeURIComponent(query))
    let payload: unknown = {}
    try { payload = await response.json() } catch { payload = {} }
    return { ok: response.ok, status: response.status, payload }
  }

  async workshopAction(action: 'download' | 'update', skinId: string): Promise<ControllerFetchResult> {
    return await this.postJson('/dsh-skin/api/workshop/' + action, { skinId })
  }

  async publish(skinId: string, mode: 'new' | 'version'): Promise<ControllerFetchResult> {
    return await this.postJson('/dsh-skin/api/workshop/' + (mode === 'new' ? 'publish' : 'publish-version'), { skinId })
  }

  async report(skinId: string): Promise<ControllerFetchResult> {
    return await this.postJson('/dsh-skin/api/workshop/report', { skinId, reason: '不适当内容（用户举报）' })
  }

  // ---- 错误面（UI 只需要用户可读文本） ----
  describeError(error: unknown): string {
    const skinError = classifySkinError(error)
    if (skinError !== null) return skinError.message
    if (error instanceof Error) return error.message
    return String(error)
  }
}

