import { describe, expect, it } from 'vitest'
import { SkinContext, type AttrTarget, type ParentLike, type Removable, type SkinDomLike, type ThemeTokenOverrides, type TimerHandle } from '../../src/client/runtime/skin-context'

interface FakeElement extends AttrTarget, ParentLike, Removable {
  attrs: Map<string, string>
  children: unknown[]
  removed: boolean
}

function fakeElement(): FakeElement {
  const attrs = new Map<string, string>()
  return {
    attrs,
    children: [],
    removed: false,
    hasAttribute: name => attrs.has(name),
    getAttribute: name => (attrs.has(name) ? attrs.get(name) ?? null : null),
    setAttribute: (name, value) => { attrs.set(name, value) },
    removeAttribute: name => { attrs.delete(name) },
    appendChild: child => { (void child) },
    remove: () => { },
  }
}

function fakeDom(): SkinDomLike & { removedStyles: string[]; bodyEl: FakeElement } {
  const bodyEl = fakeElement()
  const removedStyles: string[] = []
  return {
    bodyEl,
    removedStyles,
    createStyle(_css, ownerId) {
      return { remove: () => { removedStyles.push(ownerId) } }
    },
    createObserver() {
      let disconnected = false
      return {
        observe: () => { disconnected = false },
        disconnect: () => { disconnected = true },
        get disconnected() { return disconnected },
      }
    },
    setTimer(_fn, _ms, _interval): TimerHandle {
      return { clear: () => { /* 记录由调用方断言 */ } }
    },
    body: () => bodyEl,
    removeOwnedStyles: () => { removedStyles.push('module-residual') },
  }
}

function themeRecorder() {
  const calls: { tokens: ThemeTokenOverrides[]; disposed: number } = { tokens: [], disposed: 0 }
  const override = (tokens: ThemeTokenOverrides): (() => void) => {
    calls.tokens.push(tokens)
    return () => { calls.disposed += 1 }
  }
  return { calls, override }
}

describe('SkinContext', () => {
  it('effect 立即执行并登记 disposer', () => {
    const dom = fakeDom()
    const ctx = new SkinContext({ dom, themeOverride: () => () => undefined, id: 't' })
    const order: string[] = []
    ctx.effect(() => { order.push('run'); return () => { order.push('dispose') } })
    expect(order).toEqual(['run'])
    expect(ctx.effectCount).toBe(1)
    ctx.dispose()
    expect(order).toEqual(['run', 'dispose'])
  })

  it('多个副作用按逆序回收', () => {
    const dom = fakeDom()
    const ctx = new SkinContext({ dom, themeOverride: () => () => undefined, id: 't' })
    const order: string[] = []
    ctx.effect(() => () => { order.push('a') })
    ctx.effect(() => () => { order.push('b') })
    ctx.effect(() => () => { order.push('c') })
    ctx.dispose()
    expect(order).toEqual(['c', 'b', 'a'])
  })

  it('addAttribute 恢复旧值；addStyle/addElement 移除自身', () => {
    const dom = fakeDom()
    const ctx = new SkinContext({ dom, themeOverride: () => () => undefined, id: 't' })
    const target = fakeElement()
    target.setAttribute('data-x', 'before')
    ctx.addAttribute(target, 'data-x', 'after')
    expect(target.getAttribute('data-x')).toBe('after')
    ctx.addAttribute(target, 'data-y', '1')
    const el = fakeElement()
    ctx.addElement(el)
    ctx.addStyle('body {}')
    ctx.dispose()
    expect(target.getAttribute('data-x')).toBe('before')
    expect(target.hasAttribute('data-y')).toBe(false)
    expect(dom.removedStyles).toContain('t')
  })

  it('addObserver/addTimer 在 dispose 时断开/清除', () => {
    const dom = fakeDom()
    const disconnected: boolean[] = []
    const cleared: boolean[] = []
    const observers: { disconnected: boolean }[] = []
    const custom: SkinDomLike = {
      ...dom,
      createObserver() {
        const handle = { disconnected: false }
        observers.push(handle)
        return {
          observe: () => undefined,
          disconnect: () => { handle.disconnected = true; disconnected.push(true) },
        }
      },
      setTimer() {
        return { clear: () => { cleared.push(true) } }
      },
    }
    const ctx = new SkinContext({ dom: custom, themeOverride: () => () => undefined, id: 't' })
    ctx.addObserver({}, () => undefined)
    ctx.addTimer(() => undefined, 10)
    ctx.addTimer(() => undefined, 10, { interval: true })
    ctx.dispose()
    expect(disconnected).toHaveLength(1)
    expect(cleared).toHaveLength(2)
  })

  it('dispose 幂等且之后拒绝登记；单个 disposer 失败不阻断其余', () => {
    const dom = fakeDom()
    const ctx = new SkinContext({ dom, themeOverride: () => () => undefined, id: 't' })
    const ran: string[] = []
    ctx.effect(() => () => { ran.push('boom'); throw new Error('boom') })
    ctx.effect(() => () => { ran.push('ok') })
    ctx.dispose()
    ctx.dispose()
    expect(ran).toEqual(['ok', 'boom'])
    expect(() => ctx.addStyle('x')).toThrow()
    expect(ctx.effectCount).toBe(0)
  })

  it('theme.overrideTokens 透传并登记 disposer', () => {
    const dom = fakeDom()
    const { calls, override } = themeRecorder()
    const ctx = new SkinContext({ dom, themeOverride: override, id: 't' })
    const tokens: ThemeTokenOverrides = { '--x': { light: '#fff', dark: '#000' } }
    ctx.theme.overrideTokens(tokens)
    expect(calls.tokens[0]).toBe(tokens)
    ctx.dispose()
    expect(calls.disposed).toBe(1)
  })
})
