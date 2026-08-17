# dsh-skin Phase 0 架构审计（ARCHITECTURE_AUDIT）

> 审计对象：本地 Harness 源码（D:\deepskin\deepseek-harness @ 47f9438 / 0.1.0-rc.5，与生产 checkout D:\deepseek\deepseek-harness 同 commit）。
> 方法：直接读当前源码（packages/**/src），不以 README/历史版本/假设为准。调查性质，无实现产出。
> 证据链：旧笔记 phase0-notes/A~E（本会话早前对同 commit 的审计）+ 本轮对 app-boot/profile.ts、client/modules、host/webserver、host/apiproxy、host/frontend-static、settings/settings、attachment/attachment、llm/llm、bundle/web-app 的逐文件重读。

## 1. Harness 已经有什么（逐题回答，全部有源码出处）

### 1.1 plugin 是怎么加载的（host）
- 入口：profile 目录 `$DSH_HOME/profiles/<name>`，`package.json` 的 `dsh.profile.bundles` 是有序 bundle 列表；另有 `cordis.patch.yml` 用户层（在每层 bundle 之后应用）与启动时重写的 `cordis.yml`。
- bundle = npm 包，`package.json` 的 `dsh.bundle.patch` 指向其 `cordis.patch.yml`（顶层 YAML 数组：id 定向整行覆盖 / insert 列表 / disabled / `!!js` 表达式）。
- 层顺序：空列表 → 逐个 bundle patch（bundles 顺序）→ profile 自身 patch → 启动器层（--patch 等）。
- 出处：`packages/boot/app-boot/src/profile.ts`（loadProfile/resolveProfileDir/PROFILE_TEMPLATES）、`packages/boot/app-boot/src/index.ts`（loadOverlayPatches/parsePatchList）、`vendor/include`（applyEntryPatches，patch 语义）。
- 插件安装：`dsh plugin --profile <name> add <pkg>` 转发给 profile 内 pnpm，并把解析出 `dsh.bundle.patch` 的依赖自动 append 进 bundles（apps/cli/src/plugin.ts）。

### 1.2 client plugin 怎么加载
- host 半（`packages/client/modules/src/index.ts`）扫描 Loader 条目：读每个包的 `dsh.client`（platform/web、inject、immediately）与 `exports["./client"]`，组成 `window.__DSH_BOOT__` 注入 index.html，并注册 `/plugins/<id>/client.js?rev=…` 前缀路由（读磁盘文件）。
- browser 半：经典 `<script>` 加载 bundle；bundle 自调 `window.__ModuleLoader__.load({id, factory})` 注册工厂；首次 import 时物化（memoize），CSS 注入等副作用都在 factory 内。
- 生命周期：vendored Cordis Loader——每包一个 Entry/Fiber，inject 等待、ctx.effect 卸载、FAILED/PENDING 投影；HMR 经 SSE→invalidate→refresh。

### 1.3 bundle 怎么产生
- 官方客户端构建预设：tsdown client face → Node 半 `lib/index.js`（ESM，供 host Loader）+ 浏览器半 `lib/client.js`（CJS + `window.__ModuleLoader__.load` banner/footer，平台模块全部 external）。
- dsh-skin 的 `tsdown.config.ts` 即镜像此形态（PLATFORM_EXTERNALS 与宿主平台模块表一致）。

### 1.4 Web UI extension point 在哪里
- slot 系统（注册/注入）：`ctx.slots.register` / `ctx.slots.inject`；槽目录由 `packages/extensions/cordis-client-runner/src/client/slot-catalog.ts` 编译期生成（settings.plugin.item、settings.plugins.tab、settings.general.item 等），每个出口渲染 `<div data-slot="<key>" style="display:contents">`。
- 主题：`ctx.theme.register(ThemeDefinition)` / `ctx.theme.overrideTokens(source, tokens)`；ui-layout 的 ThemePresenter 把解析结果写 DOM（body 内联 CSS 变量 + body[data-ds-dark-theme]）。
- 设置 UI：ui-settings-plugins 手写 CardForm 绑定 namespace，经 `settings.plugin.item` 槽；插件清单只读（ui-settings-plugin-inventory）。
- 路由：`ctx.webServer.register({kind:'exact'|'prefix', path, handler})` + registerUpgrade/tapIndex；`frontend-static` 占唯一 fallback 座位（SPA：miss→index.html 200，非 GET/HEAD 405，越界 403）。
- 稳定 DOM 面：data-slot 出口、body[data-ds-dark-theme]、--dsw-alias-* CSS 变量；CSS Modules 的 hashed class 不稳定，禁止作皮肤选择器。

### 1.5 Cordis lifecycle 是什么
- 插件 = ESM 导出 `apply(ctx[, config])`（或 Service 子类），可选 `inject`/`name`；配置用 schemastery `Config`。
- `ctx.effect(() => disposer)` 绑定 fiber 生命周期（卸载自动清理）；`ctx.provide/ctx.get/ctx.set` 服务交换；ctx.on 事件。卸载顺序由 Loader fiber 管理。

### 1.6 settings 如何持久化
- `ctx.settings.register(ns, {schema, base})` → `{get, watch, update, replace}`；settings-file 提供者写 `$DSH_HOME/settings.yaml`（withFileLock + 读改写 + writeFileAtomic）。
- **上游缺口（已确认源码）**：浏览器可见 namespace 是 `host/apiproxy/src/api-proxy.ts` 的硬编码 `WEB_SETTINGS_NAMESPACES`（agent-loop/shell/locale/permission/ui-conversation/ui-theme/web-search-deepseek），插件自有 namespace 不暴露；源码注释自认"移动到 settings.register() 是 deferred work"。dsh-skin 因此走 `/dsh-skin/api/active` loopback（仍是官方 settings seam 持久化）。

### 1.7 filesystem service 如何提供
- `ctx.fs`（packages/fs/fs）：resolve → stat/readText/listDir/writeText/editText；写操作被 fs-sandbox 策略围栏；fs-local 提供实现（Windows realpath/ReplaceFileW 细节已处理）。
- 插件也可直接 node:fs（dsh-skin 仓库层即如此）；跨会话自有目录用 storage-domain/storage-json。

### 1.8 patch 是什么
- 见 1.1：顶层 YAML 数组；id 定向**整行覆盖**（config 整体替换、不深合并）、insert 追加、disabled、`!!js` 表达式。每层叠加，后层覆盖前层。

### 1.9 profile 如何工作 / 依赖如何解析
- profile 目录 + 两级解析锚：先 installation（启动器自身包），再 profile 目录（`resolveBundleDir`，用 createRequire 的 resolve.paths 探测，不需要包导出 ./package.json）。
- `healProfilesModuleFallback` 维护 `$DSH_HOME/profiles/node_modules`：app 依赖闭包（BFS deps+peers）每包一个 junction 链接；Node 父目录向上走查保证任意 profile 都能解析内置插件；同时 profile 自身 `node_modules`（pnpm 管）优先。
- Windows：junction（非目录符号链接）是官方选择的链接形态（ensureSymlink 用 `symlinkSync(target, link, 'junction')`）。

## 2. Harness 缺什么（对皮肤系统而言）

1. **没有皮肤概念**：无 skin package/registry/runtime/center；主题只有单一 ui-theme 偏好（light/dark）+ token 覆盖 API（可作皮肤地基，但不是皮肤）。
2. **没有任意全局 CSS 注入服务**：官方 web-styling 规定全局样式只归 ui-theme；插件只能自建 `<style>` 并在 ctx.effect 中清理（dsh-skin 现状）。
3. **没有额外 body 属性 / 装饰 DOM 注入 API**：需自建 + ownership 清理（dsh-skin 现状）。
4. **插件 settings UI 需手写**（非 schema 自动生成）。
5. **插件 namespace 不出现在浏览器 settings 网关**（WEB_SETTINGS_NAMESPACES 硬编码）。
6. **没有皮肤级资产服务**：attachments 是内容寻址图片专用；插件静态资源只能走自己注册的 webServer 路由（dsh-skin 的 /dsh-skin/skins/<id>/files/*）。
7. **视觉验证的浏览器发现不是跨平台**：vision-router 的 vision_html_screenshot 只写死 macOS 路径；Windows 上需自建浏览器发现（dsh-skin 已用 puppeteer-core + Edge 探测解决）。

## 3. 否决门检查（A~D，逐条判定）

### 否决门 A：能否纯插件实现？—— 能，无需改 Harness Core。
- Skin Center/Registry/Runtime/Try-on 全部落在既有扩展点：profile bundles 加载、webServer 路由、slots（settings.plugin.item）、theme.overrideTokens、settings seam（loopback 绕白名单但不动核心）、自管 <style>/属性/DOM 的 ownership 清理。
- v1.0.0 已按此实现并通过生产验证（run-002 A~E）。**结论：不修改 Harness Core。**
- 交叉确认（本轮新审计 webui-dsh-skins-audit.md §5）：同生态参考实现也全部走 insert-only patch + 官方服务消费，无一例修改 Harness Core——纯插件路线是社区共识路径。

### 否决门 B：Skin Runtime 是否能做到 ownership tracking？—— 能。
- v1.0.0 SkinContext 效果面：effect/addStyle/addElement/addAttribute/addObserver/addTimer + theme.overrideTokens，dispose 反向清理并验证（data-dsh-skin 残留检查）；run-002 D 阶段六连切换每步 residue=0（style 计数、body 属性、装饰元素）。
- 已知瑕疵：restore 后瞬时空 `style=""`（刷新消失，非持久）→ 列入 Phase 2 专项测试与修复候选（修复属于 Runtime 强化，不改变冻结语义）。

### 否决门 C：Skin Package 是否独立于 UI？—— 是。
- 包 = manifest.json + theme/{light,dark}.json + styles/theme.css + client/index.js + preview/ + integrity.json；Repository（discover/validate/install/remove）与 Runtime（apply/dispose/switch/tryOn）只通过包目录与 manifest 契约交互；Skin Center 仅调用这两者，不感知 CSS 装载/完整性细节。

### 否决门 D：AI 是否完全成为 Producer？—— 是。
- 生成链（run-001 实证）：Reference Image → Eyes(视觉观察) → DeepSeek(SkinDesignSpec) → codegen(Skin Package) → Repository.install → Runtime.apply。AI 产物只有 Skin Package；AI 不直接改 DOM。
- Vision 保持"Eyes"定位（vision-router 提供能力），DeepSeek 保持"Brain"定位（结构化决策），不把视觉逻辑塞进 Skin Runtime。

## 4. 上游稳定性风险（developer preview）

- 官方 README 明确 developer preview、可能存在 compatibility-breaking changes；上游已确认的 deferred work：settings.register() 驱动浏览器网关暴露（届时 /dsh-skin/api/active loopback 可退役）、settings watcher 卸载 quiescence TODO、dsh-atomic-write 的 Windows ACL TODO。
- 应对：dsh-skin 对上游 API 的接触面已收窄为最小集合（loader 契约 + webServer + slots + theme + settings + llm + attachments），全部在 A~E 审计中留有源码出处；每次上游升级先跑 Phase 5 验收门。

## 5. 结论

- Harness 的插件扩展面足以承载完整皮肤系统，**任何阶段都不需要修改 Harness Core**（否决门 A 通过）。
- dsh-skin v1.0.0 的架构（包/仓库/运行时三层解耦 + AI 生产者链）与本次审计结论一致；Phase 0 不产生新的重构需求。
- 后续工作按 REFERENCE_MAPPING.md（参考系映射）与 IMPLEMENTATION_PLAN.md（契约优先分阶段）执行。
