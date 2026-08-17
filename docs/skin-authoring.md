# Skin Authoring（第三方开发者指南）

无需阅读 dsh-skin 内部源码即可开发自己的皮肤。皮肤 = 一个目录（Skin Package），格式见 skin-package.md。

## 最小示例（id: my-skin）

```text
my-skin/
├── manifest.json
├── theme/light.json
├── theme/dark.json
├── styles/theme.css
├── client/index.js
└── preview/light.svg   （可选 dark.svg）
```

manifest.json：
```json
{
  "id": "my-skin",
  "version": "1.0.0",
  "name": "My Skin",
  "author": "you",
  "description": "说明文字",
  "tags": ["minimal"],
  "skinApiVersion": 1,
  "preview": { "light": "preview/light.svg" }
}
```

theme/light.json 与 dark.json（键对齐；值分别为两种配色）：
```json
{ "--dsw-alias-bg-base": "#0b120b", "--dsw-alias-brand-primary": "#33ff66", "--dsw-alias-label-primary": "#b8ffc8" }
```

styles/theme.css（所有选择器必须以你的 scope 开头；只依赖稳定锚点 data-slot 与 --dsw-* 变量）：
```css
body[data-dsh-skin="my-skin"] {
  background: var(--dsw-alias-bg-base);
  font-family: "Cascadia Mono", Consolas, monospace;
}
body[data-dsh-skin="my-skin"] [data-slot="sidebar"] {
  border-right: 1px solid var(--dsw-alias-border-l1);
}
```

client/index.js（工厂形态；只经 skinCtx 产生副作用）：
```js
window.__ModuleLoader__.load({
  id: "dsh-skin/my-skin",
  factory: function () {
    return {
      apply: function (skinCtx) {
        var bar = document.createElement("div");
        bar.textContent = "MY SKIN";
        bar.style.cssText = "position:fixed;bottom:0;left:0;right:0;padding:2px 8px;background:#111;color:#3f3;z-index:2147483000;font:11px monospace;";
        skinCtx.addElement(bar, document.body);
      },
    };
  },
});
```

## 规则速查

- id：/^[a-z0-9][a-z0-9-]{0,63}$/ 且非保留字（default/official/harness/system/theme/skin/dsh-skin/none/null/undefined/builtin/local）。
- 禁止：包内绝对路径/../反斜杠、symlink、可执行文件（exe/bat/ps1…）、css/js 内 http(s) 远程资源、未 scope 化的选择器、hashed class 依赖。
- 集成：把包目录放进 $DSH_HOME/skins/installed/<id>/ 即被自动发现；或经 Skin Center 的 host API 安装（同源 loopback）。
- 验证：安装时自动做 manifest/安全门/完整性校验；试穿与应用走与内置皮肤完全相同的 Runtime。

