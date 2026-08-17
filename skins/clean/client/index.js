// clean 皮肤入口：factory-closure 形态，只导出 apply(skinCtx)。
// 本皮肤不添加任何 DOM chrome——结构层由 styles/theme.css 与 theme tokens 承担。
window.__ModuleLoader__.load({
  id: 'dsh-skin/clean',
  factory: function () {
    return {
      apply: function () {
        // 无额外副作用：作用域属性与样式由 SkinRuntime 分层应用
      },
    }
  },
});
