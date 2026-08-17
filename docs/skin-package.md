# Skin Package 规范（skinApiVersion = 1）

> 权威契约：本地 / Built-in / AI 生成 / Workshop 下载 的统一交换格式与 SkinRuntime 的运行输入。
> 本文件是 Phase 1 实现并测试通过的规范；实现代码见 src/core/manifest.ts、src/core/integrity.ts、src/repository/*。

## 1. 目录结构

```text
<skin-id>/
├── manifest.json      # 元数据（描述"这是什么 Skin"）
├── theme/
│   ├── light.json     # 亮色 token 覆盖：{ "--dsw-alias-*": "<css值>" }
│   └── dark.json      # 暗色 token 覆盖（键与 light 对齐）
├── styles/
│   └── theme.css      # 结构层样式（必须 scope 化，见 §4）
├── client/
│   └── index.js       # 皮肤入口（factory-closure，导出 apply(skinCtx)，见 §5）
├── assets/            # 图片/字体/SVG（包内相对路径引用；禁止远程 URL）
├── preview/           # 预览图（light.* / dark.*，manifest.preview 指向）
└── integrity.json     # 文件清单 + sha256（首次安装自动生成；存在则必须匹配）
```

## 2. manifest.json（最小字段，Phase 1 强制）

| 字段 | 类型 | 规则 |
| --- | --- | --- |
| id | string | /^[a-z0-9][a-z0-9-]{0,63}$/，禁保留字（default/official/harness/system/theme/skin/dsh-skin/none/null/undefined/builtin/local 等，见 src/core/manifest.ts RESERVED_SKIN_IDS） |
| version | string | SemVer x.y.z[-prerelease] |
| name | string | 非空，≤64 字符 |
| author | string | 非空 |
| description | string | 非空，≤512 字符 |
| tags | string[] | 每项 /^[a-z0-9][a-z0-9-]{0,31}$/，最多 16 个 |
| skinApiVersion | number | 必须 = 1（本插件实现并维护；与 Harness 版本、包版本三线分治） |
| preview | { light?, dark? } | 包内相对路径（禁绝对路径/盘符/协议 URL/.. 穿越/反斜杠） |

未知字段一律放行（保留给 dependencies/license/source/compatibility 等后续阶段）；v0.1.0 核心 Runtime 不依赖它们。

## 3. Theme Layer（theme/*.json）

- 两份 JSON 都是 `{ token名: css值 }`；运行时合并为宿主 ThemeRuntime.overrideTokens 所需的 `{ token: { light, dark } }`。
- 只保留两侧都存在且均为字符串的键；键名建议用宿主语义 token（--dsw-alias-bg-base、--dsw-alias-label-primary、--dsw-specific-sidebar-fill 等 13 个官方可覆盖名 + 需要的动态 token）。
- 结构层样式/字体/布局不写进 theme/——它们属于 styles/ 与 client/。

## 4. Structure Layer（styles/theme.css）

- 所有选择器必须以 `body[data-dsh-skin="<id>"]` 开头（皮肤唯一 scope，由 SkinRuntime 在 apply 时设置、dispose 时恢复）。
- 只使用稳定锚点：body 作用域属性、`data-slot="<key>"`、元素类型、`body[data-ds-dark-theme]`、`--dsw-*` 变量。禁止依赖宿主 hashed CSS class 与组件内部结构。
- 禁止 `!important` 全屏压制、禁止触碰 `html`/`head` 全局、禁止清空或改写其他插件的样式。

## 5. Client 入口（client/index.js）

- 形态：factory-closure（宿主模块表契约）：
```js
window.__ModuleLoader__.load({
  id: 'dsh-skin/<skin-id>',
  factory: function () {
    return { apply: function (skinCtx) { /* 只经 skinCtx 产生副作用 */ } };
  },
});
```
- 皮肤代码不接收真实 Harness ctx；唯一接口是 apply 收到的 SkinContext：
  effect(fn) / addStyle(css) / addElement(el, parent?) / addAttribute(target, name, value) / addObserver(target, cb, options?) / addTimer(fn, ms, {interval?}) / theme.overrideTokens(tokens)。
- 所有副作用由 SkinContext 记账，dispose 逆序回收；皮肤不得持有自己的裸 timer/listener/observer。

## 6. integrity.json

- 结构：`{ "algorithm": "sha256", "files": [{ "path", "size", "sha256" }] }`（path 为 '/' 分隔的包内相对路径，排序稳定；不含 integrity.json 自身）。
- 安装：staging 复制后二次校验——存在则必须匹配（缺失/篡改/多余均拒绝）；不存在则由安装流程生成。

## 7. 安装管线（SkinRepository）

```text
source dir
  → 源 manifest 校验 + id 规则 + 重复检测
  → staging 复制（拒绝 symlink / 路径穿越）
  → staged 二次校验 + integrity
  → atomic rename → $DSH_HOME/skins/installed/<id>/
  → registry 刷新 + 持久化
任何失败：清理 staging，不落半成品；uninstall = rename 到 staging 垃圾桶再删除。
```

## 8. 运行时闭环

```text
SkinManifest → discover（builtin + installed）→ validate → load（模块表 sink + import）
→ apply（theme tokens → scoped CSS → body[data-dsh-skin] → skin.apply(skinCtx) → verify）
→ dispose（逆序回收 + invalidate + 残留样式兜底清理）→ 任意时刻最多一个激活皮肤。
```

完整作者指南（第三方开发者版）随 Phase 2 交付为 docs/skin-authoring.md。

