# Skin Runtime（apply/dispose/switch/try-on 契约）

## 皮肤入口契约

皮肤包 client/index.js 是 factory-closure（宿主模块表契约）：

```js
window.__ModuleLoader__.load({
  id: "dsh-skin/<skin-id>",
  factory: function () {
    return { apply: function (skinCtx) { /* 只经 skinCtx 产生副作用 */ } };
  },
});
```

apply 返回 void（可 async）；不得保留裸 timer/listener/observer——一切副作用经 SkinContext。

## SkinContext API（皮肤与宿主的唯一接口）

| API | 语义 | dispose 行为 |
| --- | --- | --- |
| effect(fn) | 立即执行，返回的 disposer 登记 | 逆序执行 |
| addStyle(css) | 注入带所有权标记的 style | 移除该 style |
| addElement(el, parent?) | 挂载元素（默认 body） | 移除该元素 |
| addAttribute(target, name, value) | 设置属性（快照旧值） | 恢复旧值或移除 |
| addObserver(target, cb, opts?) | MutationObserver | disconnect |
| addTimer(fn, ms, {interval?}) | setTimeout/setInterval | clear |
| theme.overrideTokens(tokens) | 透传宿主 ctx.theme（source 钉为皮肤 id） | 移除覆盖层 |

dispose 幂等；单个 disposer 失败不阻断其余清理。皮肤不得接触：宿主 ctx/loader/settings/fs/network/凭据。

## apply 生命周期

```text
load（registry 元数据 → bundle 脚本 → 模块物化）
  → SkinContext 创建
  → theme tokens（theme/*.json → overrideTokens）
  → scoped CSS（styles/theme.css → addStyle）
  → body[data-dsh-skin="<id>"]（addAttribute，快照旧值）
  → skin.apply(skinCtx)（try/catch：失败即 dispose 全部 partial effects + invalidate 模块）
  → verify（作用域属性在位）
  → 成功才持久化 activeSkin（绝不先写 settings）
```

## switch / try-on

- switch：dispose 当前 → apply 目标；目标失败清理 partial 并恢复原皮肤；activeSkin 仅目标成功后更新。
- try-on：快照当前 → 临时卸载 → 应用目标（不持久化）→ exit 恢复快照；epoch 代际使旧句柄 exit 成为 no-op（快速连点安全）。
- restoreDefault：dispose 当前 + activeSkin=null。刷新后按 activeSkin bootstrap 恢复；恢复失败保留持久值并显式报错。

## ownership 纪律

- dispose 只清理自己拥有的效果；禁止清空 body、清空全部 style、删除他人 DOM。
- 任意时刻最多一个激活皮肤（E2E 断言零残留：style/属性/chrome/插件样式）。

