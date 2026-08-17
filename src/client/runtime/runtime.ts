/**
 * SkinRuntime：load / apply / dispose / switch / try-on 的客户端状态机。
 * - 任意时刻最多一个激活皮肤；切换失败回滚恢复原皮肤；activeSkin 只在成功后持久化。
 * - try-on 不持久化、epoch 防竞态。
 * @module dsh-skin/src/client/runtime/runtime
 */

import { SkinContext, type SkinDomLike, type ThemeTokenOverrides } from './skin-context.ts'
import { ApplyError, DisposeError, LoadError, RollbackError } from '../../core/errors.ts'
import { loadSkinModule, skinModuleId, unloadSkinModule, type SkinBundleHost } from './loader.ts'

export interface SkinInfo {
  id: string
  source: 'builtin' | 'installed' | 'generated' | 'downloaded'
  state: 'ok' | 'invalid' | 'corrupt'
  issues: string[]
  manifest: {
    id: string
    version: string
    name: string
    author: string
    description: string
    tags: string[]
    skinApiVersion: number
    preview: { light?: string; dark?: string }
  }
  files: {
    bundle: string
    styles: string
    themeLight: string
    themeDark: string
    previewLight?: string
    previewDark?: string
  }
  rev: string
  updatedAtMs: number
  trust: 'trusted' | 'untrusted'
}

export interface SkinListInfo {
  id: string
  source: 'builtin' | 'installed' | 'generated' | 'downloaded'
  version: string
  name: string
  author: string
  description: string
  tags: string[]
  skinApiVersion: number
  preview: { light?: string; dark?: string }
  state: 'ok' | 'invalid' | 'corrupt'
  issues: string[]
  updatedAtMs: number
  trust: 'trusted' | 'untrusted'
}

export interface SkinApiClient {
  list(): Promise<SkinListInfo[]>
  get(id: string): Promise<SkinInfo>
}

export interface RuntimeSettings {
  /** 读取当前持久化的 activeSkin（无则 null）。 */
  get(): string | null
  /** 写入 activeSkin；宿主不可写时抛错（调用方降级为进程内状态）。 */
  set(value: string | null): void | Promise<void>
  /** 持久层是否可写（loopback 页面为 true）。 */
  writable(): boolean
}

export interface RuntimeEnv {
  themeOverride(source: string, tokens: ThemeTokenOverrides): () => void
  bundleHost: SkinBundleHost
  api: SkinApiClient
  settings: RuntimeSettings
  dom: SkinDomLike
  fetchImpl?: (input: string, init?: unknown) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>
}

export interface RuntimeSnapshot {
  skins: SkinListInfo[]
  activeId: string | null
  tryOnId: string | null
  status: 'idle' | 'loading' | 'ready' | 'error'
  error: string | null
  persisted: boolean
}

export interface TryOnHandle {
  id: string
  exit(): Promise<void>
}

/** 内部：过期异步提交信号（try-on epoch 判定用，不进入公共契约）。 */
class StaleApplyError extends Error {}

interface AppliedSkin {
  id: string
  ctx: SkinContext
  dispose(): void
  verify(): string[]
}

/** 两个主题文件合并为宿主覆盖层形状；键并集、两侧缺省按同值补空串会被宿主拒绝，因此只保留两侧都存在的键。 */
function tokensFromFiles(light: Record<string, unknown>, dark: Record<string, unknown>): ThemeTokenOverrides {
  const merged: ThemeTokenOverrides = {}
  for (const key of Object.keys(light)) {
    const lightValue = light[key]
    const darkValue = dark[key]
    if (typeof lightValue === 'string' && typeof darkValue === 'string') {
      merged[key] = { light: lightValue, dark: darkValue }
    }
  }
  return merged
}

export class SkinRuntime {
  private current: AppliedSkin | null = null
  private pendingTryOn: TryOnHandle | null = null
  private tryOnToken = 0
  /** 试穿基准：首次 enter 时的正式激活皮肤；exit 恢复它。 */
  private tryOnBaseId: string | null = null
  private readonly listeners = new Set<() => void>()
  private snapshot: RuntimeSnapshot = {
    skins: [],
    activeId: null,
    tryOnId: null,
    status: 'idle',
    error: null,
    persisted: true,
  }

  constructor(private readonly env: RuntimeEnv) {}

  getSnapshot(): RuntimeSnapshot {
    return { ...this.snapshot, skins: [...this.snapshot.skins] }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private emit(): void {
    for (const listener of this.listeners) {
      try { listener() } catch { /* 监听器错误不影响运行时 */ }
    }
  }

  private update(patch: Partial<RuntimeSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch }
    this.emit()
  }

  private fetchImpl(): NonNullable<RuntimeEnv['fetchImpl']> {
    if (this.env.fetchImpl !== undefined) return this.env.fetchImpl
    throw new Error('RuntimeEnv.fetchImpl 未注入')
  }

  async listSkins(): Promise<void> {
    try {
      const skins = await this.env.api.list()
      this.update({ skins, status: 'ready', error: null })
    } catch (error) {
      this.update({ status: 'error', error: '无法加载皮肤列表：' + String((error as Error).message) })
    }
  }

  /** 当前激活皮肤 id。 */
  activeId(): string | null {
    return this.snapshot.activeId
  }

  /** 当前激活皮肤 id。 */
  get currentId(): string | null {
    return this.current?.id ?? null
  }

  /** 加载并应用一个皮肤（可持久化）。失败时清理 partial effects 并抛错。
   *  opts.guard（内部）：提交前检查失效条件；失效则丢弃本次提交并抛 StaleApplyError（try-on 竞态用，非公共契约）。 */
  async applySkin(id: string, opts: { persist?: boolean; guard?: () => boolean } = {}): Promise<void> {
    const persist = opts.persist !== false
    if (this.snapshot.status === 'loading' && opts.guard === undefined) throw new ApplyError('已有加载进行中')
    this.update({ status: 'loading', error: null })
    try {
      const info = await this.env.api.get(id)
      if (info.state === 'corrupt') throw new LoadError('皮肤包损坏，拒绝应用：' + id, { skinId: id })
      if (info.state === 'invalid') throw new LoadError('皮肤包非法，拒绝应用：' + id, { skinId: id })

      // theme 层：读取主题 token 文件
      let tokens: ThemeTokenOverrides = {}
      try {
        const [lightRaw, darkRaw] = await Promise.all([
          this.fetchImpl()(info.files.themeLight).then(r => (r.ok ? r.json() : Promise.resolve({}))),
          this.fetchImpl()(info.files.themeDark).then(r => (r.ok ? r.json() : Promise.resolve({}))),
        ])
        tokens = tokensFromFiles(lightRaw as Record<string, unknown>, darkRaw as Record<string, unknown>)
      } catch {
        tokens = {}
      }

      // 结构层：样式文本（缺失容忍为空）
      let css = ''
      try {
        const styles = await this.fetchImpl()(info.files.styles)
        if (styles.ok) css = await styles.text()
      } catch {
        css = ''
      }

      // 皮肤模块
      const surface = await loadSkinModule(this.env.bundleHost, id, info.files.bundle)
      if (opts.guard !== undefined && !opts.guard()) {
        unloadSkinModule(this.env.bundleHost, id)
        throw new StaleApplyError()
      }

      // 受限 SkinContext + 分层应用
      const ctx = new SkinContext({
        dom: this.env.dom,
        id,
        themeOverride: tokens => this.env.themeOverride('dsh-skin:' + id, tokens),
      })
      const moduleId = skinModuleId(id)
      try {
        if (Object.keys(tokens).length > 0) ctx.theme.overrideTokens(tokens)
        if (css.length > 0) ctx.addStyle(css)
        ctx.addAttribute(this.env.dom.body(), 'data-dsh-skin', id)
        await surface.apply?.(ctx)
      } catch (error) {
        ctx.dispose()
        unloadSkinModule(this.env.bundleHost, id)
        throw new ApplyError('皮肤 apply 失败（partial effects 已清理）：' + String((error as Error).message), { skinId: id })
      }

      const applied: AppliedSkin = {
        id,
        ctx,
        verify: () => {
          const reasons: string[] = []
          if (this.env.dom.body().getAttribute('data-dsh-skin') !== id) reasons.push('body 作用域属性缺失')
          return reasons
        },
        dispose: () => {
          ctx.dispose()
          unloadSkinModule(this.env.bundleHost, id)
          this.env.dom.removeOwnedStyles(moduleId)
        },
      }
      const problems = applied.verify()
      if (problems.length > 0) {
        applied.dispose()
        throw new ApplyError('皮肤验证失败：' + problems.join('；'), { skinId: id })
      }
      if (opts.guard !== undefined && !opts.guard()) {
        applied.dispose()
        throw new StaleApplyError()
      }

      // 成功路径：替换当前，再持久化（绝不先写 settings）
      if (this.current !== null) {
        const previous = this.current
        this.current = applied
        previous.dispose()
      } else {
        this.current = applied
      }
      if (persist) {
        try {
          await this.env.settings.set(id)
          this.update({ activeId: id, status: 'ready', error: null, persisted: true })
        } catch (error) {
          this.update({ activeId: id, status: 'ready', persisted: false, error: 'settings 不可写，激活状态仅本页有效：' + String((error as Error).message) })
        }
      } else {
        this.update({ activeId: this.snapshot.activeId, status: 'ready', error: null })
      }
    } catch (error) {
      if (error instanceof StaleApplyError) return
      this.update({ status: 'error', error: String((error as Error).message) })
      throw error
    }
  }

  /** 停用当前皮肤（不改变持久化 activeSkin）。 */
  private async disposeCurrent(): Promise<void> {
    if (this.current === null) return
    const applied = this.current
    this.current = null
    applied.dispose()
    const problems = this.env.dom.body().getAttribute('data-dsh-skin') === null ? [] : ['data-dsh-skin 残留']
    if (problems.length > 0) throw new DisposeError('dispose 验证失败：' + problems.join('；'))
    // Phase 2.5 证据驱动的最小 DOM 清理：主题层清空 token 后遗留的空属性无任何语义，移除之
    const body = this.env.dom.body()
    if (body.hasAttribute('style') && body.getAttribute('style') === '') {
      body.removeAttribute('style')
    }
  }

  /** 切换：dispose A → apply B → 验证；B 失败清理并恢复 A；activeSkin 只在 B 成功后更新。 */
  async switchSkin(id: string): Promise<void> {
    if (this.current?.id === id) return
    const previous = this.current
    const previousId = previous?.id ?? null
    try {
      await this.disposeCurrent()
      await this.applySkin(id, { persist: true })
    } catch (error) {
      let restoreError: Error | null = null
      if (previousId !== null) {
        try {
          await this.applySkin(previousId, { persist: false })
        } catch (e) {
          restoreError = e as Error
        }
      }
      const detail = '切换失败：' + String((error as Error).message)
      if (restoreError !== null) {
        throw new RollbackError(detail + '；恢复原皮肤也失败：' + restoreError.message + '（activeSkin 未变，刷新后自愈）')
      }
      throw new RollbackError(detail + '；已恢复原皮肤 ' + previousId)
    }
  }

  /** 试穿：首次 enter 快照正式激活皮肤为基准 → 卸载 → 加载目标（不持久化）→ 观察 → exit 恢复基准。
   * 竞态语义（H）：最后一次有效 enter 决定最终状态；过期 enter 的异步提交被 guard 丢弃，不得注入任何效果。 */
  async tryOn(id: string): Promise<TryOnHandle> {
    const token = ++this.tryOnToken
    if (this.snapshot.tryOnId === null) this.tryOnBaseId = this.current?.id ?? null
    const baseId = this.tryOnBaseId
    this.update({ tryOnId: id, error: null })
    try {
      await this.disposeCurrent()
      await this.applySkin(id, { persist: false, guard: () => token === this.tryOnToken })
      if (token !== this.tryOnToken) return { id, exit: async () => undefined }
    } catch (error) {
      if (error instanceof StaleApplyError) return { id, exit: async () => undefined }
      if (token !== this.tryOnToken) return { id, exit: async () => undefined }
      this.update({ tryOnId: null })
      if (baseId !== null) {
        try { await this.applySkin(baseId, { persist: false, guard: () => true }) } catch { /* 恢复失败记录到 error */ }
      }
      this.tryOnBaseId = null
      throw error
    }
    const handle: TryOnHandle = { id, exit: async () => { await this.exitTryOnInternal(token) } }
    this.pendingTryOn = handle
    return handle
  }

  /** 退出当前试穿（对外便捷入口）：取消一切 in-flight enter，回收目标，恢复基准。 */
  async exitTryOn(): Promise<void> {
    if (this.snapshot.tryOnId === null) return
    await this.exitTryOnInternal(this.tryOnToken)
  }

  /** 统一退出实现：过期句柄直接忽略；退出使 in-flight enter 全部过期并恢复基准。 */
  private async exitTryOnInternal(token: number): Promise<void> {
    if (token !== this.tryOnToken) return
    this.tryOnToken++
    const baseId = this.tryOnBaseId
    this.tryOnBaseId = null
    this.pendingTryOn = null
    try {
      await this.disposeCurrent()
    } catch { /* 目标皮肤卸载异常也继续恢复 */ }
    if (baseId !== null) {
      try {
        await this.applySkin(baseId, { persist: false, guard: () => true })
      } catch { /* 恢复失败记录到 error */ }
    }
    this.update({ tryOnId: null, status: 'ready', error: null })
  }
  /** 卸载 installed 皮肤（经 host API）；若正是激活皮肤，先恢复默认再卸载。 */
  async removeSkin(id: string): Promise<void> {
    if (this.snapshot.activeId === id) {
      await this.restoreDefault()
    }
    const response = await this.fetchImpl()('/dsh-skin/api/remove', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    })
    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as { issues?: string[] }
      throw new Error('卸载失败：' + (payload.issues?.join('；') ?? 'HTTP ' + response.status))
    }
    await this.listSkins()
  }

  /** 恢复默认：dispose 当前并把 activeSkin 置 null。 */
  async restoreDefault(): Promise<void> {
    await this.disposeCurrent()
    try {
      await this.env.settings.set(null)
      this.update({ activeId: null, status: 'ready', error: null, persisted: true })
    } catch (error) {
      this.update({ activeId: null, status: 'ready', persisted: false, error: 'settings 不可写：' + String((error as Error).message) })
    }
  }

  /** 启动恢复：按持久化 activeSkin 重新应用（失败不抹掉持久值，下次刷新重试）。 */
  async bootstrap(activeId: string | null): Promise<void> {
    if (activeId === null) {
      this.update({ activeId: null, status: 'ready' })
      return
    }
    this.update({ activeId })
    try {
      await this.applySkin(activeId, { persist: false })
    } catch (error) {
      this.update({ status: 'error', error: '激活皮肤恢复失败（' + activeId + '）：' + String((error as Error).message) })
    }
  }
}

export { SkinContext }
