/**
 * Phase 1 契约冻结（运行时/编排面）：SkinRuntime / SkinRuntimeContext / SkinController。
 * 冻结的是语义与表面，不冻结实现内部（tryOnToken / epoch / Map / 具体类）。
 * 命名映射：契约名 apply/switch/restore/enter/exit ↔ 实现名 applySkin/switchSkin/restoreDefault/tryOn/exitTryOn；
 * 实现名保留（v1.0.0 验收事实），改名属于 Phase 2 候选，见 docs/skin-api-contract.md。
 * @module dsh-skin/src/client/runtime/contract
 */

import type { RuntimeSnapshot, TryOnHandle } from './runtime.ts'

/** SkinRuntime 契约面：apply / dispose / switch / restore + try-on(enter/exit)。无 preview（预览属于 Package/Repository 层）。 */
export interface SkinRuntimeFace {
  /** 应用并持久化（= applySkin(id, { persist: true })）。失败清理 partial effects 并抛 ApplyError。 */
  apply(id: string): Promise<void>
  /** 切换（dispose A → apply B → 失败恢复 A；activeSkin 只在 B 成功后更新）。 */
  switch(id: string): Promise<void>
  /** 恢复默认（dispose 当前 + activeSkin 置 null）。 */
  restore(): Promise<void>
  /** 试穿进入（不持久化，返回退出句柄）。 */
  enter(id: string): Promise<TryOnHandle>
  /** 退出当前试穿。 */
  exit(): Promise<void>
  /** 刷新皮肤列表快照。 */
  list(): Promise<void>
  /** 卸载 installed/generated/downloaded 皮肤（激活中先 restore）。 */
  remove(id: string): Promise<void>
  /** 启动恢复：按持久化 activeSkin 重新应用（失败不抹持久值）。 */
  bootstrap(activeId: string | null): Promise<void>
  getSnapshot(): RuntimeSnapshot
  subscribe(listener: () => void): () => void
  activeId(): string | null
}

/** 副作用登记的类型面（保持与 SkinContext 现实现一致，仅类型）。 */
export interface SkinRuntimeContextContract {
  readonly id: string
  effect(fn: () => void | (() => void)): void
  addStyle(css: string): void
  addElement(element: { remove(): void }, parent?: { appendChild(child: unknown): void }): void
  addAttribute(target: {
    hasAttribute(name: string): boolean
    getAttribute(name: string): string | null
    setAttribute(name: string, value: string): void
    removeAttribute(name: string): void
  }, name: string, value: string): void
  addObserver(target: unknown, callback: (records: unknown[]) => void, options?: unknown): void
  addTimer(fn: () => void, ms: number, opts?: { interval?: boolean }): { clear(): void }
  readonly theme: { overrideTokens(tokens: Record<string, { light: string; dark: string }>): void }
  /** 幂等逆序回收；单个 disposer 失败不阻断其余清理。 */
  dispose(): void
  readonly effectCount: number
}

/** SkinController 契约面：Skin Center 的唯一上层编排入口（Surface 名冻结）。 */
export interface SkinControllerFace {
  readonly runtime: SkinRuntimeFace
  listSkins(): Promise<unknown[]>
  getSkin(id: string): Promise<unknown>
  generate(input: unknown): Promise<unknown>
  regenerate(id: string): Promise<unknown>
  export(id: string): Promise<void>
  removeSkin(id: string): Promise<void>
  browseWorkshop(query: string): Promise<unknown>
  publish(id: string, mode: 'new' | 'version'): Promise<unknown>
  report(id: string): Promise<unknown>
}

