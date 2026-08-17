import type { AttrTarget, ParentLike, SkinDomLike } from '../../src/client/runtime/skin-context'

/** 追踪型 DOM：对六类副作用逐一仪器化，计算 residue（G/H 共用）。 */
export function trackingDom(): SkinDomLike & { residue(): Record<string, number> } {
  const styles: Array<{ alive: boolean }> = []
  const observers: Array<{ connected: boolean }> = []
  const timers: Array<{ alive: boolean }> = []
  const elements: Array<{ alive: boolean }> = []
  const bodyEl = {
    attrs: new Map<string, string>(),
    hasAttribute: (n: string) => bodyEl.attrs.has(n),
    getAttribute: (n: string) => bodyEl.attrs.get(n) ?? null,
    setAttribute: (n: string, v: string) => { bodyEl.attrs.set(n, v) },
    removeAttribute: (n: string) => { bodyEl.attrs.delete(n) },
    appendChild: (child: unknown) => { const el = child as { alive: boolean }; el.alive = true; elements.push(el) },
  } as AttrTarget & ParentLike & { attrs: Map<string, string> }
  const dom: SkinDomLike & { residue(): Record<string, number> } = {
    createStyle: () => { const s = { alive: true }; styles.push(s); return { remove: () => { s.alive = false } } },
    createObserver: () => { const o = { connected: false }; observers.push(o); return { observe: () => { o.connected = true }, disconnect: () => { o.connected = false } } },
    setTimer: () => { const t = { alive: true }; timers.push(t); return { clear: () => { t.alive = false } } },
    body: () => bodyEl,
    removeOwnedStyles: () => undefined,
    residue: () => ({
      dom: elements.filter(e => e.alive).length,
      css: styles.filter(s => s.alive).length,
      attribute: bodyEl.attrs.size,
      listener: 0, // 本实现无 listener API；登记式副作用统一经 effect disposer
      observer: observers.filter(o => o.connected).length,
      timer: timers.filter(t => t.alive).length,
    }),
  }
  return dom
}

export const cleanResidue = { dom: 0, css: 0, attribute: 0, listener: 0, observer: 0, timer: 0 }

