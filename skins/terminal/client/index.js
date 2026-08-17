// Phosphor Terminal 皮肤入口：factory-closure 形态。
// 只使用 SkinContext API 产生可追踪副作用；不接触宿主 ctx / settings / loader。
window.__ModuleLoader__.load({
  id: 'dsh-skin/terminal',
  factory: function () {
    function makeChrome(tag, chromeName, text) {
      var el = document.createElement(tag);
      el.dataset.skinChrome = chromeName;
      if (text !== undefined) el.textContent = text;
      return el;
    }
    return {
      apply: function (ctx) {
        // 1) CRT 扫描线覆盖层（纯装饰，pointer-events: none）
        ctx.addElement(makeChrome('div', 'terminal-scanlines'), document.body);
        // 2) 底部终端状态栏 + 呼吸光标
        var bar = makeChrome('div', 'terminal-statusbar');
        var label = document.createElement('span');
        label.textContent = 'PHOSPHOR OS 1.0 \u00b7 SKIN terminal \u00b7 READY';
        bar.appendChild(label);
        var cursor = document.createElement('span');
        cursor.textContent = '\u2588';
        cursor.style.color = '#33ff66';
        bar.appendChild(cursor);
        ctx.addElement(bar, document.body);
        // 3) 发光属性（CSS 以它开启 inset glow）
        ctx.addAttribute(document.body, 'data-dsh-skin-glow', 'on');
        // 4) 光标闪烁定时器（dispose 时自动 clear）
        ctx.addTimer(function () {
          cursor.style.visibility = cursor.style.visibility === 'hidden' ? '' : 'hidden';
        }, 530, { interval: true });
      },
    };
  },
});
