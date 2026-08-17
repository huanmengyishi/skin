/**
 * Workshop 客户端：远端 API 的 search / detail / versions / download。
 * fetch 注入以便单测与离线判定；离线时抛 WorkshopOfflineError（UI 显式展示，本地功能不受影响）。
 * @module dsh-skin/src/workshop/client
 */

import { WorkshopOfflineError, validateWorkshopSkinInfo, type WorkshopSkinInfo, type WorkshopSkinVersion, type WorkshopVersionsResult } from './protocol.ts'

export interface FetchLike {
  (input: string, init?: unknown): Promise<{ ok: boolean; status: number; json(): Promise<unknown>; arrayBuffer(): Promise<ArrayBuffer>; text(): Promise<string> }>
}

export class WorkshopClient {
  constructor(
    private readonly endpoint: string,
    private readonly fetchImpl: FetchLike,
  ) {}

  configured(): boolean {
    return this.endpoint.trim().length > 0
  }

  private base(): string {
    const url = this.endpoint.trim().replace(/\/+$/, '')
    if (url.length === 0) throw new WorkshopOfflineError('Workshop 未配置（可在 dsh-skin 配置中设置远端地址）')
    return url
  }

  private async request(path: string, init?: unknown): Promise<{ ok: boolean; status: number; json(): Promise<unknown>; arrayBuffer(): Promise<ArrayBuffer>; text(): Promise<string> }> {
    try {
      return await this.fetchImpl(this.base() + path, init)
    } catch (error) {
      if (error instanceof WorkshopOfflineError) throw error
      throw new WorkshopOfflineError('Workshop 不可达：' + String((error as Error).message))
    }
  }

  private async postJson(path: string, body: Record<string, unknown>): Promise<unknown> {
    const response = await this.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!response.ok) {
      let detail = ''
      try { detail = String((await response.json() as { error?: string }).error ?? '') } catch { detail = '' }
      throw new Error('远端拒绝（HTTP ' + response.status + '）：' + detail)
    }
    return await response.json()
  }

  /** 发布新皮肤。 */
  async publishNew(payload: { packageBase64: string; packageSha256: string; name: string; description: string; tags: string[] }): Promise<{ skinId: string; version: string; checksum: string }> {
    return await this.postJson('/skins', { ...payload }) as Promise<{ skinId: string; version: string; checksum: string }>
  }

  /** 发布已有皮肤的新版本。 */
  async publishVersion(skinId: string, payload: { packageBase64: string; packageSha256: string }): Promise<{ skinId: string; version: string; checksum: string }> {
    return await this.postJson('/skins/' + encodeURIComponent(skinId) + '/versions', { ...payload }) as Promise<{ skinId: string; version: string; checksum: string }>
  }

  /** 举报远端皮肤。 */
  async report(skinId: string, reason: string): Promise<{ ok: boolean }> {
    return await this.postJson('/skins/' + encodeURIComponent(skinId) + '/report', { reason }) as Promise<{ ok: boolean }>
  }

  async list(query: { q?: string; tags?: string[]; sort?: string } = {}): Promise<WorkshopSkinInfo[]> {
    const params = new URLSearchParams()
    if (query.q !== undefined && query.q.length > 0) params.set('q', query.q)
    if (query.tags !== undefined && query.tags.length > 0) params.set('tags', query.tags.join(','))
    if (query.sort !== undefined && query.sort.length > 0) params.set('sort', query.sort)
    const qs = params.toString()
    const response = await this.request('/skins' + (qs.length > 0 ? '?' + qs : ''))
    if (!response.ok) throw new Error('list HTTP ' + response.status)
    const payload = (await response.json()) as { skins?: unknown[] }
    if (!Array.isArray(payload.skins)) throw new Error('远端 list 响应缺 skins 数组')
    const infos: WorkshopSkinInfo[] = []
    for (const item of payload.skins) {
      const check = validateWorkshopSkinInfo(item)
      if (!check.ok) throw new Error('远端元数据非法：' + check.issues.join('；'))
      infos.push(check.info)
    }
    return infos
  }

  async detail(skinId: string): Promise<WorkshopSkinInfo> {
    const response = await this.request('/skins/' + encodeURIComponent(skinId))
    if (!response.ok) throw new Error('detail HTTP ' + response.status)
    const check = validateWorkshopSkinInfo(await response.json())
    if (!check.ok) throw new Error('远端元数据非法：' + check.issues.join('；'))
    return check.info
  }

  async versions(skinId: string): Promise<WorkshopSkinVersion[]> {
    const response = await this.request('/skins/' + encodeURIComponent(skinId) + '/versions')
    if (!response.ok) throw new Error('versions HTTP ' + response.status)
    const payload = (await response.json()) as WorkshopVersionsResult
    if (!Array.isArray(payload.versions)) throw new Error('远端 versions 响应非法')
    for (const version of payload.versions) {
      if (typeof version.version !== 'string' || typeof version.checksum !== 'string' || version.checksum.length === 0) {
        throw new Error('远端版本记录缺 version/checksum')
      }
      if (version.skinApiVersion !== undefined && version.skinApiVersion !== 1) throw new Error('远端版本 skinApiVersion 不兼容')
    }
    return payload.versions
  }

  async download(skinId: string, version?: string): Promise<{ bytes: Uint8Array; expectedChecksum: string }> {
    const versionList = await this.versions(skinId)
    const target = version !== undefined ? versionList.find(v => v.version === version) : versionList[0]
    if (target === undefined) throw new Error('远端没有可用版本（' + skinId + (version !== undefined ? ' @' + version : '') + '）')
    const response = await this.request('/skins/' + encodeURIComponent(skinId) + '/download?version=' + encodeURIComponent(target.version))
    if (!response.ok) throw new Error('download HTTP ' + response.status)
    const buffer = new Uint8Array(await response.arrayBuffer())
    return { bytes: buffer, expectedChecksum: target.checksum }
  }
}
