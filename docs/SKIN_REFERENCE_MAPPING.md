# SKIN_REFERENCE_MAPPING — dsh-web-ui 机制 → DeepSeek Harness 当前机制

> Phase 0 交付物。宿主以 D:\deepskin\deepseek-harness @ 47f9438（0.1.0-rc.5）实际源码为准；
> dsh-web-ui 以 D:\deepseek\dsh-web-ui 源码检出为准（细节见 phase0-notes/D-*.md）。
> 原则：复用思想，不复制实现；发现底层机制不同时，不强行照搬。

## 1. 主映射表

| dsh-web-ui 机制 | Harness 当前机制（实测） | dsh-skin 实现方案 |
| --- | --- | --- |
| skin.json（单一事实源） | 无皮肤清单概念；配置 schema 惯例是 zod/schemastery + settings register（dsh-settings） | 定义 SkinManifest（zod schema + 校验器），skin.json/ manifest.json 为皮肤包内唯一事实源；repository 读取并缓存 |
| skin registry | 有通用注册表先例：ctx.theme.register()（主题注册表，重复 id 抛错、返回 disposer）；plugin-inventory 只读投影 Loader 树 | 新建 ctx.skinRegistry Cordis 服务（SkinRepository 的一部分）：discover/register/list/duplicate 检测；服务即注册表，disposer 即反注册 |
| 皮肤=独立 npm 包 + insert 行（ui-skin-<id>） | dsh.client 行=browser roster，由 client-modules node 半扫描并 serve /plugins/<id>/client.js；新包名缓存后重启才生效（README） | 皮肤=仓库内资源包（manifest + styles + assets + client bundle + preview），不经 Loader 花名册；dsh-skin host 半经 ctx.webServer.register 提供 /dsh-skin/skins/<id>/client.js 等路由 |
| 互斥启用（dsh-skin use 写 ~/.dsh/cordis.patch.yml managed 区段） | patch 层 + watchUserPatches 热重载确实存在（app-boot README:45）；但 patch 是组合配置不是用户数据 | 互斥由 SkinRuntime 保证：任意时刻一个激活皮肤；激活态写入 settings namespace（settings.yaml，原子写+revision 冲突处理）；不再对 patch 文件做每次切换手术 |
| skin-center（client 插件 + host /api/skin-center） | client 插件形态：dsh.client{inject,platform,immediately}+exports ./client；UI 扩展点：slots（settings.section / settings.plugins.tab / sidebar.settings / settings.general.item）；host HTTP：ctx.webServer.register(route) | dsh-skin 双面插件：client 半注册 Skin Center 页（settings.section 或独立面板）；host 半提供 /dsh-skin/* API（list/apply/tryon/install/…），UI 只经 API/service 操作 |
| try-on（GUI 内执行真实 bundle，退出全量恢复） | ctx.theme.overrideTokens(source, tokens) 返回 disposer 的“覆盖层”语义（堆叠、后层胜、移除恢复）正是 token 级试穿原语；主题 DOM 投影（ThemePresenter）只收回自己写过的东西 | try-on = overrideTokens(皮肤 token 层) + 皮肤自有 scoped <style>/DOM/attr 层 + epoch/generation 防竞态；退出=dispose 全部 owned effects 并恢复快照；不写持久配置 |
| apply/restore（皮肤 bundle 应用与卸载） | 注册即效果、disposer 即回收（ctx.effect）；ThemePresenter.dispose() 是 ownership discipline 范本 | SkinRuntimeContext.addStyle/addElement/addAttribute/addObserver/addTimer/effect 全部返回 disposer；apply 记录 owned 清单，dispose 只清 owned；失败清理 partial effects |
| 作用域 bodyAttr（data-dsh-xxx） | 宿主已有 body[data-ds-dark-theme]（暗色）与 --dsw-* token 体系；web-styling.md 规定样式所有权 | 每皮肤唯一 scope：body[data-dsh-skin="<id>"] + CSS 变量命名空间（皮肤前缀）；皮肤 CSS 以 scope 选择器限定；token 覆盖走 ctx.theme |
| CSS 构建 / bundle 构建（build.mjs + tsdown） | 官方构建：tsdown clientBundle 预设（factory closure + lightningcss CSS Modules + externals=loader 模块表 + data-plugin style 标签）；CSS 权威=ui-theme/src/styles 的 --dsw-* | 复用官方 tsdown clientBundle 构建 dsh-skin 自身；皮肤包构建用独立 build 脚本产出 ES module bundle + 样式（不加入插件模块表，由 SkinRuntime 动态 import）；皮肤不得另立全局主题（web-styling 规定） |
| preview（每皮肤 light/dark 截图） | 宿主无产品级预览机制；vision-router 有 vision_html_screenshot（puppeteer） | 阶段一：包内静态 preview 图（构建时生成或手作）；阶段二：vision_html_screenshot 生成/验证；皮肤中心只读展示 |
| 本地仓库（皮肤资产内置于 dsh-skins/skins/） | 用户数据根=resolveDshHome（~/.dsh 或 $DSH_HOME）；storages/ 由 storage-json 管（root: dshHomePath('storages')）；atomic-write 提供跨进程原子写+锁 | SkinRepository 目录：<DSH_HOME>/skins/{registry.json, installed/, generated/, downloaded/, cache/, staging/}；安装=staging→validate→integrity→atomic rename；registry.json 经 writeFileAtomic+withFileLock |
| dsh-skin use CLI（写 patch、幂等） | 官方无皮肤 CLI；有 Loader 组合与 patch 层可用，但不适合每皮肤一行 | dsh-skin 提供少量管理命令（可选）；主交互在 Skin Center；CLI 只调同 host 服务，不直接改 patch |
| npm 分发（aggregate.yml 聚合） | 官方分发=bundle 包 + dsh 字段（bundle.patch / client / profile） | dsh-skin 单包分发（含内置皮肤资产）；第三方皮肤= .skinpackage zip（统一 Skin Package），安装进仓库而非 npm |

## 2. 机制分歧记录（Original assumption / Actual / Adaptation / Reason）

### D1. 皮肤是否需要成为 Cordis 插件行
- 原始假设（dsh-web-ui 做法）：每个皮肤一个 npm 包 + insert 行（ui-skin-<id>）+ home patch disabled 互斥。
- Harness 实际机制：dsh.client 行构成 browser roster；client-modules 对包名元数据缓存“永不过期、新包重启生效”；条目在 boot 时组合，运行期只能经 patch 热重载增删（watchUserPatches）。
- 适配：dsh-skin 自身是一个 Cordis 双面插件（一行）；皮肤是仓库管理的资源包，host 经自有 HTTP 路由提供其 client bundle，浏览器以原生 dynamic import() 加载（URL 带内容 hash），不注册进插件模块表。
- 理由：a) 皮肤安装/卸载/AI 生成要求原子仓库语义，npm+patch 行无法满足；b) 避免对 profile/patch 做每皮肤手术，宿主组合保持稳定；c) 统一 Skin Package（Built-in/Local/AI/Downloaded）需要同一加载通道；d) 皮肤是 untrusted 代码，不应与受信插件同享 ctx。

### D2. 试穿的实现载体
- 原始假设（dsh-web-ui）：临时挂载皮肤 client bundle、退出卸载。
- Harness 实际机制：ctx.theme.overrideTokens(source,tokens)→disposer 是现成的“临时覆盖层”原语；主题 DOM 投影与 token 表分离；bundle 卸载回收 style 标签由 HMR 记账。
- 适配：试穿分两层——token 层走 overrideTokens（宿主原语）；完整层（额外 CSS/DOM/属性/字体）走 SkinRuntime 自有 disposable layer；epoch 防快速连点竞态。
- 理由：最大程度复用宿主主题管线（深浅色、持久化、事件），同时不污染 ctx.theme 注册表（试穿不改变偏好）。

### D3. 激活状态的持久化位置
- 原始假设（dsh-web-ui）：写 ~/.dsh/cordis.patch.yml managed 区段。
- Harness 实际机制：官方持久化路径是 settings（settings.yaml，原子写、revision 冲突、跨进程锁、外部编辑热发布）与 storage-domain；patch 文件是“组合配置”，watchUserPatches 是它被误用为状态的隐患（非事务、无冲突处理）。
- 适配：dsh-skin 注册 settings namespace（activeSkin/preferences），SkinRuntime 订阅；仓库内容不进 settings。
- 理由：状态与组合分离；settings API 提供冲突检测与回滚语义（SETTINGS_CONFLICT），符合“失败回滚”纪律；远程浏览器只读进程内存的已知限制与宿主一致。

### D4. 皮肤样式与宿主主题的关系
- 原始假设（dsh-web-ui）：皮肤自己把 bodyAttr + 全量 CSS 贴上去。
- Harness 实际机制：--dsw-* 静态刻度+alias 语义层是唯一颜色权威（ui-theme）；特征组件只消费语义 alias；全局样式归 ui-theme；第三方主题=alias token 覆盖（README 明确“扩展点不是产品”）。
- 适配：皮肤分成两层——(1) token 覆盖（进 ctx.theme 管线，自动获得深浅色切换与 presenter 投影）；(2) 结构性皮肤（字体/圆角/背景/装饰/DOM chrome）经 scope 选择器的皮肤样式层。两层都随 apply/dispose 生命周期走。
- 理由：不破坏宿主 token 契约，同时证明 Skin API 能承载“真正复杂的 UI Skin”（布局/背景/字体的需求远超 token 覆盖）。

### D5. Windows 与原子性
- 原始假设：需要自行处理 junction/symlink/rename 陷阱。
- Harness 实际机制：dsh-atomic-write 提供 wx+同目录 rename（防 symlink hijack；README 承认未 fsync 为已知限制）；ctx.fs.lstat 专为拒绝仓库内 symlink 而设计；profiles/node_modules 平铺链接由 healProfilesModuleFallback 维护（Windows 已量产）；sandbox-windows-acl 限制写范围。
- 适配：仓库 IO 全部经 ctx.fs + dsh-atomic-write；安装目录校验拒绝 symlink/路径穿越；Windows 用 rename 语义与平铺链接，不需要自建 junction。
- 理由：宿主已提供跨平台原子原语，重复造轮子违反“优先复用”纪律；皮肤仓库属于 $DSH_HOME 之下，天然避开权限敏感区。

### D6. 视觉能力归属（第二阶段）
- 原始假设：皮肤插件自己实现视觉分析/截图。
- 实际机制：dsh-vision-router 已提供 vision_describe/colors/trace/extract_foreground/crop/ground/pixel_diff/html_screenshot 全套（见 phase0-notes/E-*.md）；Vision=Eyes、DeepSeek=Brain。
- 适配：dsh-skin 只做“结构化 SkinDesignSpec + 生成/验证循环编排 + 迭代上限 + 工件落盘”；视觉调用全部经 vision-router 工具；缺失时第二阶段入口显式报缺，不伪造。
- 理由：目标.md 明确禁止重造 vision model；保持单一眼睛。

## 3. 结论性判断

- dsh-web-ui 的皮肤链（skin.json→registry→bundle→center→try-on→apply→dispose）在 Harness 上每一环都有对应机制，但对应物与 dsh-web-ui 的实现载体不同：宿主把“组合配置（patch/loader）”与“用户数据（settings/storage）”分得很清，皮肤属于后者。
- 因此 dsh-skin 的架构基调：**一个 Cordis 插件作为宿主公民；皮肤作为该插件域内的资源实体；Runtime 复用 ctx.theme + slots + 自有 disposable 层；Repository 复用 settings/storage/atomic-write/fs；UI 复用 slots/设置页/自有路由。**

