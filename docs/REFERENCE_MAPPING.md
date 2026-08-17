# dsh-skin Phase 0 参考系映射（REFERENCE_MAPPING）

> 参考系：dsh-web-ui/packages/dsh-skins（皮肤子系统设计参考）+ dsh-vision-router（视觉能力层）。
> 原则：**Reference Concept → Harness Native Equivalent → Adapter Needed** 三列映射；只提炼思想，绝不"复制代码 + 改 package name"。
> 依据：phase0-notes/D-dsh-web-ui-skins-mechanism.md、E-vision-router-mechanism.md（本会话同 commit 审计）+ run-001/run-002 实证。

## 1. dsh-web-ui/dsh-skins 有什么（参考系盘点）

- **skin.json 单一事实源**：每个皮肤一个元数据文件（id/name/author/description/tags/accent/bodyAttr/package/wiring/preview/order），运行期切换与构建期画廊元数据都从它派生。
- **皮肤作为资产目录内嵌聚合包**：skins/<id>/ 下带构建期生成的最小 package.json + lib/index.js（host 空入口）+ lib/client.js + cordis.patch.yml，profile 按 `@linxin666/dsh-client-ui-skin-<id>` 解析。
- **互斥启用 = 改写 ~/.dsh/cordis.patch.yml 的 managed 区段**：非激活皮肤全部 id 定向 disabled:true，激活皮肤 insert 行；切换伴随重写 profile node_modules 解析链接。
- **client 皮肤契约**：bundle 注册 `window.__ModuleLoader__.load({id, factory})`，factory 导出 apply；body[data-dsh-<id>] 作用域隔离；ctx.effect(() => cleanup) 注册 dispose。
- **try-on = 同源 script 载入真实 bundle**（非 eval）：TryOnController 用快照 + 回收 + epoch 代际计数处理互斥与竞态。
- **skin-center 走 host HTTP API**（/api/skin-center/state、/bundle/<id>、/apply），非纯 client localStorage。
- **构建链**：shared/tsdown.client.ts（tsdown + lightningcss css-modules 内联 + 模块加载器 banner/footer）；build.mjs 聚合资产；aggregate.yml 汇总 patch 行与 dependencies。
- **preview**：playwright 截图脚本生成，仅静态画廊用。

## 2. 概念 → 原生等价 → 适配（映射表）

| Reference Concept（dsh-web-ui） | Harness Native Equivalent（已源码核实） | Adapter Needed（dsh-skin 做法） |
| --- | --- | --- |
| skin.json 单一事实源 | 无皮肤概念；最近似：settings namespace schema（ctx.settings.register） | 自建 manifest.json（SkinManifest + validate + skinApiVersion）——v1.0.0 已做（src/core/manifest.ts） |
| 皮肤互斥 managed 区段（patch 改写） | cordis.patch.yml 是用户层，语义是加载期覆盖，**不是运行期切换通道**（每次切换都需重启才生效） | 不照搬：运行期互斥由 SkinRuntime 在 client 内管理（apply/dispose 单例），持久化走 settings seam（activeSkin）；profile patch 仅用于"装插件"，不用于"切皮肤" |
| 皮肤 client bundle（每皮肤一个插件包） | 每包 = Loader Entry + Fiber；包数 = 条目数，静态 profile 装配 | 不照搬"每皮肤一个 npm 包"：皮肤是资产目录（Skin Package 文件契约），client/index.js 经 runtime 的 bundleHost 按需 `window.__ModuleLoader__.load({id: 'dsh-skin/<skinId>', factory})` 注册——零 profile 改写、零重启 |
| bodyAttr 作用域隔离（body[data-dsh-<id>]） | 稳定 DOM 面：body[data-ds-dark-theme] 先例；slot 出口 data-slot | 采纳思想：body[data-dsh-skin="<id>"] + 每个皮肤 CSS 自带作用域（styles/theme.css 用同属性前缀）——v1.0.0 已做 |
| apply(ctx) + ctx.effect cleanup | ctx.effect(() => disposer) 是官方生命周期清理机制 | 采纳：SkinContext 效果面全部登记 disposer；dispose 后验证 data-dsh-skin 残留（run-002 D 阶段 residue=0 实证） |
| try-on 真实 bundle + epoch 代际 | client module loader 支持运行时 import（invalidate/import）；无内置 try-on | 采纳思想：tryOn 走真实皮肤 bundle + tryOnToken epoch（src/client/runtime/runtime.ts）；不照搬其皮肤包解析细节 |
| skin-center 走 host HTTP API | ctx.webServer.register({kind,path,handler}) + /plugins 前缀路由先例 | 采纳：/dsh-skin/api/*（skins/active/install/remove/generate/workshop）+ /dsh-skin/skins/<id>/files/* 静态资源路由——v1.0.0 已做 |
| build.mjs + aggregate.yml（聚合 patch 行） | 官方形态：package.json dsh.bundle.patch → cordis.patch.yml（单包单 patch） | 不照搬聚合器：dsh-skin 单包单 patch，行由 dsh-skin 自身 cordis.patch.yml 插入（id=dsh-skin）；多皮肤不需要多行 |
| preview 截图（playwright 静态画廊） | 无内置；host 有 frontend-static 静态服务 + webserver 路由 | 采纳思想：preview/{light,dark}.svg 随包、由 /files/* 路由供给；生成期截图用 puppeteer-core（Windows 自建 Edge 探测，见下） |
| 全局 chrome/backdrop 注入 | 无公开 API；静态插件可自建 <style>/元素 + ctx.effect 清理 | 采纳：addStyle/addElement/addAttribute/addObserver/addTimer 全部登记 ownership（SkinContext） |

## 3. 不能直接复制的机制（明令禁止清单）

1. **改写 ~/.dsh/cordis.patch.yml 切皮肤**——运行期互斥不该走加载期 patch；会造成重启依赖与用户层污染。
2. **每皮肤一个 npm 包/profile bundles 行**——皮肤是数据不是插件；插件只有一个（dsh-skin）。
3. **依赖 dsh-web-ui 专有设施**：__DSH_MODULES__/其 slot/locale/theme 包装的具体形状、aggregate.yml 聚合器、lightningcss css-modules 内联约定——这些是对方 monorepo 的内部实现，不是官方契约。
4. **像素 diff 引擎照搬**：vision-router 的 vision_pixel_diff 是 sharp 逐像素 + 热力图（可复用为工具），但 dsh-skin 生成循环的 diff 判据必须自己定义语义（见 IMPLEMENTATION_PLAN v1.1.x Q1：改造成"对参考图保真度"判据）。
5. **Windows 不可用的浏览器发现**：vision-router 的 vision_html_screenshot 只写死 macOS 路径；dsh-skin 已自建 Edge/Chrome 探测（src/generator/screenshot.ts）。

## 4. dsh-vision-router 映射（视觉层）

| Vision Router 能力 | 定位 | dsh-skin 用法 / 决策 |
| --- | --- | --- |
| vision_describe（json=true 结构化观察） | Eyes | v1.0.0 已用（经 llm seam 的 vision-http provider + attachments.saveImage）；散文输出时由 DeepSeek 做结构化（Eyes/Brain 拆分） |
| vision_colors / vision_ground / vision_detect / vision_crop / vision_ocr / vision_trace / vision_extract_foreground | Eyes 工具箱 | v1.2 起按需调用，**不在 dsh-skin 重复实现任何像素级工具** |
| vision_pixel_diff（ratio + 8×8 最差区域 + 热力图） | 验证 | 生成循环沿用其"ratio+区域"思想，但收敛语义改为参考图保真度（Q1）；自建 diff.ts 因 sharp 原生绑定问题已用 pngjs 纯 JS |
| vision_html_screenshot | 验证 | 不直接依赖（Windows 缺陷）；dsh-skin 自建 puppeteer-core + Edge 截图 |
| 免费 OVH 链（2 req/min/IP，429 治理） | 网络 | 接受为"免费默认"；429 治理列入 Q5（退避/排队/可配 keyed provider） |
| provider 注册（llm.registerAdapter，provider id=vision-http） | 集成点 | dsh-skin 只经 llm seam 消费（listModels('vision-http')），不直接 import vision-router 代码 |

## 5. 结论

- 采纳 dsh-web-ui 的**思想**：单一事实源、作用域属性隔离、apply/dispose 对称、真实 bundle try-on + epoch、host API 化皮肤中心。
- 拒绝其**机制**：patch 互斥、每皮肤一包、聚合器、私有模块表依赖。
- 视觉能力全部外购（vision-router = Eyes 工具箱），dsh-skin 只做结构化、生成、迭代与验证编排（Brain 与手）。

## 6. 本轮新审计交叉核对补录（webui-dsh-skins-audit.md）

- **确认：dsh-web-ui 全仓库未修改 Harness Core**——34 个 cordis.patch.yml 全部只含 boot-graph insert 行，无 replace/delete/文件改写；其 skin-center 只消费官方服务（webServer/slots/locale/theme/settingsScope）。参考系可用、机制思想可借鉴的前提成立。
- **反面教材 1（双注册表漂移）**：dsh-web-ui 的 Host 注册表（运行时扫 skin.json）与浏览器画廊（编译期静态生成）来源不一致，漏跑生成脚本即出现“宿主认得、卡片不显示”。dsh-skin v1.0.0 用单一 registry.json + 同一发现管线，不存在该漂移面——此设计保持。
- **反面教材 2（apply 走 boot 配置改写）**：其 apply 原子改写 ~/.dsh/cordis.patch.yml managed 区段 + 建 profile symlink + 热重载 + 页面刷新。dsh-skin 的 apply 是运行时切换 + settings 持久化，零 patch 改写、零重启依赖——此差异保持（REFERENCE_MAPPING §2 已列禁项）。
- **合规红旗（直接复制代码不可行）**：仓库根/package.json 声明 Apache-2.0，包内 LICENSE 却是 BSD-3-Clause（三处不一致）；blue-fantasy 上游 DreamSkin MIT 未随附许可文本；blue-fantasy/whale-song 内嵌 deepseek.com 蓝鲸 favicon（商标素材，不在任一开源许可授权范围）。结论：**只借鉴思想与结构，不复制其任何代码/资产**——与本映射原则一致，写入硬约束。
- **可借鉴的工程细节**：build.mjs 的 staging+原子 rename 聚合（对应 dsh-skin repository 的 stage→integrity→atomic commit）；try-on 双层清理（皮肤 effect disposer + 试穿层恢复器，对应 v1.0.0 SkinContext effects + dispose 验证）；realpath 去重与“直接包优先”确定性冲突策略（对应 v1.0.0 registry 冲突规则）。

## 7. 本轮新审计交叉核对补录（vision-router-audit.md，对象=已装生产 profile 的 1.1.1）

- **确认机制**：vision-http 是 llm provider 路由（ctx.llm.registerAdapter），不是 web 路径；dsh-skin 经 listModels('vision-http') 发现——与 v1.0.0 实现一致。
- **确认 429 行为**：免费 OVH 2 req/min/IP；插件自身已做 429 单次重试（Retry-After 封顶 60s）+ 失败分类 + advice。**推论：dsh-skin 不得再叠一层 429 重试**（双重退避放大等待）；dsh-skin 层只做失败分类透传。
- **确认 keyed provider 链**：httpProviders 可配 apiKeyEnv（dashscope/zhipu/siliconflow/openrouter 有 presets），freeFallback=true 时免费 OVH 作最后兜底——Q5 的治理面在 vision-router 配置层完成，dsh-skin 只消费。
- **确认 Windows 修正必要性**：vision_html_screenshot 的 Chrome 探测只写死 macOS 路径；dsh-skin 自建跨平台浏览器发现（DSH_SKIN_CHROME_PATH→Edge/Chrome→macOS/Linux）是必要修正，保留，但不再 fork 其它浏览器自动化。
- **新增缺口**：dsh-skin 送视觉模型前只有 8MB 输入上限、无像素预算缩放；v1.2/Q5 补 downscale 预算（vision-router 默认 4MP）以降低编码成本与 429 概率。
- **v1.2 挂载点（按报告 §8.2 采纳）**：analyzeImage 升级为结构化观察+显式 colorPalette；toEvidence 作唯一归一化闸门（补 #RRGGBB 校验）；designSpec 显式传入 evidence 字段而非让 DeepSeek 自由发挥；spec 保持纯设计契约（视觉证据独立 schema）；repair 循环把 worstRegions 先喂 Eyes 二次观察再喂 Brain；screenshot/diff 保持现状不重写。
- **不重复造的清单（硬约束）**：视觉 provider 注册/fallback、attachments 内容寻址、sharp 像素算法/主色量化/抠图、potrace 矢量化、tesseract OCR、免费 OVH endpoint 与 429 逻辑——全部只经 vision-router seam 消费。
