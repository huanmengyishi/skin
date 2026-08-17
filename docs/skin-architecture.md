# Skin Architecture（最终架构）

DeepSeek Harness 之上一个双面 Cordis 插件 dsh-skin；皮肤是它管理的 Repository Resource，不是 Harness Plugin。

```text
DeepSeek Harness（host + client Cordis 树）
  └─ dsh-skin（唯一插件行，host/client 双面）
       ├─ Skin Repository（host）：discover / install / replace / remove / export
       │    ├─ SkinRegistry（metadata/version/source/state/trust）─ Storage（registry.json 原子写）
       │    └─ Package Store：$DSH_HOME/skins/{builtin(插件内), installed, generated, downloaded, cache, staging}
       ├─ Skin Runtime（client）：load / apply / dispose / switch / try-on / restoreDefault
       │    ├─ SkinContext facade（effect/addStyle/addElement/addAttribute/addObserver/addTimer/theme.overrideTokens）——皮肤与宿主唯一接口
       │    ├─ 加载：host 路由 serve 包文件 → 脚本注册进宿主模块表 sink → import 物化
       │    ├─ Theme 层：theme/{light,dark}.json → ctx.theme.overrideTokens（宿主主题管线）
       │    └─ Structure 层：scope CSS（body[data-dsh-skin=<id>]）+ DOM/chrome/字体（SkinContext 记账）
       ├─ Skin Center（client UI，只经 runtime 服务与 host API）
       ├─ AI Generator（host）：Vision Evidence → SkinDesignSpec → 模板 codegen → 截图 + 像素/指纹双判据迭代 → generated/
       └─ Workshop（host）：search/metadata/download/upload/report（远端协议 v1；安装复用本地管线）
```

## 组件边界（不可违反）

1. Skin Repository 与 Skin Registry 分离；Storage 只是 Registry 的持久化实现。
2. Skin Center 只经 SkinRuntime 服务 / host API 操作，不碰 filesystem/registry/loader。
3. AI Generator 不碰 DOM；只产出 Skin Package。
4. 网络层只做 search/metadata/download/upload；本地 install 语义唯一入口是 repository.install/replace。
5. 皮肤代码永不接收真实 Harness ctx；SkinContext 是唯一运行时接口（见 skin-runtime.md）。
6. activeSkin 持久化走 settings seam（settings.yaml 的 dsh-skin 段；传输经插件 loopback API——宿主 Web settings 网关白名单不含插件 namespace）。
7. 任意时刻最多一个激活皮肤；switch 失败恢复原皮肤；try-on 不落盘、epoch 防竞态。

## 关键宿主事实（审计与实施记录）

- 主题底座：ctx.theme（ThemeRuntime + ThemePresenter：html color-scheme / body[data-ds-dark-theme] / --dsw-* 内联变量），皮肤 token 层进 overrideTokens。
- UI 扩展点：slots（settings.plugin.item 等）+ data-slot 稳定锚点；CSS 选择器禁依赖 hashed class。
- 客户端加载：宿主模块表 sink（window.__ModuleLoader__.load + import/invalidate），皮肤 bundle 为工厂形态，无 externals。
- 持久化：dsh-atomic-write（wx+同目录 rename）+ ctx.fs/fs-local（symlink 拒绝、Win32 DACL 保留）+ settings.yaml。
- 宿主边界发现：Web settings 网关白名单（settings-not-exposed）；WebRoute pathname 无尾斜杠；tsdown 0.22 的 intro 顺序问题——均已插件内适配并记录（见 SKIN_ARCHITECTURE_AUDIT.md §5）。

