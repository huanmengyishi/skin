/**
 * 皮肤 bundle 加载：复用宿主 client module table（官方动态加载机制），
 * 不新建 Skin 专用模块加载器。皮肤 bundle 是 factory-closure 形态：
 * 脚本执行时调用 window.__ModuleLoader__.load({ id, factory }) 注册，
 * 再经 ClientModuleLoader.import() 物化得到 { apply }。
 * 上层只见 loadSkinModule / unloadSkinModule 两个抽象。
 * @module dsh-skin/src/client/runtime/loader
 */

import type { SkinContext } from './skin-context.ts'
import { LoadError } from '../../core/errors.ts'

export interface SkinModuleSurface {
  apply?: (ctx: SkinContext) => void | Promise<void>
}

export interface SkinBundleHost {
  /** ClientModuleLoader.invalidate */
  invalidate(id: string): void
  /** ClientModuleLoader.import */
  importModule(id: string): Promise<unknown>
  /** 以 classic <script> 加载 bundle URL（工厂注册，副作用延迟到物化） */
  loadScript(url: string): Promise<void>
}

export function skinModuleId(skinId: string): string {
  return 'dsh-skin/' + skinId
}

function surfaceOf(namespace: unknown): SkinModuleSurface | undefined {
  if (namespace === null || typeof namespace !== 'object') return undefined
  const candidate = namespace as { default?: unknown; apply?: unknown }
  if (candidate.default !== null && typeof candidate.default === 'object') {
    const d = candidate.default as { apply?: unknown }
    if (typeof d.apply === 'function') return d as SkinModuleSurface
  }
  if (typeof candidate.apply === 'function') return candidate as SkinModuleSurface
  return undefined
}

/** 加载皮肤模块：invalidate 旧工厂 → 脚本注册 → 物化 → 校验 apply 契约。加载/物化失败统一归类 LoadError（G 证据驱动）。 */
export async function loadSkinModule(host: SkinBundleHost, skinId: string, url: string): Promise<SkinModuleSurface> {
  const moduleId = skinModuleId(skinId)
  host.invalidate(moduleId)
  try {
    await host.loadScript(url)
  } catch (error) {
    throw new LoadError('皮肤 bundle 加载失败：' + String((error as Error).message), { skinId })
  }
  let namespace: unknown
  try {
    namespace = await host.importModule(moduleId)
  } catch (error) {
    throw new LoadError('皮肤 bundle 物化失败：' + String((error as Error).message), { skinId })
  }
  const surface = surfaceOf(namespace)
  if (surface === undefined) {
    throw new LoadError('皮肤 bundle 必须导出 apply(skinCtx)（' + skinId + '）', { skinId })
  }
  return surface
}

/** 卸载皮肤模块：invalidate 工厂与物化记录（样式回收由 SkinContext 负责）。 */
export function unloadSkinModule(host: SkinBundleHost, skinId: string): void {
  host.invalidate(skinModuleId(skinId))
}
