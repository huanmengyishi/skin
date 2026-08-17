/**
 * SkinError 分类学（Phase 1 契约冻结）。
 * 12 个错误类 + 4 个机器可判断的分类属性（retryable / recoverable / userActionRequired / fatal）。
 * 语义：
 * - retryable：立即重试同一操作可能成功（网络/加载类）。
 * - recoverable：系统可以自愈或经标准化操作恢复（重装/替换/刷新自愈）。
 * - userActionRequired：用户必须介入（修包/换包/卸载冲突项）。
 * - fatal：该包被永久阻断（安全门），任何重试都无意义。
 * 与结果协议的边界：仓库/校验层保持 v1.0.0 的 { ok, issues } 结果协议（已验收事实，不改）；
 * 本分类学是抛出异常面的契约，当前已接线到运行时/加载层（消息逐字不变）。
 * @module dsh-skin/src/core/errors
 */

export type SkinErrorKind =
  | 'manifest' | 'package' | 'integrity' | 'compatibility' | 'resolution'
  | 'load' | 'apply' | 'dispose' | 'rollback' | 'repository' | 'network' | 'security'

export interface SkinErrorFlags {
  retryable: boolean
  recoverable: boolean
  userActionRequired: boolean
  fatal: boolean
}

export interface SkinErrorOptions {
  skinId?: string
  cause?: unknown
}

/** 各分类的默认分类属性（契约表，测试锁定）。 */
export const SKIN_ERROR_FLAGS: Record<SkinErrorKind, SkinErrorFlags> = {
  manifest: { retryable: false, recoverable: false, userActionRequired: true, fatal: false },
  package: { retryable: false, recoverable: false, userActionRequired: true, fatal: false },
  integrity: { retryable: false, recoverable: true, userActionRequired: true, fatal: false },
  compatibility: { retryable: false, recoverable: true, userActionRequired: true, fatal: false },
  resolution: { retryable: false, recoverable: true, userActionRequired: true, fatal: false },
  load: { retryable: true, recoverable: true, userActionRequired: false, fatal: false },
  apply: { retryable: true, recoverable: true, userActionRequired: false, fatal: false },
  dispose: { retryable: false, recoverable: true, userActionRequired: false, fatal: false },
  rollback: { retryable: true, recoverable: true, userActionRequired: false, fatal: false },
  repository: { retryable: false, recoverable: true, userActionRequired: true, fatal: false },
  network: { retryable: true, recoverable: true, userActionRequired: false, fatal: false },
  security: { retryable: false, recoverable: false, userActionRequired: false, fatal: true },
}

/** SkinError 基类：所有皮肤域异常的公共祖先。 */
export class SkinError extends Error {
  readonly kind: SkinErrorKind
  readonly flags: SkinErrorFlags
  readonly skinId?: string

  constructor(kind: SkinErrorKind, message: string, options: SkinErrorOptions = {}) {
    super(message)
    this.name = 'SkinError'
    this.kind = kind
    this.flags = { ...SKIN_ERROR_FLAGS[kind] }
    this.skinId = options.skinId
    if (options.cause !== undefined) (this as { cause?: unknown }).cause = options.cause
  }
}

function defineErrorClass(name: string, kind: SkinErrorKind) {
  return class extends SkinError {
    constructor(message: string, options?: SkinErrorOptions) {
      super(kind, message, options)
      this.name = name
    }
  }
}

/** 清单语义错误（字段非法/保留 ID 等）。 */
export const ManifestError = defineErrorClass('ManifestError', 'manifest')
export type ManifestError = InstanceType<typeof ManifestError>
/** 包结构错误（目录/文件布局、缺文件）。 */
export const PackageError = defineErrorClass('PackageError', 'package')
export type PackageError = InstanceType<typeof PackageError>
/** 完整性错误（sha256/清单不匹配）。 */
export const IntegrityError = defineErrorClass('IntegrityError', 'integrity')
export type IntegrityError = InstanceType<typeof IntegrityError>
/** 兼容性错误（skinApiVersion 超出宿主实现）。 */
export const CompatibilityError = defineErrorClass('CompatibilityError', 'compatibility')
export type CompatibilityError = InstanceType<typeof CompatibilityError>
/** 解析/遮蔽/ID 冲突类错误。 */
export const ResolutionError = defineErrorClass('ResolutionError', 'resolution')
export type ResolutionError = InstanceType<typeof ResolutionError>
/** 皮肤模块/bundle 加载失败。 */
export const LoadError = defineErrorClass('LoadError', 'load')
export type LoadError = InstanceType<typeof LoadError>
/** apply 失败（partial effects 已清理）。 */
export const ApplyError = defineErrorClass('ApplyError', 'apply')
export type ApplyError = InstanceType<typeof ApplyError>
/** dispose 验证失败（残留）。 */
export const DisposeError = defineErrorClass('DisposeError', 'dispose')
export type DisposeError = InstanceType<typeof DisposeError>
/** 切换/替换回滚失败。 */
export const RollbackError = defineErrorClass('RollbackError', 'rollback')
export type RollbackError = InstanceType<typeof RollbackError>
/** 仓库操作失败（install/remove/replace）。 */
export const RepositoryError = defineErrorClass('RepositoryError', 'repository')
export type RepositoryError = InstanceType<typeof RepositoryError>
/** 网络失败（workshop/下载；RemoteRepository 面）。 */
export const NetworkError = defineErrorClass('NetworkError', 'network')
export type NetworkError = InstanceType<typeof NetworkError>
/** 安全门拒绝（可执行/远程 URL/symlink）。 */
export const SecurityError = defineErrorClass('SecurityError', 'security')
export type SecurityError = InstanceType<typeof SecurityError>

/** 任意值是否为 SkinError。 */
export function isSkinError(value: unknown): value is SkinError {
  return value instanceof Error && typeof (value as SkinError).kind === 'string' && (value as SkinError).kind in SKIN_ERROR_FLAGS
}

/** 归类任意抛出值为 SkinError；非皮肤域错误返回 null。 */
export function classifySkinError(value: unknown): SkinError | null {
  return isSkinError(value) ? value : null
}

