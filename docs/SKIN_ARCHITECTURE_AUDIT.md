# SKIN_ARCHITECTURE_AUDIT — DeepSeek Harness 皮肤系统架构审计

> Phase 0 交付物之一。审计对象（全部真实源码，非 README 转述）：
> - 宿主：D:\deepskin\deepseek-harness @ 47f9438（upstream master，0.1.0-rc.5，developer preview）
> - 参考：dsh-web-ui 源码检出 D:\deepseek\dsh-web-ui + 已安装产物 ~/.dsh/profiles/node_modules/@linxin666/dsh-skins
> - 参考：dsh-vision-router@1.1.1（~/.dsh/profiles/web/node_modules/dsh-vision-router）
> - 运行实例：~/.dsh（profiles/web、settings.yaml、cordis.patch.yml、storages/）
> 证据链：本文件每条结论均可在 phase0-notes/ 的 A~E 笔记与源文件行号处复核。

## 0. 结论摘要（20 条）

1. 宿主是 Cordis 驱动的 Everything-is-a-Plugin 架构；没有特权 core 可 patch，插件通过 profile（$DSH_HOME/profiles/<name>）里的 bundle 列表 + cordis.patch.yml 层叠组合成树（docs/architecture.md §Profiles）。
2. Web UI 加载链路：dsh-web-app bundle 组装 host 行（webserver/api-gateway/frontend-static）与浏览器插件花名册 → client-modules 的 node 半扫描带 dsh.client 声明的包、计算内容 hash、把 window.__DSH_BOOT__ 注入 index.html、以 /plugins/<id>/client.js 提供 bundle → 浏览器 shell（apps/web，Vite 产物）解析 boot manifest、构造懒 CJS 模块表、Cordis Loader 挂载 client 插件树。
3. 插件包形态：package.json 的 "dsh" 字段（bundle.patch / client.inject / client.platform / client.immediately / profile.bundles）；client 插件 exports ./client，产物是 factory closure（window.__ModuleLoader__.load({id,factory})），CSS Modules 由 lightningcss 内联并在 materialize 时注入 style[data-plugin]。
4. patch 机制：按行 id 定位、整行 config 替换（不深合并）、insert 加行、disabled 开关、!!js 表达式；层序=bundles → profile cordis.patch.yml → home cordis.patch.yml → --patch overlay；watchUserPatches 热重载（失败保留旧树并广播 hmr/config-update-failed）。
5. 宿主已有完整主题机制（远超预期）：dsh-client-ui-theme 提供 ctx.theme（ThemeRuntime：light/dark 内建 + 第三方 ThemeDefinition.register() + overrideTokens() 覆盖层 + setTheme/getTheme + theme/change），ui-layout ThemePresenter 把它投影到 html color-scheme / body[data-ds-dark-theme] / body 内联 --dsw-* 变量 / meta theme-color，且只收回自己写过的东西（ownership discipline 的现成范本）。
6. 已有 CSS 注入机制（半套）：插件 bundle 的 CSS Modules 自动注入并随卸载回收；但"任意全局 CSS/字体/额外 body 属性"没有公开 API——这正是皮肤插件的核心缺口，需自建带 disposer 的 SkinStyleInjector。
7. UI 扩展点完备：ctx.slots（register/inject，data-slot 稳定锚点）、settings 槽位体系（settings.section/settings.general.item/settings.plugin.item/…）、ctx.theme、ctx.settingsScope、ctx.locale、ctx.inputTriggers；无 client 路由 API（组合即 slot）。皮肤中心的 UI 100% 可由槽位实现，不需要改 core。
8. 持久化机制完备：ctx.settings（namespace+schema，settings.yaml 原子写、跨进程锁、revision 冲突拒绝、外部编辑热发布）与 ctx.storageDomain（defineDomain/open 的 domain KV，json 后端根=dshHomePath('storages')）双轨可用；用户数据根=resolveDshHome（显式 > $DSH_HOME > ~/.dsh）。
9. 文件系统与原子性：ctx.fs 抽象（readText/write/lstat…）+ dsh-atomic-write（wx 随机后缀同目录 rename、防 symlink hijack、withFileLock 跨进程锁，注明未 fsync 为已知限制）；ctx.fs.lstat 专为拒绝仓库内 symlink 而设计。皮肤仓库的 atomic install/uninstall 有官方原语可用。
10. HTTP 能力：出站 web-fetch-http；入站 ctx.webServer.register(route)/registerUpgrade/registerFallback/tapIndex（重名抛错、返回 disposer）——第三阶段 Workshop 与第二阶段皮肤包路由都走它（dsh-web-ui 的 /api/skin-center 与 vision-router 的探针路由都是先例）。
11. Windows 事实：sandbox-windows-acl 用 WRITE_RESTRICTED token 限定 workspace-write/read-only；profiles/node_modules 平铺链接（symlink，权限不足回退 junction 是 dsh-web-ui 做法，宿主自身 healProfilesModuleFallback 维护链接）；atomic-write 的 rename 语义 Windows 可用；未发现宿主禁止 junction/symlink 的硬限制，仓库文件用 lstat 防链接攻击即可。
12. 动态皮肤包：Loader 组合在 boot 时定型（包名元数据缓存永不过期、新包重启生效）；运行期唯一入口是 patch 热重载（watchUserPatches）。结论：皮肤不应走"每皮肤一个 Cordis 行"（dsh-web-ui 模式），而应走"dsh-skin 单插件 + 仓库资源包 + 自有 /dsh-skin/* 路由 + 浏览器原生 import()"（详见 §25 与 mapping D1）。
13. 懒加载：client module loader 本身就是懒 CJS 表（factory 注册/materialize 分离、boot graph 行按需 fetch）；但 graph 行集合在构造时冻结，运行时不能注册新插件 id——皮肤代码加载用原生 dynamic import()（带内容 hash URL），不新造模块加载器。
14. try-on 完全可行且优于 dsh-web-ui：token 层用 ctx.theme.overrideTokens（disposer 即回滚）；结构层（全局 CSS/DOM/属性）用自建 disposable layer + epoch 代际计数（dsh-web-ui TryOnController 的快照/回收/epoch 思想保留，但换掉其私有全局 __DSH_MODULES__ 依赖）。
15. dsh-web-ui 的完整链路（skin.json→registry→patch 互斥→center→try-on→apply→dispose）每一环在宿主都有对应机制，但对应物载体不同：宿主严格区分"组合配置（patch/loader）"与"用户数据（settings/storage）"，皮肤属于后者；照搬 dsh-web-ui 的 patch 文本手术 + 每皮肤 npm 包是错误适配（详见 SKIN_REFERENCE_MAPPING.md）。
16. vision-router 提供第二阶段全部"眼睛"：vision_describe(json)→{summary,layout,entities,text}、vision_colors、vision_ground/detect/crop、vision_ocr、vision_trace、vision_extract_foreground、vision_pixel_diff（自研 sharp 逐像素算法：diffRatio+worstRegions+热力图+报告）、vision_html_screenshot。两处硬缺口：html_screenshot 的 Chrome 探测只写死 3 个 macOS 路径（Windows 必败）；describe 的通用 JSON 不含皮肤领域字段。dsh-skin 自建：SkinDesignSpec schema、生成器、迭代控制、跨平台浏览器发现、GUI 截图夹具。
17. 视觉依赖检测的可靠信号：ctx.llm.listProviders() 含 vision-http 或 ctx.llm.registration('vision-http') 不抛错（ToolRuntime 无公开 list/has，勿用 ctx.tools.has）。
18. 测试体系：vitest 单测（jsdom 用 client-test-runtime）+ Playwright Chromium 真实浏览器 e2e（apps/web/tests，DIST_INDEX 起真实 dsh web，page.screenshot 证据先例）——dsh-skin 的 E2E 与视觉验证可直接沿用该模式；现有门禁无像素比对测试，需自建。
19. 无需修改 Harness core：本插件需要的一切（UI、主题、持久化、存储、HTTP、构建、测试）都在公开插件边界内；唯一的"低层"工作是浏览器 DOM 注入（style/属性/字体），属于插件自管副作用，不是 core 修改。
20. 架构基调（采纳建议）：dsh-skin=一个双面 Cordis 插件（host: SkinRepository 服务+HTTP 路由+settings namespace；client: SkinRuntime+Skin Center UI）；皮肤=仓库内统一 Skin Package（manifest/styles/assets/client bundle/preview/integrity），Built-in 随插件内置、Local/AI/Downloaded 进仓库；激活=settings 持久 + 运行时互斥；skinApiVersion=1 与宿主版本、皮肤包版本三线分治。

## 1. 逐题回答（对应任务书 §40 的 25 问）

### Q1. Harness 当前 Web UI 是如何加载的？

链路（全部实测）：
1. dsh --profile web 启动 → app-boot 按 profile 组合 Cordis 树：dsh-base（平台底座）→ dsh-web-app（浏览器表面 bundle）。
2. dsh-web-app 的 cordis.patch.yml 插入 host 行：webserver（dsh-host-webserver，node:http，默认 127.0.0.1:3080）、api-gateway（host-apiproxy，/api 桥）、web-runtime（解析 @deepseek-ai/dsh-web-frontend 的构建产物 dist 并安装 frontend-static 为 SPA fallback owner）、client-hmr，以及全部浏览器插件花名册行（dsh.client 行）。
3. client-modules 的 node 半扫描 Loader entries 中带 dsh.client 声明的包，解析 exports["./client"] 的构建产物，计算内容 hash，组成 window.__DSH_BOOT__（{rev, entries:[{id,url:'/plugins/<id>/client.js?rev=…',rev,inject,immediately}]}），通过 webServer.tapIndex 注入 index.html，并把 bundle+sourcemap 以 /plugins/<id>/client.js 提供。
4. 浏览器打开 → apps/web 的 Vite 产物（dist/index.html + assets）由 frontend-static 作为 fallback 返回 → main.ts 取 #root → AppWebEntry（packages/client/web/src/boot.tsx）解析 __DSH_BOOT__、构造 ClientModuleSystem（懒 CJS 表）、渲染 loading gate、把模块系统交给 Cordis Loader（loader.internal=modules）、建 entries、loader.await() settle → ctx.appShell.renderApp() 渲染 ctx.slots.renderSlot("root")。
证据：bundle/web-app/README.md、bundle/web-app/cordis.patch.yml（roster 注释）、client/modules/README.md、client/modules/src/index.ts、client/web/src/boot.tsx、host/frontend-static、host/webserver README。

### Q2. Web client plugin 如何注册？

- 一个 client 插件 = 一个 npm 包声明 dsh.client（package.json "dsh": {"client": {inject:[…], platform:"web", immediately?}}）+ exports["./client"] 指向构建产物。
- 注册=在组合树里出现一行（bundle patch insert 或用户 patch insert 均可）：dsh.client 行即浏览器花名册，node 半把它扫进 __DSH_BOOT__；browser 半把该 id 的 bundle 注册为模块表 factory，Cordis Loader 把每行当一个 plugin entry 建 fiber（inject 依赖等待、生命周期、更新/刷新都由 Loader 治理）。
- 浏览器插件 apply(ctx) 通过声明合并提供/消费 ctx 服务（如 ctx.theme、ctx.slots）。
证据：client/ui-theme/package.json（dsh 块）、bundle/web-app/cordis.patch.yml、client/modules/src/index.ts（扫描与 compose）、cordis-primer.md。

### Q3. browser bundle 如何生成？

- 官方构建：tsc -b tsconfig.client.json 产 lib/types → tsdown --env.DSH_BUILD_FACE client；每个 client 包用 packages/client/tsdown.client.ts 的 clientBundle() 预设。
- 产物形态：factory closure（banner=window.__ModuleLoader__.load({id,factory})），externals 走模块表（CLIENT_EXTERNALS=平台模块 + 豁免表），CSS Modules 经 lightningcss 编译（[hash]_[local] 类名）并内联 css 文本、在 factory 执行时注入 <style data-plugin="<id>">（卸载时由模块系统回收）；纯净性门禁禁止跨插件 value import。
- node 半对每个 bundle 内容 hash → /plugins/<id>/client.js?rev=…；source map 同路提供。
证据：client/tsdown.client.ts、docs/development.md（build 顺序）、client/modules/src/index.ts。

### Q4. client plugin 生命周期如何管理？

- Cordis Loader 治理每个 entry 的 fiber：inject 依赖等待激活、dispose 时逆序解除所有 ctx.effect/ctx.on 注册、HMR 下 update/refresh；模块系统只管"代码到达"（prefetch 注册 factory、materialize 跑副作用、invalidate 丢 factory），style 标签回收由 client-hmr 记账。
- 插件作者只需遵守"注册即效果"：所有贡献经 ctx.effect()/ctx.on() 并返回 disposer。
证据：cordis-primer.md、client/modules/README.md（no unload bookkeeping of its own 的边界说明）、client-hmr README。

### Q5. Cordis plugin 如何声明？

- 形态一：函数插件 export const name/inject/apply(ctx)；形态二：Service 子类。
- 服务经 ctx.provide 提供、ctx.get 按需取；依赖用 inject 声明（缺失即等待）；事件用声明合并 + emit/waterfall/parallel/serial 四种分派；注册必须可逆。
证据：docs/cordis-primer.md 全文；实例 packages/client/ui-theme/src/client/index.ts（ThemeRuntime 服务 + theme/change 事件 + slots 注册）。

### Q6. plugin 如何安装？

- 安装=让包在 profile 的解析范围内可 import + 在组合树中有一行。
- 官方路径：profile 的 package.json dependencies 加包名（或 dsh plugin 命令 initProfile/添加），healProfilesModuleFallback 在 $DSH_HOME/profiles/node_modules 维护平铺链接；组合行来自包自己的 dsh.bundle.patch（cordis.patch.yml insert）或用户 patch 层 insert。
- 无包管理器也能装：把包放进 profile 解析可达目录并手工 insert 行（watchUserPatches 会热重载）。
证据：app-boot README:32/38（bare specifier 解析、healProfilesModuleFallback、initProfile）、本机 ~/.dsh/profiles/web/package.json（bundles 实况）。

### Q7. plugin 如何进入 profile？

- profile=目录（package.json 含 dsh.profile.bundles 有序列表 + dependencies）+ cordis.patch.yml（用户 patch 层）+ 上层 home patch（~/.dsh/cordis.patch.yml，最高优先）与 --patch overlay。
- 组合=从空列表起，逐层应用 bundle patch 再叠用户 patch；每行以 id 定位。模板 web/headless 首次使用自动初始化，其它名用 dsh plugin 创建。
证据：architecture.md §Profiles、app-boot README:38-60。

### Q8. patch 如何工作？

- 语义：id 定位整行替换（config 整体覆盖、不深合并，需重述保留字段）；insert 批量加行；disabled 布尔开关；!!js 表达式在 loader 求值（entry config 在插件 ctx 上、disabled 在 loader ctx 上）。
- 层序与热更：bundles（按序）→ profile patch → home patch → --patch；启动后 watchUserPatches 持续热重组合，失败保留旧树并广播 hmr/config-update-failed；空/注释文件视为错误（用 [] 禁用该层）。
证据：cordis-primer.md §Loader Configuration、app-boot README:43-45、bundle/base/cordis.patch.yml（win32 条件行实例）。

### Q9. plugin 如何向 Web UI 增加 UI？

- 唯一 UI 组合入口是槽位系统：ctx.slots.register({name,children?,store?,inject?,id/order（list）,select（chain）}, Component)（注册即声明子槽）；ctx.slots.inject(name, cb) 等声明存在再注册（生成器形式一次事务、失败回滚）。
- 已知槽：sidebar.workspaces、sidebar.settings、sidebar.footer.action、settings.trigger/header/action/close/section/onboarding/general.item/plugin.item/plugins.tab、shell.overlay、conversation.input.overlay、tool.call.toolview 等；每个槽出口有稳定 data-slot="<key>" 锚点。
- 没有 client 路由表；"页面"=注册进 settings.section / 某个 list 槽的组件（vision-router 的 settings.plugin.item 卡片、ui-theme 的 settings.general.item 行都是先例）。
证据：ui-slots/README.md、client/runtime/src/client/slots.ts、各包 slot-contract.ts（见 phase0-notes/C §18.5）。

### Q10. 当前是否已经存在 theme / appearance / settings 机制？

有，且是完整的三段式主题机制（这是本审计最重要的正面发现）：
- ctx.theme（ThemeRuntime，dsh-client-ui-theme）：内建 light/dark（tokens 为空、真实色板在 CSS 变量表）+ 第三方 ThemeDefinition.register()（重复 id 抛错、dispose 重置偏好）+ overrideTokens(source, {light,dark} per token) 覆盖层（后注册胜、disposer 精确回滚）+ setTheme/getTheme + 不可变 ThemeSnapshot 经 theme/change 发布。
- DOM 投影（ui-layout ThemePresenter）：html{color-scheme}、body[data-ds-dark-theme]、body 内联 --dsw-* token、meta theme-color；只撤自己写过的字段。
- 持久化：Host settings namespace 'ui-theme'{preference} → $DSH_HOME/settings.yaml（atomic-write + 跨进程锁 + revision 冲突）；index.html 注入同步 bootstrap 脚本保证首屏不闪；客户端 settingsScope.bind + adopt。
- Appearance 设置行（settings.general.item 槽）已存在——插件设置 UI 的先例。
已知限制（宿主 README 原文）：第三方主题是扩展点不是产品，无覆盖完整性校验；--dsw-* token 表是唯一颜色权威。
→ dsh-skin 定位：不做新的"主题系统"，而是把 ctx.theme 作为皮肤的 token 层底座，其上叠加皮肤结构层（CSS/DOM/字体/装饰）。
证据：packages/client/ui-theme/src/client/index.ts（ThemeRuntime 全文）、packages/client/ui-layout/src/client/theme-presenter.ts、packages/client/ui-theme/src/boot-theme.ts、ui-theme/README.md。

### Q11. 当前是否已有 CSS injection 机制？

半套：
- 有：静态插件 bundle 的 CSS Modules 由 lightningcss 内联，在 factory materialize 时注入 <style data-plugin="<id>">，卸载/热更时被模块系统与 client-hmr 回收（tsdown.client.ts + system.ts claimStyles）。
- 无："任意全局 CSS 文本/额外 body 属性/@font-face 与字体文件"没有公开 API（静态插件 tsdown 只编译 *.module.css；动态包有 styles.insert 但属于 cordis-client-runner 内部）。
→ dsh-skin 必须自建 SkinStyleInjector / SkinRuntimeContext.addStyle / addElement / addAttribute / addObserver / addTimer，全部返回 disposer（这正是任务书要求的可追踪副作用 API；实现可借鉴 guard.ts 的 facede 模式与 DynamicCordisStyles）。
证据：packages/client/tsdown.client.ts:227-260、client/modules/src/client/system.ts claimStyles、extensions/cordis-client-runner/src/client/{evaluator,guard}.ts。

### Q12. 当前是否已有 asset / attachment 机制？

- attachment 服务（ctx.attachments）：saveImage/validateImage/readImage，内容寻址不可变字节（PNG/JPEG/WebP/GIF），会话内 image block 经 ImageAttachmentRef 引用，禁止把浏览器路径/base64 存进会话事件。这是"图片进模型"的标准通道。
- 静态资产：宿主没有通用 asset pipeline；插件包内静态文件要么打进 bundle（data URI/base64），要么由 host 侧 HTTP 路由自行 serve（client-modules 的 /plugins/*、frontend-static 的 dist 都是先例）。
→ 皮肤包的 preview 图与 assets 由 dsh-skin 的 host 路由 /dsh-skin/skins/<id>/assets/* 提供；第二阶段参考图走 attachments/vision 工具路径。
证据：packages/attachment/attachment/README.md、client/modules/src/index.ts（/plugins 注册）。

### Q13. 当前是否已有 filesystem service 可以使用？

有：ctx.fs = FileSystem 抽象（resolve/processPath/fileUrl/contains/stat/lstat/readText/streamText/readBytes/原子写/字面编辑；版本守卫可选），fs-local 为本地实现，fs-sandbox 施加写域限制，fs-observation-policy 提供 read-before-edit。插件可以直接注入 ctx.fs 做仓库 IO。
→ 本地 Skin Repository 的读写经 ctx.fs；路径校验用 contains + lstat 拒绝 symlink。
证据：packages/fs/fs/README.md（十二原语表）。

### Q14. 当前是否已有 HTTP / API capability 可以使用？

- 出站：web-fetch-http（dsh-web 服务 seam）。
- 入站：ctx.webServer.register(route)（exact/prefix，重名抛错，返回 disposer）/registerUpgrade/registerFallback/tapIndex；host 插件自建路由的先例有 vision-router 的 /_dsh/vision-router/test-connection 与 dsh-web-ui 的 /api/skin-center。
→ 第三阶段 Workshop 客户端走 web-fetch-http；dsh-skin 自身的 host API（/dsh-skin/api/*：list/apply/install/uninstall/publish 代理）走 ctx.webServer.register，并效仿 dsh-web-ui 加 Sec-Fetch-Site/Origin 同源栅栏。
证据：host/webserver/README.md、vision-router index.js:3594-3675、dsh-web-ui skin-center src/routes.ts:43-72。

### Q15. 当前是否已有用户配置持久化机制？

有，双轨：
- settings：ctx.settings.register(ns, schema, {base?}) → SettingsScope；update 深合并只写 user 层、replace 整体替换、mutate 路径编辑、expectedRevision 冲突拒绝（SETTINGS_CONFLICT）、写队列串行、解析值深冻结；settings-file provider 把文档写到 $DSH_HOME/settings.yaml（原子写 + 跨进程锁 + 外部编辑热发布 + YAML leaf-diff 保注释）。
- storage-domain：defineDomain(zod)/open → 内存权威读同步、写串行先持久后内存、domain/changed（单进程可见）；json 后端根 = dshHomePath('storages')。
→ dsh-skin 的激活态/偏好走 settings namespace（'dsh-skin'：activeSkin、maxIterations 等）；Skin Registry 走 storage-domain 或仓库 registry.json+atomic-write（Phase 1 定夺）。
证据：packages/settings/settings/README.md、settings-file/README.md、storage-domain/README.md、web-app/cordis.patch.yml（storage-json 行 root: dshHomePath('storages')）。

### Q16. 当前是否已有 plugin settings UI？

有：
- 槽位体系：settings.trigger/header/action/close/section/onboarding/general.item/plugin.item/plugins.tab；feature 注册自己的 settings 页（settings.section）或插件卡（settings.plugin.item——vision-router 的"视觉路由"设置卡实例）。
- 表单：dsh-client-schema-form 按 schema 渲染；plugin-inventory 提供只读 Loader 树展示（无 mutation）。
→ Skin Center 注册成独立页（settings.section）或插件卡 + 侧栏入口（sidebar.footer.action list 槽）；配置表单复用 schema-form。
证据：client/ui-settings/README.md（槽位清单）、ui-settings-plugins slot-contract.ts、vision-router lib/client.js:1160-1176。

### Q17. 当前是否已有 preview / screenshot 测试能力？

- 测试截图：有先例无门禁——apps/web/tests 用 Playwright Chromium 起真实 dsh web（DIST_INDEX），support.ts 提供 page.screenshot 证据/失败截图，smoke-real.e2e.ts 把每屏 PNG 写 .artifacts/；无 toHaveScreenshot 像素比对。
- 产品截图：vision-router 的 vision_html_screenshot（puppeteer-core）可截本地 HTML，但浏览器探测是 macOS-only（Windows 必败）。
→ dsh-skin 的 E2E 沿用 Playwright+真实 GUI 模式并自建截图断言/证据；第二阶段自建跨平台浏览器发现。
证据：apps/web/tests/support.ts:112-121、smoke-real.e2e.ts:123-126、phase0-notes/E §6.1。

### Q18. 当前 Web UI 的 DOM 结构和稳定扩展点是什么？

稳定锚点（皮肤可依赖）：
- data-slot="<key>"：每个槽出口的包装 div（含 root 与错误面 data-slot-error）——皮肤最安全的锚点。
- body[data-ds-dark-theme]：暗色态开关（ThemePresenter 维护）。
- --dsw-* 变量族：static 色板/alias 语义/typography/滚动条间接层（--dsh-scrollbar-*）/渐变阴影字体排版——皮肤 token 主战场；alias 层有 13 个官方可覆盖 token 名。
- #root 与 html[style].colorScheme。
不稳定（禁止依赖）：CSS Modules 的 hashed class、组件内部 JSX 结构、AppFrame 的 data-sidebar-collapsed 等布局语义属性。
→ 皮肤选择器只用稳定锚点 + 皮肤自有 scope 属性 body[data-dsh-skin="<id>"]；结构级换肤通过槽位整体重写（槽位系统天然支持组件级替换）。
证据：phase0-notes/C §18、web-react/src/scoped-slots.tsx:646-679、ui-theme/src/styles/*。

### Q19. 哪些内容可以通过公开插件 API 完成？

全部以下（均已验证签名）：ctx.slots.register/inject（UI 组合与子槽声明）、ctx.theme.register/overrideTokens/setTheme/getTheme/exportInspectTokens、ctx.settingsScope.bind（客户端持久）、ctx.locale.register、ctx.inputTriggers.registerSource（/ 与 @ 命令）、ctx.webServer.register（host 路由）、ctx.settings.register（host schema）、ctx.fs、ctx.attachments、ctx.storageDomain、dsh-atomic-write、ctx.effect/on/once/provide（副作用与事件）、tsdown clientBundle（构建）、Playwright 测试管线。

### Q20. 哪些功能必须使用低层机制？

仅三处（全部在浏览器 DOM 层，插件自管副作用，无需改 core）：
1. 任意全局 CSS 文本注入（皮肤样式表）→ 自建 SkinStyleInjector（style 标签 + disposer）。
2. 额外 body/根属性 → addAttribute/dispose 配对。
3. @font-face 与字体/静态资源加载 → 皮肤包 assets + host 路由 + FontFace API（带 disposer）。
另有两条"官方低层机制"可直接复用而非自造：模块表工厂 sink（window.__ModuleLoader__.load + ClientModuleLoader.import/invalidate，动态包 runner 已示范其合法用法）与 host patch 热重载（若选 patch 通道）。

### Q21. 哪些设计必须避免修改 Harness core？

结论：全部。皮肤系统所需能力都在插件边界内；下列宿主内部面严禁触碰：boot.tsx 引导链、app-shell/AppRoot、SlotCore/SlotRegistry 内核、ui-theme 的 builtin 与五张 token 表、ThemePresenter 的 DOM 写入、ui-layout 三栏几何、client-modules 的图与缓存、vendor loader/include/hmr。若未来确需新扩展点，按任务书 §31 六问流程向 upstream 提通用 extension point。

### Q22. Windows 下 profile / symlink / junction 是否存在限制？

- profile：$DSH_HOME/profiles/<name> 为普通目录；profiles/node_modules 由 healProfilesModuleFallback 维护平铺符号链接（每包一个链接），Windows 上同样工作（本机实测存在）。
- junction/symlink：宿主未禁止，且官方 profile 机制本身就用 junction（app-boot ensureSymlink 建 profile 平铺链接）；dsh-web-ui 的 ensureSymlink 在权限不足时回退 junction（其 Windows 兼容层）；宿主侧安全策略是"仓库内拒绝 symlink"——ctx.fs.lstat / fs-local probeNoFollow 专为此设计。
- 原子替换：atomic-write 的 wx+同目录 rename 在 Windows 可用（替换目标本身、不跟随 symlink）；已知限制：未 fsync（崩溃后 rename 可能回绕，由调用方策略兜底）。
- 沙箱：sandbox-windows-acl 用 WRITE_RESTRICTED token 实现 workspace-write/read-only；本机实测 bash 工具被平台策略禁用而 pwsh 可用（base bundle 的 win32 行正是此语义）。
- 大小写/短名：home-paths.canonicalizeWatchPath 与 fs-local 对 win32 做了规范化处理。
→ 皮肤仓库 IO 全部走 ctx.fs/atomic-write；不做自建 junction；安装目录校验拒绝链接与路径穿越；Windows 专项测试列入 Phase 1/4 计划。
证据：app-boot/src/profile.ts:170-202（ensureSymlink 用 junction、已存在非链接抛错）、:223-255（healProfilesModuleFallback 平铺 junction）、fs-local/src/fsio.ts:146-194（realpath 补 ENOTDIR）、:246-255（probeNoFollow 拒绝 symlink）、:567-595（Win32 copyFileDaclWin32+replaceFileWin32 保 DACL）、dsh-atomic-write README（Windows 裸 rename 的 TODO）、sandbox-windows-acl README（WRITE_RESTRICTED token/ACE）。

### Q23. 当前 plugin loader 是否允许动态 skin package？

分两层回答：
- Loader 运行时允许 create/update/remove 条目（vendor/loader/src/config/tree.ts:97-142）；但 client-modules 对 dsh.client 包元数据的缓存按名永久有效——"新包名"进花名册必须重启，已入表包内容变化可经 client-hmr 热换。
- 官方动态包机制（cordis-client-runner）绕过花名册：源码/工厂直接 sink.load 进模块表 + loader.create 建临时条目，退出即 remove——这是"动态 skin package"的官方等价物与先例。
→ dsh-skin 的皮肤加载采用第三条路（见 Q25/决策 D1）：皮肤包由 host 路由按需 serve，客户端经模块表 sink/动态 import 挂载到独立 SkinContext（不建全局 loader 条目），安装/卸载无需重启、无需 patch 手术。

### Q24. 当前 client module loader 是否支持 lazy loading？

是。懒 CJS 表：脚本执行只注册 factory，首次 import 才 materialize（副作用延迟）；boot graph 行按需 fetch（immediately 仅标记预取）；prefetch/invalidate 是 HMR 钩子；跨包 value import 被 purity gate 禁止（只能经 Cordis 服务协作）。皮肤 bundle 用同款 factory 形态，按需加载是原生行为。

### Q25. 当前是否能够实现类似 dsh-web-ui 的 try-on？

能，且宿主已内置完整先例，无需自造第二套机制：
- 官方动态包 runner = "临时挂载→退出卸载→刷新即干净→不改持久配置"：evaluateClientHalf → guard 面 → modules.invalidate → sink.load({id,factory}) → loader.create → fiber.await；teardown = loader.remove → invalidate → styles.dispose。guard 面还把 theme.overrideTokens 的 source 钉到包 id、给 slots.register 分配 shadowing 优先级。
- dsh-skin 的试穿设计：token 层 = ctx.theme.overrideTokens('dsh-skin/tryon', tokens)；结构层 = 加载皮肤 bundle 到独立 SkinContext（fresh Context + 受限 facade + SkinAPI），记录 owned effects；epoch 代际计数防快速连点；退出逆序 dispose + invalidate + 样式回收 + 恢复快照；永不写 settings/patch。
证据：extensions/cordis-client-runner/src/client/{runtime,guard,evaluator}.ts、dsh-web-ui try-on.ts（快照/回收/epoch 思想）、ui-theme ThemeRuntime.overrideTokens。

## 2. What … provides（四源分工）

### 2.1 What Harness already provides（直接复用，不自建）
ctx.theme（主题注册/覆盖/事件）、ThemePresenter（DOM 投影与恢复）、settings/settings-file（持久与冲突处理）、storage-domain/storage-json（域 KV）、ctx.fs + fs-local + fs-observation-policy（文件 IO 与策略）、dsh-atomic-write（原子写/锁）、ctx.webServer（HTTP 路由）、ctx.attachments（图片字节）、ctx.slots/ctx.settingsScope/ctx.locale/ctx.inputTriggers（UI 扩展）、client-modules（懒加载+工厂 sink+invalidate）、cordis-client-runner 的 guard/facade 模式（受限 ctx 范本）、tsdown clientBundle + CSS Modules（构建）、vitest + Playwright 管线（测试）、profile/bundle/patch/loader（安装与组合）。

### 2.2 What dsh-web-ui provides（思想复用，实现重做）
skin.json 单一事实源（→ 我们的 SkinManifest，字段按宿主重定义：去掉 package/wiring，保留 id/name/tags/accent/scope/preview/order，新增 version/compatibility/skinApiVersion/license/integrity/runtime）；body[data-xxx] 作用域开关 + 亮暗叠层；apply/dispose 契约 + chrome 元素标记精确回收；互斥激活（思想："任意时刻一个激活"；实现：settings 状态 + 运行时互斥，替代 patch 文本手术）；try-on 真实 bundle + 快照/恢复 + epoch；构建期内联 CSS 与资产；皮肤中心 UI 经 host API 驱动。

### 2.3 What vision-router provides（第二阶段眼睛）
vision_describe(json)→结构化证据、vision_colors、vision_ground/detect/crop、vision_ocr、vision_trace、vision_extract_foreground、vision_pixel_diff（diffRatio+worstRegions+热力图+报告）、vision_html_screenshot（Windows 需自建浏览器发现）；免费视觉链 fallback（OVH Qwen2.5-VL 免 key，2 req/min/IP）与 settings 卡；产物统一写 <workspace>/.dsh-vision-router/artifacts。

### 2.4 What dsh-skin must implement（自建清单）
SkinManifest/Skin Package 规范与校验（含 integrity、skinApiVersion=1 兼容判定）；Skin Repository（本地仓库目录、registry、staging+atomic install/uninstall、崩溃恢复）；SkinRuntime（SkinContext facade：effect/on/addStyle/addElement/addAttribute/addObserver/addTimer/guarded theme/guarded slots；apply/dispose/switch 回滚；互斥保证）；TryOnController（epoch/快照/恢复）；Skin Center UI（画廊/详情/搜索/过滤/排序 + host API）；内置 2-3 个真正不同的皮肤；构建/打包/完整性工具链（复用 tsdown client face + 自建 package 脚本）；测试（单元+E2E+Windows）。

### 2.5 What should NOT be implemented（明确不做）
不 fork/不修改 Harness core；不重造模块加载器（用模块表 sink + 浏览器原生加载）；不重造主题系统（ctx.theme 之上叠加）；不把皮肤做成每皮肤一个 Cordis 插件行 + patch 文本手术（见决策 D1）；不实现 vision model/截图引擎（第二阶段检测并依赖 vision-router，缺失时显式报缺）；第一阶段不引入任何网络依赖（Workshop 第三阶段、Vision 第二阶段，均为可选集成）。

## 3. 关键设计决策（Phase 1 前需拍板，已给出推荐与理由）

### D1 皮肤加载通道：仓库资源 + 模块表 sink（推荐） vs 每皮肤 Cordis 行 + patch 互斥（dsh-web-ui 模式）
- 推荐：dsh-skin 单插件；皮肤包=仓库资源（统一 Skin Package）；host 提供 /dsh-skin/skins/<id>/{client.js,assets,preview,manifest}；客户端用官方模块表 sink（window.__ModuleLoader__.load + import/invalidate）把皮肤 bundle 挂到独立 SkinContext。
- 理由：满足统一仓库/atomic install/AI 生成/试穿不改持久配置的全部任务约束；无 pnpm/patch 手术；新皮肤无需重启；皮肤作为 untrusted 代码被限制在 SkinContext，不接触真实 loader 树与插件 ctx（安全要求 §28）。
- 放弃的替代：每皮肤包 + insert 行 + home patch managed 区段（dsh-web-ui/maid-atelier 模式）——完全官方但代价是：pkgMeta 缓存使新包重启、卸载/升级要动 profile 配置、AI 生成皮肤要脚手架 npm 包、试穿与持久态耦合在 patch 文件里（非事务、无冲突处理），与任务书"本地仓库/统一包/不虚报成功"冲突。
### D2 皮肤代码的上下文：独立 SkinContext + facade（推荐） vs 全局 loader 临时条目
- 推荐：每个皮肤应用时创建 fresh Cordis Context + 受限 facade（借鉴 cordis-client-runner guard.ts：effect/on/timers 白名单、theme.overrideTokens 钉 source、slots 影子注册、拒绝 Context 返回值），dispose 逆序回收全部副作用；皮肤代码拿不到真实 ctx、loader、网络凭据。
- 理由：untrusted 边界清晰（Trusted/Untrusted 标签与权限一致）；dispose 语义严格（context.dispose 保证）；不受宿主 fiber 状态影响。
### D3 激活与持久化：settings namespace 'dsh-skin'（推荐） vs home patch 区段
- 推荐：settings 持久 activeSkin 等状态；SkinRuntime 订阅；互斥由运行时状态机保证（switch=dispose A→verify→apply B→失败回滚）。
- 理由：settings 提供原子写/锁/冲突拒绝/外部编辑热发布，是宿主官方"用户数据"通道；patch 是"组合配置"，状态混入组合会带来热重载与多 profile 副作用。
### D4 与 ctx.theme 的关系：token 层进 ctx.theme，结构层进 SkinRuntime
- 皮肤 manifest 拆两层：themeTokens（{light,dark} per token，进 overrideTokens/注册 ThemeDefinition）与 skinStyles/skinChrome（scope CSS/DOM/字体，进 SkinRuntime）。
- 理由：宿主的深浅色切换、presenter 投影、语义 token 校验全部白拿；同时证明 Skin API 能承载完整 UI Skin。
### D5 第二阶段视觉闭环接入点
- 检测：ctx.llm.listProviders() 含 vision-http（或 registration('vision-http') 不抛错）；缺失→生成入口禁用+明确提示。
- 编排：dsh-skin 生成器调用 vision_* 工具（agent 侧经宿主工具管线），自建 SkinDesignSpec schema + maxIterations + 中间产物工作区；截图自建跨平台浏览器发现（vision_html_screenshot 的 macOS-only 探测必须绕过）。
### D6 仓库持久化分层：registry 元数据走 storage-domain，包目录走 ctx.fs（两阶段提交 + 启动对账）
- 推荐：registry 元数据 = storage-domain 域（defineDomain(zod 表) → open → $DSH_HOME/storages/<domain>.json，storage-json 后端每次写为整文件原子重写、域层写链串行、schema 校验、domain/changed 事件）；皮肤包目录 = $DSH_HOME/skins/{installed,generated,downloaded,cache,staging}/ 经 ctx.fs 操作；install 采用两阶段：目录先 staging→rename 落位，registry 后提交；启动时对账（目录与 registry 不一致则修复），崩溃恢复由此闭环。
- 理由：metadata 与内容分层各自用宿主官方机制（storage-domain 的原子/校验/事件、fs 的原子原语），不自造第二套配置根；单进程可见性限制与宿主一致（GUI 由同一 host 进程服务）。

### 3.1 原始假设与实际机制的冲突说明（任务书 §40.F 要求，细节见 SKIN_REFERENCE_MAPPING.md §2）

| Original assumption | Actual Harness mechanism | Adaptation | Reason |
| --- | --- | --- | --- |
| 皮肤=每皮肤一个 npm 插件包 + insert 行（dsh-web-ui 模式） | dsh.client 行=浏览器花名册；pkgMeta 按名永久缓存（新包重启生效）；patch 热重载是唯一运行期入口 | dsh-skin 单插件 + 仓库资源包 + 自有路由 serve + 模块表 sink 挂载到独立 SkinContext（决策 D1/D2） | 统一 Skin Package、atomic install、AI 生成、untrusted 隔离均要求仓库语义；花名册路径无法满足 |
| 试穿=临时挂载皮肤 bundle、退出卸载 | ctx.theme.overrideTokens 返回 disposer 是 token 级覆盖层原语；官方动态包 runner 提供完整临时挂载生命周期 | try-on = overrideTokens + 受限 SkinContext 的可回收结构层 + epoch（决策 D2/Q25） | 复用宿主原语与官方先例，不自造第二套装卸机制 |
| 激活状态写 ~/.dsh/cordis.patch.yml managed 区段 | patch 是组合配置（整行覆盖、非事务、跨 profile home 层）；settings 是官方用户数据通道（原子写/锁/冲突拒绝） | 激活状态与偏好进 settings namespace 'dsh-skin'（决策 D3） | 状态与组合分离；获得事务与冲突语义 |
| 皮肤自己全量覆盖 CSS 与 body 属性 | ui-theme 拥有 --dsw-* 唯一颜色权威；全局样式归 ui-theme；第三方主题=alias token 覆盖层 | 皮肤拆 token 层（进 ctx.theme）与结构层（scope CSS/DOM，自建带 disposer 的注入器）（决策 D4） | 不破坏宿主 token 契约，同时承载完整 UI Skin |
| 自建 junction/symlink/rename 兼容层 | app-boot 用 junction 建 profile 平铺链接；fs-local 有 probeNoFollow 与 Win32 DACL 保留替换；atomic-write 为 wx+同目录 rename | 仓库 IO 全走 ctx.fs/atomic-write，安装拒绝 symlink/穿越，不自建 junction | 宿主已提供跨平台原子原语 |
| 皮肤插件自实现视觉分析/截图 | vision-router 提供全套 vision_* 工具；但 html_screenshot 浏览器探测仅 3 个 macOS 路径 | 视觉调用全部走 vision-router，缺失显式报缺；截图自建跨平台浏览器发现（决策 D5） | 不重造 vision model；Windows 一等公民 |

## 4. 待 Phase 1 开工前复核清单
- 宿主 master 是否变更（preview 阶段破坏性变更风险；每阶段开始重跑本次审计的关键文件核对）。
- 内置皮肤的确切名单与视觉方向（default 之外建议 terminal、retro 或类似三风格，覆盖任务书 §14 的组件矩阵）。
- Skin Package 目录定稿（manifest.json + package.json 与 client 构建产物 + styles/ + assets/ + preview/ + integrity.json 是否合并进 manifest）。

## 5. 一致性验证记录
- Phase 0 收口（目标轮 1/40）：对 16 项关键证据做源码抽查，全部 PASS（ui-theme overrideTokens/disposer、ThemePresenter data-ds-dark-theme、setTheme 仅持久化 built-in、app-boot junction/healProfilesModuleFallback、vendor loader create/remove、client-modules pkgMeta 永久缓存、__ModuleLoader__ sink 契约、guard 钉 theme source、maid-atelier 包形状、vision-router macOS 探测与 worstRegions、apps/web #root、storage-json root=storages、settings SETTINGS_CONFLICT），审计结论与当前工作区源码一致。
- 五份子代理笔记（A~E）与 00-verifier-notes 齐备；正式三文档互相交叉引用已核对（phase0 轮末一致性检查）。
- Phase 0 加固（目标轮 2/40）：① 宿主基线复验——git HEAD 仍为 47f9438，5 个关键文件 mtime 未变（2026-08-16 克隆时点），审计基线有效；② 决策 D6 落地——storage-domain/storage-json 源码核读（open 单开约束、zod 记录校验、写链串行、unit.ts 整文件原子重写），确定 registry 用 storage-domain + 包目录用 ctx.fs 的两阶段提交方案；③ 行号引用抽查 8/8 命中（A 笔记 3 处、C 笔记 2 处、E 笔记 2 处、D 实例数据 1 处）。
- Phase 1 实施发现的宿主事实（真实 GUI E2E 逐一验证并已适配，均为插件内解决、未改 core）：
  ① Web settings 网关对浏览器暴露的是硬编码白名单 WEB_SETTINGS_NAMESPACES（host/apiproxy/src/api-proxy.ts:126-128），插件自有 namespace 一律 settings-not-exposed，宿主注释自认"让插件在 settings.register 时自暴露是 deferred work"——适配：dsh-skin 的 activeSkin 改走插件自有 loopback API（/dsh-skin/api/active），持久化仍落官方 settings seam（settings.yaml 的 dsh-skin 段）；已记录为 upstream 通用扩展点改进候选。
  ② WebRoute 契约是"pathname 无尾斜杠"（host/webserver README），带尾斜杠的 prefix 路由永远匹配不到、被 SPA fallback 吞掉——适配：全部 prefix 路由去尾斜杠、切片逻辑过滤空段。
  ③ 官方 client preset 的 intro 依赖 tsdown 插入顺序；独立仓库用 tsdown 0.22 时其 CJS interop 行（Object.defineProperty(exports…)）先于 intro 执行导致 exports is not defined——适配：banner 内联 var module/exports 声明（等效 factory 契约，E2E 验证通过）。
  ④ settingsScope 首次读取异步（value 先 undefined），直接在 apply 时读会拿到 null——适配：自有 API 先 fetch 再 bootstrap（第 ② 条方案自然规避）。

