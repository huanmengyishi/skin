/**
 * SkinDomLike 的浏览器实现与宿主 client 插件入口。
 * @module dsh-skin/src/client/index
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ClientModuleLoader } from '@deepseek-ai/dsh-client-modules/client'
import type { ThemeRuntime } from '@deepseek-ai/dsh-client-ui-theme/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type {
  AttrTarget, ObserverHandle, ParentLike, Removable, SkinDomLike, TimerHandle,
} from './runtime/skin-context.ts'
import { SkinRuntime, type RuntimeSettings, type SkinInfo, type SkinListInfo } from './runtime/runtime.ts'
import { SkinSettingsCard } from './ui/skin-card.tsx'
import { SkinController } from './controller/controller.ts'
import { AIGenerationController } from './controller/generation-controller.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 客户端皮肤运行时服务（SkinRuntime）。 */
    skinRuntime: SkinRuntime
  }
}

/** 浏览器实现：真实 document / window 定时器 / MutationObserver。 */
function browserDom(): SkinDomLike {
  const removeOwned = (moduleId: string): void => {
    for (const style of document.querySelectorAll('style[data-plugin="' + moduleId + '"]')) {
      style.remove()
    }
  }
  return {
    createStyle(css, ownerId) {
      const style = document.createElement('style')
      style.setAttribute('data-dsh-skin-owner', ownerId)
      style.textContent = css
      document.head.append(style)
      return { remove: () => { style.remove() } }
    },
    createObserver(callback): ObserverHandle {
      const observer = new MutationObserver(records => callback([...records]))
      return { observe: (target, options) => { observer.observe(target as Node, options as MutationObserverInit) }, disconnect: () => { observer.disconnect() } }
    },
    setTimer(fn, ms, interval): TimerHandle {
      if (interval) {
        const id = window.setInterval(fn, ms)
        return { clear: () => { window.clearInterval(id) } }
      }
      const id = window.setTimeout(fn, ms)
      return { clear: () => { window.clearTimeout(id) } }
    },
    body: () => document.body as unknown as AttrTarget & ParentLike,
    removeOwnedStyles: removeOwned,
  }
}

/** classic <script> 加载皮肤 bundle（工厂注册）。 */
function loadScriptViaElement(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.async = true
    script.src = url
    script.addEventListener('load', () => { script.remove(); resolve() }, { once: true })
    script.addEventListener('error', () => { script.remove(); reject(new Error('皮肤 bundle 加载失败：' + url)) }, { once: true })
    document.head.append(script)
  })
}

export const inject = ['slots', 'theme', 'modules']

export function apply(ctx: Context): void {
  // 持久化经插件自有 loopback API（宿主 settings 网关白名单不含插件 namespace），
  // 存储介质仍是官方 settings seam（settings.yaml 的 dsh-skin 段）。
  let cachedActive: string | null = null
  const settings: RuntimeSettings = {
    get: () => cachedActive,
    set: async value => {
      const response = await fetch('/dsh-skin/api/active', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ activeSkin: value }),
      })
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string }
        throw new Error(payload.error ?? 'HTTP ' + response.status)
      }
      cachedActive = value
    },
    writable: () => true,
  }

  const api = {
    async list(): Promise<SkinListInfo[]> {
      const response = await fetch('/dsh-skin/api/skins')
      if (!response.ok) throw new Error('HTTP ' + response.status)
      const payload = (await response.json()) as { skins: SkinListInfo[] }
      return payload.skins
    },
    async get(id: string): Promise<SkinInfo> {
      const response = await fetch('/dsh-skin/api/skins/' + encodeURIComponent(id))
      if (!response.ok) throw new Error('HTTP ' + response.status)
      return (await response.json()) as SkinInfo
    },
  }

  const runtime = new SkinRuntime({
    themeOverride: (source, tokens) => (ctx.get('theme') as ThemeRuntime).overrideTokens(source, tokens),
    bundleHost: {
      invalidate: id => (ctx.get('modules') as ClientModuleLoader).invalidate(id),
      importModule: id => (ctx.get('modules') as ClientModuleLoader).import(id, '', {}),
      loadScript: loadScriptViaElement,
    },
    api,
    settings,
    dom: browserDom(),
    fetchImpl: (input, init) => fetch(input, init as RequestInit),
  })
  ctx.provide('skinRuntime', runtime)
  const controller = new SkinController({ runtime, api, fetchImpl: (input, init) => fetch(input, init as RequestInit) })
  const generationController = new AIGenerationController({ fetchImpl: (input, init) => fetch(input, init as RequestInit) })

  // 启动恢复：先经自有 API 读取持久化的 activeSkin，再 bootstrap（失败不抹持久值）
  void (async () => {
    try {
      const response = await fetch('/dsh-skin/api/active')
      if (response.ok) {
        const payload = (await response.json()) as { activeSkin?: unknown }
        cachedActive = typeof payload.activeSkin === 'string' && payload.activeSkin.length > 0 ? payload.activeSkin : null
      }
    } catch {
      // 读取失败按未激活处理；bootstrap 自身再兜底
    }
    await runtime.bootstrap(cachedActive)
  })()

  // 最小验证入口：settings.plugin.item 皮肤卡（Phase 2 替换为完整 Skin Center）
  ctx.effect(() =>
    ctx.slots.inject('settings.plugin.item', function* () {
      yield ctx.slots.register(
        {
          name: 'settings.plugin.item',
          id: 'dsh-skin',
          order: 40,
          label: () => 'Skins',
          inject: () => ({ controller, generationController }),
        },
        SkinSettingsCard,
      )
    }), 'dsh-skin: skin settings card')
}
