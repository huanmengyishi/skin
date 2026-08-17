/**
 * 预览页构建：把皮肤包（token + css + client bundle）渲染成一个自包含 HTML，
 * 供无头浏览器截图（视觉验证）使用。不依赖宿主 shell / 模块表。
 * @module dsh-skin/src/generator/render
 */

export interface PreviewSkinInput {
  id: string
  name: string
  tokens: { light: Record<string, string>; dark: Record<string, string> }
  css: string
  clientJs: string
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** 构建自包含预览 HTML（inline 一切，file:// 可开）。 */
export function buildPreviewHtml(skin: PreviewSkinInput): string {
  const lightVars = Object.entries(skin.tokens.light).map(([name, value]) => name + ':' + value + ';').join('')
  const scope = skin.id
  const shim = [
    'window.__ModuleLoader__ = { load: function (handoff) { window.__skinFactory = handoff.factory; } };',
    'window.__skinEffects = [];',
    'window.__skinCtx = {',
    '  effect: function (fn) { var d = fn(); if (typeof d === "function") window.__skinEffects.push(d); },',
    '  addStyle: function (css) { var s = document.createElement("style"); s.textContent = css; document.head.append(s); window.__skinEffects.push(function () { s.remove(); }); },',
    '  addElement: function (el) { document.body.append(el); window.__skinEffects.push(function () { el.remove(); }); },',
    '  addAttribute: function (target, name, value) { var had = target.hasAttribute(name); var prev = target.getAttribute(name); target.setAttribute(name, value); window.__skinEffects.push(function () { if (had) target.setAttribute(name, prev); else target.removeAttribute(name); }); },',
    '  addObserver: function () { return { observe: function () {}, disconnect: function () {} }; },',
    '  addTimer: function () { return { clear: function () {} }; },',
    '  theme: { overrideTokens: function () {} },',
    '};',
    'document.body.setAttribute("data-dsh-skin", "' + scope + '");',
  ].join('\n')
  const mock = [
    '<div data-slot="sidebar" style="position:fixed;left:0;top:0;bottom:0;width:220px;padding:16px;box-sizing:border-box;">',
    '  <div style="font-weight:700;margin-bottom:16px;">' + escapeHtml(skin.name) + '</div>',
    '  <div style="height:28px;margin-bottom:8px;opacity:0.8;">工作区</div>',
    '  <div style="height:28px;margin-bottom:8px;opacity:0.6;">会话 1</div>',
    '  <div style="height:28px;opacity:0.6;">会话 2</div>',
    '</div>',
    '<div data-slot="conversation" style="position:fixed;left:220px;right:0;top:0;bottom:0;padding:24px;overflow:auto;">',
    '  <div style="max-width:640px;margin-bottom:16px;padding:14px;border-radius:8px;">消息卡片：你好，这是皮肤预览。</div>',
    '  <div style="max-width:640px;margin-bottom:16px;padding:14px;border-radius:8px;"><code>code block: skin preview</code></div>',
    '  <div style="max-width:640px;padding:14px;border-radius:8px;">输入区：',
    '    <input placeholder="输入消息…" style="width:60%;margin:8px 8px 0 0;padding:6px;" />',
    '    <button style="padding:6px 14px;">发送</button>',
    '  </div>',
    '</div>',
    '<div data-slot="shell.overlay" style="position:fixed;right:24px;top:24px;width:280px;padding:14px;border-radius:8px;">',
    '  <div style="font-weight:700;">弹层</div><div>modal 预览</div>',
    '</div>',
  ].join('\n')
  const vars = Object.entries(skin.tokens.dark).map(([name, value]) => name + ':' + value + ';').join('')
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    '<style>',
    'body { margin:0; padding:0; background: var(--dsw-alias-bg-base, #10131a); color: var(--dsw-alias-label-primary, #e8f0e8); font-family: sans-serif; }',
    'body[data-ds-dark-theme] { color-scheme: dark; }',
    '</style>',
    '</head><body data-ds-dark-theme=""><script>',
    shim,
    '</script>',
    '<style>' + escapeHtml(skin.css) + '</style>',
    mock,
    '<script>' + skin.clientJs + '</script>',
    '<script>',
    'document.body.style.setProperty("--unused", "x");',
    'var names = ' + JSON.stringify(Object.keys(skin.tokens.dark)) + ';',
    'names.forEach(function (n) { var v = ' + JSON.stringify(skin.tokens.dark) + '[n]; document.body.style.setProperty(n, v); });',
    'if (window.__skinFactory) { var mod = window.__skinFactory(); if (mod && mod.apply) mod.apply(window.__skinCtx); }',
    '</script>',
    '</body></html>',
  ].join('\n')
}
