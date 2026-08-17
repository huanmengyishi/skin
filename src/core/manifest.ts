/**
 * SkinManifest：Skin Package 的元数据契约（Phase 1 最小职责 = 描述"这是什么 Skin"）。
 * 只有本文件列出的字段被 v0.1.0 核心 Runtime 依赖；未知字段一律放行，
 * 留给后续阶段（dependencies / license / source / compatibility 等）。
 * @module dsh-skin/src/core/manifest
 */

export interface SkinManifestPreview {
  /** 亮色预览图（包内相对路径） */
  light?: string
  /** 暗色预览图（包内相对路径） */
  dark?: string
}

export interface SkinManifest {
  /** 机器可读唯一 ID（小写字母/数字/连字符，禁保留字） */
  id: string
  /** SemVer 字符串 */
  version: string
  /** 展示名 */
  name: string
  /** 作者/来源标识 */
  author: string
  /** 一句话以上的描述 */
  description: string
  /** 标签（用于 Phase 2 的过滤） */
  tags: string[]
  /** Skin API 版本，当前唯一合法值 = 1 */
  skinApiVersion: number
  /** 预览图（包内相对路径） */
  preview: SkinManifestPreview
}

export interface ManifestIssue {
  path: string
  message: string
}

export type ManifestResult =
  | { ok: true; manifest: SkinManifest }
  | { ok: false; issues: ManifestIssue[] }

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const TAG_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/

/** Skin API 版本：本插件实现并维护，与宿主版本、包版本三线分治。 */
export const SKIN_API_VERSION = 1

/** 保留 ID：路径/概念冲突与宿主内置语义，一律拒绝。 */
export const RESERVED_SKIN_IDS: ReadonlySet<string> = new Set([
  'dsh-skin', 'official', 'default', 'harness', 'system', 'theme', 'skin',
  'builtin', 'local', 'none', 'null', 'undefined', 'true', 'false',
])

/** 是否为合法 Skin ID（含保留字检查）。 */
export function isValidSkinId(id: string): boolean {
  return ID_PATTERN.test(id) && !RESERVED_SKIN_IDS.has(id)
}

/**
 * 校验包内相对路径（preview/文件引用通用规则）：
 * 拒绝绝对路径、盘符、协议 URL、反斜杠与 '..' 穿越。
 */
export function isValidRelativePath(value: string): boolean {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) return false
  if (value.includes('\\') || value.includes('..')) return false
  if (value.startsWith('/') || value.startsWith('\\\\')) return false
  if (/^[a-zA-Z]:/.test(value)) return false
  if (/^[a-z][a-z0-9+.-]*:/.test(value)) return false
  return true
}

/** 校验一个未知 JSON 值是否为合法 SkinManifest；返回全部问题而非首错即停。 */
export function validateManifest(value: unknown): ManifestResult {
  const issues: ManifestIssue[] = []
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, issues: [{ path: '$', message: 'manifest 必须是 JSON 对象' }] }
  }
  const raw = value as Record<string, unknown>

  const id = raw.id
  if (typeof id !== 'string') issues.push({ path: '$.id', message: '必须是字符串' })
  else if (!ID_PATTERN.test(id)) issues.push({ path: '$.id', message: '必须匹配 /^[a-z0-9][a-z0-9-]{0,63}$/' })
  else if (RESERVED_SKIN_IDS.has(id)) issues.push({ path: '$.id', message: '是保留 ID' })

  const version = raw.version
  if (typeof version !== 'string') issues.push({ path: '$.version', message: '必须是字符串' })
  else if (!VERSION_PATTERN.test(version)) issues.push({ path: '$.version', message: '必须遵循 SemVer（x.y.z[-prerelease]）' })

  const name = raw.name
  if (typeof name !== 'string' || name.trim().length === 0) issues.push({ path: '$.name', message: '必须是非空字符串' })
  else if (name.length > 64) issues.push({ path: '$.name', message: '长度不得超过 64' })

  const author = raw.author
  if (typeof author !== 'string' || author.trim().length === 0) issues.push({ path: '$.author', message: '必须是非空字符串' })

  const description = raw.description
  if (typeof description !== 'string' || description.length === 0) issues.push({ path: '$.description', message: '必须是非空字符串' })
  else if (description.length > 512) issues.push({ path: '$.description', message: '长度不得超过 512' })

  const tags = raw.tags
  if (!Array.isArray(tags)) issues.push({ path: '$.tags', message: '必须是字符串数组' })
  else {
    if (tags.length > 16) issues.push({ path: '$.tags', message: '最多 16 个标签' })
    tags.forEach((tag, index) => {
      if (typeof tag !== 'string' || !TAG_PATTERN.test(tag)) {
        issues.push({ path: '$.tags[' + index + ']', message: '必须是 /^[a-z0-9][a-z0-9-]{0,31}$/ 字符串' })
      }
    })
  }

  const skinApiVersion = raw.skinApiVersion
  if (skinApiVersion !== SKIN_API_VERSION) {
    issues.push({ path: '$.skinApiVersion', message: '必须是 ' + SKIN_API_VERSION + '（当前宿主实现的 Skin API 版本）' })
  }

  const preview = raw.preview
  if (preview !== undefined) {
    if (typeof preview !== 'object' || preview === null || Array.isArray(preview)) {
      issues.push({ path: '$.preview', message: '必须是 { light?, dark? } 对象' })
    } else {
      const pv = preview as Record<string, unknown>
      for (const key of ['light', 'dark'] as const) {
        const v = pv[key]
        if (v !== undefined && (typeof v !== 'string' || !isValidRelativePath(v))) {
          issues.push({ path: '$.preview.' + key, message: '必须是包内相对路径（禁绝对路径/协议/.. 穿越）' })
        }
      }
    }
  }

  if (issues.length > 0) return { ok: false, issues }
  return {
    ok: true,
    manifest: {
      id: id as string,
      version: version as string,
      name: (name as string).trim(),
      author: author as string,
      description: description as string,
      tags: [...(tags as string[])],
      skinApiVersion: skinApiVersion as number,
      preview: {
        light: (preview as SkinManifestPreview | undefined)?.light,
        dark: (preview as SkinManifestPreview | undefined)?.dark,
      },
    },
  }
}
