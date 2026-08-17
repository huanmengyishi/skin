import { describe, expect, it } from 'vitest'
import {
  ApplyError, CompatibilityError, DisposeError, IntegrityError, LoadError, ManifestError,
  NetworkError, PackageError, RepositoryError, ResolutionError, RollbackError, SecurityError,
  SkinError, SKIN_ERROR_FLAGS, classifySkinError, isSkinError,
  type SkinErrorKind,
} from '../../src/core/errors'

type SkinErrorCtor = new (message: string, options?: { skinId?: string; cause?: unknown }) => SkinError
const CLASSES: Array<[SkinErrorKind, string, SkinErrorCtor]> = [
  ['manifest', 'ManifestError', ManifestError],
  ['package', 'PackageError', PackageError],
  ['integrity', 'IntegrityError', IntegrityError],
  ['compatibility', 'CompatibilityError', CompatibilityError],
  ['resolution', 'ResolutionError', ResolutionError],
  ['load', 'LoadError', LoadError],
  ['apply', 'ApplyError', ApplyError],
  ['dispose', 'DisposeError', DisposeError],
  ['rollback', 'RollbackError', RollbackError],
  ['repository', 'RepositoryError', RepositoryError],
  ['network', 'NetworkError', NetworkError],
  ['security', 'SecurityError', SecurityError],
]

describe('Phase 1 契约：SkinError 分类学', () => {
  it('12 个错误类全部存在，kind 与默认分类属性符合契约表', () => {
    expect(CLASSES).toHaveLength(12)
    for (const [kind, className, Ctor] of CLASSES) {
      const err = new Ctor('契约测试消息', { skinId: 'demo' })
      expect(err).toBeInstanceOf(SkinError)
      expect(err).toBeInstanceOf(Error)
      expect(err.kind).toBe(kind)
      expect(err.message).toBe('契约测试消息')
      expect(err.skinId).toBe('demo')
      expect(err.flags).toEqual(SKIN_ERROR_FLAGS[kind])
      expect(err.name).toBe(className)
    }
  })

  it('分类属性语义锚点：retryable/recoverable/userActionRequired/fatal 的关键样例', () => {
    const network = new NetworkError('x')
    expect(network.flags.retryable).toBe(true)
    const manifest = new ManifestError('x')
    expect(manifest.flags.userActionRequired).toBe(true)
    expect(manifest.flags.retryable).toBe(false)
    const security = new SecurityError('x')
    expect(security.flags.fatal).toBe(true)
    expect(security.flags.recoverable).toBe(false)
    const load = new LoadError('x')
    expect(load.flags.retryable && load.flags.recoverable).toBe(true)
    const integrity = new IntegrityError('x')
    expect(integrity.flags.recoverable && integrity.flags.userActionRequired).toBe(true)
  })

  it('归类器：SkinError 可识别，普通 Error 返回 null', () => {
    const err = new ApplyError('apply 失败', { skinId: 'a' })
    expect(isSkinError(err)).toBe(true)
    expect(classifySkinError(err)).toBe(err)
    expect(isSkinError(new Error('普通错误'))).toBe(false)
    expect(classifySkinError('字符串')).toBeNull()
    expect(classifySkinError(null)).toBeNull()
  })
})

