/**
 * SkinContext：Skin 与宿主之间唯一的运行时接口。
 * 皮肤代码绝不接触真实 Harness ctx / loader / settings / 凭据；
 * 只通过本 facade 产生可追踪副作用，dispose 时逆序精确回收。
 * DOM 操作经注入的 SkinDomLike 抽象（浏览器实现 / 测试伪实现）。
 * @module dsh-skin/src/client/runtime/skin-context
 */

/** 一个 token 覆盖层：{ token 名: { light, dark } }（与宿主 ThemeRuntime 一致）。 */
export type ThemeTokenOverrides = Record<string, { light: string; dark: string }>

export interface AttrTarget {
  hasAttribute(name: string): boolean
  getAttribute(name: string): string | null
  setAttribute(name: string, value: string): void
  removeAttribute(name: string): void
}

export interface Removable {
  remove(): void
}

export interface ParentLike {
  appendChild(child: unknown): void
}

export interface TimerHandle {
  clear(): void
}

export interface ObserverHandle {
  observe(target: unknown, options?: unknown): void
  disconnect(): void
}

/** DOM 抽象：浏览器实现用真实 document；测试注入伪实现。 */
export interface SkinDomLike {
  createStyle(css: string, ownerId: string): Removable
  createObserver(callback: (records: unknown[]) => void): ObserverHandle
  setTimer(fn: () => void, ms: number, interval: boolean): TimerHandle
  body(): AttrTarget & ParentLike
  /** 移除 materialize 时被模块系统标记为 data-plugin=<moduleId> 的样式（皮肤卸载兜底）。 */
  removeOwnedStyles(moduleId: string): void
}

export interface SkinContextOptions {
  dom: SkinDomLike
  /** 宿主 ctx.theme.overrideTokens 的透传（source 已被钉为皮肤 id）。 */
  themeOverride: (tokens: ThemeTokenOverrides) => () => void
  /** 皮肤 id（所有权标记）。 */
  id: string
}

export class SkinContext {
  private readonly effects: Array<() => void> = []
  private disposed = false
  readonly theme: { overrideTokens(tokens: ThemeTokenOverrides): void }

  constructor(private readonly options: SkinContextOptions) {
    this.theme = {
      overrideTokens: (tokens) => {
        this.assertLive()
        const dispose = this.options.themeOverride(tokens)
        this.effects.push(dispose)
      },
    }
  }

  get id(): string {
    return this.options.id
  }

  /** 立即执行 fn，其返回的 disposer（如有）登记到回收链。 */
  effect(fn: () => void | (() => void)): void {
    this.assertLive()
    const disposer = fn()
    if (typeof disposer === 'function') this.effects.push(disposer)
  }

  /** 注入一段 CSS：创建带所有权标记的 <style>，dispose 时移除。 */
  addStyle(css: string): void {
    this.assertLive()
    const style = this.options.dom.createStyle(css, this.id)
    this.effects.push(() => style.remove())
  }

  /** 挂载一个元素（默认 body），dispose 时移除该元素本身。 */
  addElement(element: Removable, parent?: ParentLike): void {
    this.assertLive()
    const target = parent ?? this.options.dom.body()
    target.appendChild(element)
    this.effects.push(() => element.remove())
  }

  /** 设置属性并在 dispose 时精确恢复旧值（或移除）。 */
  addAttribute(target: AttrTarget, name: string, value: string): void {
    this.assertLive()
    const had = target.hasAttribute(name)
    const previous = had ? target.getAttribute(name) : null
    target.setAttribute(name, value)
    this.effects.push(() => {
      if (had) target.setAttribute(name, previous as string)
      else target.removeAttribute(name)
    })
  }

  /** 观察 DOM 变化；dispose 时 disconnect。 */
  addObserver(target: unknown, callback: (records: unknown[]) => void, options?: unknown): void {
    this.assertLive()
    const observer = this.options.dom.createObserver(callback)
    observer.observe(target, options)
    this.effects.push(() => observer.disconnect())
  }

  /** 定时器（setTimeout / setInterval 语义）；dispose 时全部 clear。 */
  addTimer(fn: () => void, ms: number, opts?: { interval?: boolean }): TimerHandle {
    this.assertLive()
    const timer = this.options.dom.setTimer(fn, ms, opts?.interval === true)
    this.effects.push(() => timer.clear())
    return timer
  }

  /** 逆序回收全部副作用；幂等；单个 disposer 失败不阻断其余清理。 */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (let i = this.effects.length - 1; i >= 0; i--) {
      try {
        this.effects[i]()
      } catch {
        // 清理继续：一个失败不留下更多残留
      }
    }
    this.effects.length = 0
  }

  /** 已登记的副作用数量（测试/verify 用）。 */
  get effectCount(): number {
    return this.effects.length
  }

  private assertLive(): void {
    if (this.disposed) throw new Error('SkinContext 已 dispose，不能再登记副作用')
  }
}
