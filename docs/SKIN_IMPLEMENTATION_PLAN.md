# SKIN_IMPLEMENTATION_PLAN — dsh-skin 分阶段实施方案

> Phase 0 交付物。依据：SKIN_ARCHITECTURE_AUDIT.md 的 25 问结论与决策 D1~D5、SKIN_REFERENCE_MAPPING.md 的映射表、AGENTS.md 的纪律。
> 原则：每阶段独立可运行、可验证；每个版本对应一个 Phase 收口；Phase 0 后暂停，经确认再进入 Phase 1。

## 0. 总览

| Phase | 内容 | 收口版本 | 主要新增目录/文件（dsh-skin/ 下） | 状态 |
| --- | --- | --- | --- | --- |
| 0 | 架构审计（决策 D1~D6 已确认） | — | AGENTS.md、docs/SKIN_ARCHITECTURE_AUDIT.md、docs/SKIN_REFERENCE_MAPPING.md、docs/SKIN_IMPLEMENTATION_PLAN.md、docs/phase0-notes/A~E | 完成 |
| 1 | Skin Foundation：Manifest/Validator/Repository/Registry/Runtime/SkinContext/activeSkin/内置皮肤/最小验证入口 | v0.1.0 | package.json、cordis.patch.yml、tsdown.config.ts、src/core/、src/repository/、src/client/runtime/、src/（host）+src/client/（client 入口）、skins/（clean/terminal）、tests/（46 单元 + 3 E2E）、docs/skin-package.md | 完成：46 单测 + 3 真实 GUI E2E（隔离 DSH_HOME + 独立端口 + Playwright：roster/物化 → 发现 → Try-on → 退出恢复 → Apply → 刷新保持 → 切换 → 恢复默认 → 零残留）+ tsc + 双面构建全绿 |
| 2 | Skin Center：Gallery/Detail/Preview/Try-on/Apply/Switch/Restore Default + 搜索过滤排序 + 安装/卸载 | v0.2.0 | src/client/center/selectors.ts、src/client/ui/skin-card.tsx（完整中心）、host list/detail 扩展（updatedAtMs/preview URL）、docs/skin-center.md | 完成：52 单测 + 4 真实 GUI E2E（含搜索/标签/来源/排序/详情预览/API 安装/详情卸载）+ tsc + 构建全绿 |
| 3 | AI Skin Generator + Visual Verification（一体阶段） | v0.3.0 | src/core/spec.ts、src/generator/{vision,diff,codegen,render,screenshot,iterate}.ts、host /dsh-skin/api/generate、Skin Center 生成面板、docs/skin-generator.md | 完成：62 单测 + 5 真实 GUI E2E + tsc + 构建全绿（LiveBrain 接 ctx.llm 的 vision-http/文本路由；E2E 用确定性 fixture；像素 diff + 样式指纹双判据；迭代工件落盘；最终门 build/runtime/integrity/screenshot 后安装） |
| 4 | Generated Skin Lifecycle（命名/编辑/重新生成/导出/重装） | v0.4.0 | 仓库四来源根（generated/downloaded）、repository.replace（回滚）、host meta/export/regenerate 路由、Skin Center 编辑/导出/重新生成面板、export.ts | 完成：68 单测 + 6 真实 GUI E2E + tsc + 构建全绿 |
| 5 | Workshop 读取/下载/安装（网络层只管 search/metadata/download） | v0.5.0 | src/workshop/{protocol,client,install}.ts、host workshop/config 路由、Skin Center 在线皮肤区、docs/skin-workshop.md | 完成：76 单测 + 7 真实 GUI E2E（mock 远端服务器：浏览/下载/更新/离线降级）+ tsc + 构建全绿 |
| 6 | Workshop 发布/更新/举报（Validate→Build verify→Integrity→Upload） | v0.6.0 | src/workshop/publish.ts、client publishNew/publishVersion/report、host publish/report 路由、UI 发布/举报按钮 | 完成：79 单测 + 8 真实 GUI E2E（mock 远端记录上传）+ tsc + 构建全绿 |
| 7 | 安全/兼容/治理 + 最终集成（Trusted/Untrusted、zip-slip、兼容矩阵、Windows 专项、完整 E2E、docs 八篇） | v1.0.0 | src/repository/security.ts（可执行/远程 URL 扫描门）、registry trust 标注、docs/{skin-architecture,skin-runtime,skin-security,skin-authoring}.md、version 1.0.0 | 完成：85 单测 + 8 真实 GUI E2E + tsc + 构建全绿 |

## 1. 项目结构（Phase 1 落地形态）

dsh-skin 为独立仓库，发布形态=单个双面 Cordis 插件包（npm 名 dsh-skin；host 半+client 半），皮肤包=仓库管理的统一 Skin Package（不是 npm 包、不是 Cordis 行）：

```text
dsh-skin/
├── package.json          # dsh.bundle.patch→cordis.patch.yml；dsh.client{inject,platform:'web'}
├── cordis.patch.yml      # 仅插入 dsh-skin 自身一行（id: dsh-skin）
├── tsdown.config.ts      # 复用官方 clientBundle 预设（若独立仓库则镜像其 banner/externals，先例 maid-atelier/build/tsdown.client.ts）
├── src/
│   ├── index.ts          # host 半：SkinRepository 服务、settings ns 'dsh-skin'、/dsh-skin/* 路由、皮肤包 serve
│   ├── client/index.ts   # client 半：SkinRuntime 服务、Skin Center UI、槽位注册
│   ├── core/             # SkinManifest schema/校验/id 规则/兼容判定/integrity（host/client 共用纯逻辑）
│   ├── repository/       # 本地仓库：discover/registry/install/uninstall/staging/atomic/recovery
│   ├── runtime/          # SkinContext facade、apply/dispose、switch、try-on（epoch）、持久化桥
│   ├── center/           # 画廊/详情/搜索/过滤/排序组件
│   ├── generator/        # Phase 5+：vision 检测/SkinDesignSpec/代码生成/验证循环
│   └── workshop/         # Phase 8+：远端 API 客户端（可选依赖）
├── skins/                # 内置皮肤包（统一 Skin Package 格式，随包分发并首次启动注册进仓库）
│   ├── <id>/manifest.json + styles/ + assets/ + client/ + preview/ + integrity.json
├── scripts/              # build-skin.mjs / package-skin.mjs / verify-integrity.mjs
├── tests/{unit,client,e2e}
└── docs/                 # 八篇最终文档 + Phase 0 交付物
```

Skin Package 定稿（Phase 1 产物，任务书 §7 适配宿主后的形态）：
```text
<id>/
├── manifest.json        # SkinManifest：id/version/name/nameEn/author/description/tags/category/accent/
│                        #   scope/themeTokens/preview/runtime{entry,format}/compatibility{harnessVersion?,skinApiVersion}/
│                        #   source{builtin|local|generated|downloaded|published}/license/createdAt/updatedAt/dependencies/integrity
├── styles/              # 皮肤 CSS（scope 前缀约束，构建时合并）
├── assets/              # 图片/字体/SVG（禁止远程 URL；构建期可选 data-URI 内联）
├── client/              # 皮肤入口源码（导出 apply(skinCtx)/可选 inject）
├── preview/light.* dark.*
└── integrity.json       # 文件清单 + sha256（构建时生成、安装时校验）
```
compatibility 判定三线分治：Harness Version（宿主包版本区间）／Skin API Version（skinApiVersion=1，本插件定义并维护）／Skin Package Version（SemVer）。

## 2. 各 Phase 明细

### Phase 1 — Skin Foundation（v0.1.0）
- Goal：统一 Skin Package 契约与校验、内置皮肤、确定性构建与完整性，成为后续所有 Phase 的地基。
- Files：src/core/manifest.ts、src/core/schema.ts、src/core/id.ts、src/core/integrity.ts、src/core/compat.ts、src/repository/discover.ts（初版：目录扫描+去重+损坏标记）、skins/ 内置 2-3 个皮肤（建议 id：terminal、retro；风格覆盖任务书 §14 的组件矩阵：sidebar/header/card/message/input/code/status/loading/modal）、scripts/build-skin.mjs（tsdown client face 打包 client/ + 合并 styles + 生成 integrity.json）、scripts/package-skin.mjs（可安装包）、tests/unit/*.spec.ts。
- Architecture：manifest 为唯一事实源（zod schema + 运行时校验）；id 规则 /^[a-z0-9][a-z0-9-]{1,63}$/ + 保留字表 + 路径穿越拒绝；integrity=文件清单 sha256；discover 用 ctx.fs 读目录、lstat 拒绝 symlink、损坏包进入 registry 的 corrupt 状态而非崩溃。
- Dependencies：宿主无强依赖（纯 TS + zod/schemastery 与宿主一致）；tsdown/lightningcss 走官方 clientBundle 预设。
- Tests：manifest 合法/非法/缺字段/坏 id；integrity 一致/篡改；discover 正常/重复 id/损坏/缺失；路径穿越样本；Windows 分隔符样本（node:path 语义测试 + 真实 win32 跑）。
- Acceptance：`pnpm build && pnpm test` 绿；构建产物 deterministic（两次构建 integrity 相同）；皮肤包可被 discover 并生成 registry 条目；无网络依赖可运行。
- Risks：宿主 rc 阶段 API 漂移（每阶段先重跑审计核对）；独立仓库 tsdown 预设与宿主版本位漂移（镜像 maid-atelier 的自带构建预设并锁定版本）。

### Phase 2 — Skin Center（v0.2.0）
- Goal：可浏览/搜索/过滤/排序/看详情的皮肤中心 UI + host 元数据 API。
- Files：src/host/api.ts（/dsh-skin/api/skins、/dsh-skin/api/skins/:id、同源栅栏）、src/center/*（Gallery/Detail/SearchBar/FilterBar）、src/client/index.ts（注册 settings.section 或插件卡 + sidebar.footer.action 入口）、locales。
- Architecture：UI 只经 API/service（SkinRepository）操作，不直接改仓库/运行时状态（任务书 §6.3）；数据来自 host API 的 registry 投影；preview 直接 serve 包内图。
- Dependencies：ctx.webServer（host）、ctx.slots/ctx.locale/ctx.settingsScope（client）、react 18（与宿主同）。
- Tests：API 路由测试（list/detail/404/同源拒绝）；client jsdom：画廊渲染/搜索/标签过滤/分类/排序；e2e：打开皮肤中心看到内置皮肤。
- Acceptance：皮肤中心可用且对宿主零侵入；列表与 registry 一致；无皮肤时优雅空态。
- Risks：设置页形态随宿主 UI 变化（以 data-slot 锚点测试为主，不断言 hashed class）。

### Phase 3 — Runtime / Switch / Try-on（v0.3.0）
- Goal：apply/dispose 核心契约、严格互斥切换（失败回滚）、不落盘的试穿（epoch 防竞态）、持久化与刷新恢复。
- Files：src/runtime/skin-context.ts（SkinContext facade：effect/on/addStyle/addElement/addAttribute/addObserver/addTimer + guarded theme/slots，借鉴 cordis-client-runner guard.ts）、src/runtime/loader.ts（host 路由 /dsh-skin/skins/<id>/client.js 取 bundle → script 注入 → 模块表 sink 注册 → import 物化）、src/runtime/switch.ts、src/runtime/tryon.ts、src/runtime/persistence.ts（settings ns 'dsh-skin'：activeSkin 等）、host 侧同名 settings 注册。
- Architecture：每个皮肤应用在一个 fresh SkinContext（独立 Cordis Context + facade）上，dispose=逆序执行 disposer + invalidate 模块 + 回收 style[data-plugin]；token 层进 ctx.theme.overrideTokens（source='dsh-skin:<id>'）；switch=A dispose→verify→B apply→verify，B 失败清理 partial 并恢复 A；try-on=快照→挂载→epoch 校验→退出恢复，永不写 settings/patch；启动时按 settings 恢复 activeSkin。
- Dependencies：ctx.theme、client module table（sink/import/invalidate）、settings；皮肤 bundle 无任何 externals（untrusted 边界）。
- Tests（对齐任务书 §32）：Runtime apply/dispose/重复 apply/partial apply/failed apply；Switching A→B、B→A、A→default、失败 B→恢复 A；Try-on enter/exit/多次/竞态/失败回滚；e2e：install→center→try-on→apply→reload→verify active→switch default→verify restored（真实 dsh web，Playwright 模式）。
- Acceptance：切换过程任意时刻最多一个激活皮肤（用 MutationObserver/DOM 断言验证）；刷新后恢复；试穿不产生任何持久变更；dispose 后无残留 style/属性/DOM。
- Risks：宿主模块表 sink 是内核契约（有动态包先例，风险低）；皮肤 bundle 执行错误必须被 SkinContext 捕获并完整回收（partial apply 回滚测试覆盖）。

### Phase 4 — Local Repository（v0.3.x）
- Goal：真正的本地皮肤仓库：atomic install/uninstall、版本升降级、完整性校验、崩溃恢复。
- Files：src/repository/store.ts（目录布局 $DSH_HOME/skins/{installed/,generated/,downloaded/,cache/,staging/}）、install.ts、uninstall.ts、upgrade.ts、recovery.ts（启动时清理 staging 残留、registry 对账）、registry.ts。
- Architecture：registry 元数据用 storage-domain（域 'dsh-skin'，json 后端，$DSH_HOME/storages/<domain>.json 原子整文件重写 + zod 校验 + 写链串行）；包目录用 ctx.fs（决策 D6）。install=staging 解包→校验（manifest/integrity/zip-slip/路径穿越/symlink）→atomic rename 进 installed/<id>@<ver>→registry 提交（两阶段：目录先、registry 后）；uninstall=registry 先标记→目录移除→失败回滚；duplicate id 检测与版本共存策略；崩溃恢复=启动对账（staging 全清、registry 与磁盘 diff 修复）。
- Tests：install/uninstall/reinstall/upgrade/downgrade/中断安装（注入失败点）/checksum mismatch/path traversal/zip-slip/symlink 攻击/Windows 文件锁与 rename 行为。
- Acceptance：断电/异常后仓库自愈；任何失败不留下半装状态；对 AI 生成与下载皮肤提供同一安装通道。
- Risks：Windows rename 跨卷（staging 与 installed 同卷放置）；registry 双写一致性（单写者锁 + 启动对账兜底）。

### Phase 5 — AI Skin Generator（v0.4.0）
- Goal：图片→（vision-router）→结构化 SkinDesignSpec→DeepSeek→皮肤代码→构建→写入 generated/；与普通皮肤同一 Runtime。
- Files：src/generator/vision.ts（依赖检测：ctx.llm.listProviders 含 vision-http / registration 不抛错；缺失→UI 显式提示+禁用）、spec.ts（SkinDesignSpec schema：visualStyle/colorPalette/typography/spacing/shapeLanguage/borderStyle/shadowStyle/backgroundStyle/headerStyle/sidebarStyle/messageStyle/inputStyle/buttonStyle/cardStyle/iconStyle/chromeElements/decorativeElements/assetCandidates）、codegen.ts（Spec→manifest+styles+client 源码，禁止视觉文本直接拼代码）、naming.ts（ID 建议/合法/唯一/保留字/穿越检查）、client/generator-ui。
- Architecture：vision_describe(json)+vision_colors+vision_ground/crop→Spec（可缓存/可编辑/可 diff）→代码生成（模板+约束）→build-skin→写 generated/→用户命名确认；AI 只是 Skin Package Producer。
- Dependencies：可选 vision-router（检测失败不阻断 Phase 1-4）；DeepSeek 经宿主 LLM seam（生成阶段由宿主工具管线/会话完成或 host 服务调用，Phase 5 细化）。
- Tests：缺 vision-router 降级、无效图片、vision 失败、生成失败、build 失败（全部回滚）；deterministic fixture（mock 视觉输出）保证无真实 API 可测。
- Acceptance：用 fixture 端到端生成一个皮肤包并可通过试穿/应用；无 vision 环境时入口给出明确安装提示。
- Risks：生成质量不可控（fixture 保证机制正确性，质量靠 Phase 6 闭环）；API 消耗（maxIterations 上限 + 用户确认）。

### Phase 6 — 视觉验证闭环（v0.5.0）
- Goal：截图→像素 diff→自动修复的收敛循环，且每轮工件落盘。
- Files：src/generator/verify/browser.ts（跨平台浏览器发现：环境变量→Windows Program Files 常见路径→macOS→Linux；封装 vision_html_screenshot 或自建截图）、diff.ts、repair.ts、iterate.ts（maxIterations 默认 3 可配置）、artifacts.ts（generation/<run>/{input.png,analysis.json,design-spec.json,iteration-N/,final/} 进 cache/generation 工作区）。
- Architecture：迭代=生成→构建→（预览 HTML 应用皮肤 CSS）→截图→vision_pixel_diff（diffRatio+worstRegions）→不收敛则 worstRegions+vision_crop/describe 定位→修复提示→再生成；收敛判据=palette similarity + layout similarity + region similarity + pixel diff + structural correctness 组合，不设僵化百分比。
- Tests：截图失败、diff 失败、迭代上限、逐轮工件完整性；fixture 化视觉链。
- Acceptance：最终皮肤通过 build=runtime=dispose=screenshot=pass 四门；diff 报告（ratio/worst regions）随工件保存。
- Risks：vision_html_screenshot 的 macOS-only 浏览器探测（本阶段自建跨平台发现）；GUI 真实截图夹具（先截预览 HTML，真实 GUI 截图列为 Phase 10 加固项）。

### Phase 7 — 本地生成皮肤生命周期（v0.6.0）
- Goal：生成结果完整生命周期：命名/编辑信息/重新生成/导出。
- Files：src/generator/lifecycle.ts、Skin Center 的生成卡动作（重新生成/编辑信息/导出/发布（Phase 9））。
- Tests：改名/改标签幂等、导出=可再安装的 Skin Package、重新生成不破坏已命名皮肤（新 run 目录）。
- Acceptance：用户命名→保存→试穿→应用→编辑→导出→另一实例安装，全程同一包协议。

### Phase 8 — Workshop 读取/下载（v0.7.0）
- Goal：Wallpaper Engine 式浏览/搜索/标签/排序/下载/安装/更新/收藏，且离线完全可运行。
- Files：src/workshop/client.ts（远端 API 客户端：GET /skins 等，协议待服务器定稿，默认空端点=离线模式）、src/workshop/install.ts（远端元数据→兼容检查→下载到 staging→checksum→校验→安全校验→atomic install）、src/center/online.ts。
- Architecture：Network Repository 只做 search/download/metadata，本地 install 语义复用 Phase 4 仓库（禁止直写 installed/）。版本+checksum 防篡改。
- Tests：搜索失败、下载失败、checksum 失败、不兼容皮肤拒绝、离线模式（全部不影响本地皮肤）。
- Acceptance：断网时本地皮肤照常；下载的皮肤与本地/AI 皮肤同仓同 runtime。

### Phase 9 — Workshop 上传/发布（v0.8.0）
- Goal：发布/更新/举报；上传失败不损坏本地。
- Files：src/workshop/publish.ts（validate→build verification→security scan→integrity→metadata→upload→server verification）、update/report API。
- Tests：上传失败回滚、发布后本地皮肤原样、重复发布冲突处理。
- Acceptance：本地皮肤一键发布；更新自己发布的皮肤；他人皮肤举报通道。

### Phase 10 — 安全/兼容/治理 + 最终集成（v0.9.0→v1.0.0）
- Goal：untrusted 安全模型落地、兼容矩阵、文档八篇、E2E 全链、发布。
- Files：src/core/security.ts（Trusted/Untrusted 标签与能力对照；皮肤 bundle 只经 SkinContext facade、无 fs/network/凭据；下载包 zip-slip/穿越/可执行文件/远程 URL 拒绝）、docs/{skin-architecture,skin-package,skin-runtime,skin-center,skin-generator,skin-workshop,skin-security,skin-authoring}.md（authoring 必须让第三方不看插件内部即可开发皮肤）、tests/e2e 全链与视觉回归证据。
- Acceptance：三阶段验收标准全绿（任务书 §41）；skinApiVersion=1 兼容判定文档化；v1.0.0 发布。

## 3. 全局验收对照（任务书 §41）
- 阶段一：安装插件→打开皮肤中心→预览→试穿→应用→刷新保持→切换→恢复默认，全程不破坏宿主功能。
- 阶段二：选图→视觉分析→生成→自动构建→自动截图→视觉比较→自动修正→生成包→命名→入仓→试穿→应用。
- 阶段三：在线浏览→查看→下载→安装→试穿→应用；我的皮肤→发布→他人下载安装。

## 4. 风险总表
| 风险 | 缓解 |
| --- | --- |
| 宿主 rc 阶段 API 漂移 | 每 Phase 开头重跑审计核对；skinApiVersion 独立管理；兼容声明区间化 |
| 独立仓库构建与宿主 tsdown 预设漂移 | 镜像 maid-atelier 的自带 client bundle 预设并锁版本；CI 对宿主 rc 版本构建验证 |
| 皮肤代码 untrusted 执行 | 只暴露 SkinContext facade；无 externals；Trusted/Untrusted 标注；安全扫描进 install/publish 链 |
| 视觉链路不可用/不稳定 | 阶段一零依赖；阶段二显式检测+提示；fixture 化测试；免费链 fallback 已有 |
| Windows 特有问题（锁/rename/大小写/junction） | 全程 ctx.fs/atomic-write；同卷 staging；Windows 专项测试；junction 仅官方 profile 机制使用 |
| 视觉质量判定主观 | 组合判据（palette/layout/region/pixel/structural）+ 用户最终确认，不设僵化阈值 |

## 5. 下一步（Phase 0 收口）
1. 用户确认本三份文档（审计/映射/实施计划）与决策 D1~D5。
2. 若认可：进入 Phase 1（Skin Foundation），先重跑宿主 master 关键文件核对，再按十步流程实施。
3. 若有异议（尤其 D1 皮肤加载通道、D3 激活持久化位置）：修订文档后再动工。

