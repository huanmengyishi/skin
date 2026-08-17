/**
 * Workshop 远端协议 v1（自定；服务器实现随 Phase 6/发布部署确定）。
 * 网络层只负责 search / metadata / download；安装语义全部复用本地仓库管线。
 * @module dsh-skin/src/workshop/protocol
 */

export interface WorkshopSkinInfo {
  skinId: string
  version: string
  name: string
  author: string
  description: string
  tags: string[]
  category: string
  preview: { light?: string; dark?: string }
  downloadCount: number
  rating: number
  createdAt: string
  updatedAt: string
  harnessCompatibility: string
  skinApiVersion: number
  license: string
  checksum: string
  packageSize: number
}

export interface WorkshopSkinVersion {
  version: string
  checksum: string
  size: number
  createdAt: string
  harnessCompatibility: string
  skinApiVersion: number
}

export type WorkshopListResult = { skins: WorkshopSkinInfo[] }
export type WorkshopVersionsResult = { skinId: string; versions: WorkshopSkinVersion[] }

/** 校验远端元数据（下载前必过：无 checksum 即拒绝——防篡改是协议硬要求）。 */
export function validateWorkshopSkinInfo(value: unknown): { ok: true; info: WorkshopSkinInfo } | { ok: false; issues: string[] } {
  const issues: string[] = []
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ok: false, issues: ['不是对象'] }
  const raw = value as Record<string, unknown>
  const needString = (field: string): void => { if (typeof raw[field] !== 'string' || raw[field] === '') issues.push(field + ' 必须是非空字符串') }
  needString('skinId'); needString('version'); needString('name'); needString('author'); needString('description')
  needString('checksum')
  if (!Array.isArray(raw.tags)) issues.push('tags 必须是数组')
  if (raw.skinApiVersion !== 1) issues.push('skinApiVersion 必须为 1')
  if (typeof raw.packageSize !== 'number' || raw.packageSize < 0) issues.push('packageSize 非法')
  if (issues.length > 0) return { ok: false, issues }
  return {
    ok: true,
    info: {
      skinId: String(raw.skinId), version: String(raw.version), name: String(raw.name), author: String(raw.author),
      description: String(raw.description), tags: raw.tags as string[], category: String(raw.category ?? ''),
      preview: { light: (raw.preview as Record<string, unknown> | undefined)?.light as string | undefined, dark: (raw.preview as Record<string, unknown> | undefined)?.dark as string | undefined },
      downloadCount: Number(raw.downloadCount ?? 0), rating: Number(raw.rating ?? 0),
      createdAt: String(raw.createdAt ?? ''), updatedAt: String(raw.updatedAt ?? ''),
      harnessCompatibility: String(raw.harnessCompatibility ?? ''), skinApiVersion: Number(raw.skinApiVersion),
      license: String(raw.license ?? ''), checksum: String(raw.checksum), packageSize: Number(raw.packageSize),
    },
  }
}

export class WorkshopOfflineError extends Error {}
