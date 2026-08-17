# dsh-skin 实施规划（IMPLEMENTATION_PLAN）

> 定位：Phase 0 审计后的**执行规划**。原则：契约优先、每阶段独立验收、一阶段通过才进下一阶段；UI 建立在稳定 service contract 之上。
> 重要事实：v1.0.0 已实现并验收了一条完整纵切（包→仓库→运行时→皮肤中心→AI 生成→workshop 客户端）。因此 v1.1+ 各阶段不是绿地开发，而是**把已验收能力正式提炼为公开契约 + 补严验收门**；任何阶段都不得因 Quality 问题重构冻结面（见 BASELINE.md）。

## 0. 任务执行协议（每个编码任务统一走）

```text
TASK → READ → AUDIT → DECISION → IMPLEMENT → UNIT TEST → E2E TEST → REAL ENV VALIDATION → DOCUMENT → ACCEPT / REJECT
```

每个阶段必须输出七要素：
1. Current Problem（当前问题，引用验收证据）
2. Improvement（改进内容，只做本阶段的事）
3. Files（涉及文件清单）
4. Dependencies（依赖的上游 API 与源码出处）
5. Tests（单元 + e2e + 真实环境验证点）
6. Acceptance Criteria（对照 ACCEPTANCE_MATRIX 的具体条目）
7. Rollback（回滚步骤）

执行环境铁律：源码 D:\deepskin\dsh-skin → 构建 tsdown → 开发 profile（DSH_HOME=D:\deepseek\dsh-dev-home）→ :3081 验证。生产环境（D:\deepseek\deepseek-harness + C:\Users\deco1\.dsh + :3080）保持只读心态，只在专门的生产验收阶段操作。

## 1. 阶段路线图（顺序固定）

```text
BASELINE（本文件集，已完成）
  ↓
PHASE 0  Architecture Audit（本文件集，已完成，含否决门 A~D 通过）
  ↓
PHASE 1  Skin Contract（契约冻结）
  ↓
PHASE 2  Skin Runtime（含 residue 专项）
  ↓
PHASE 3  Local Repository
  ↓
PHASE 4  Skin Center
  ↓
PHASE 5  Runtime + Repository E2E / Hardening（A~J 门）
  ↓
v1.1.x  QUALITY（Q1~Q5，独立开发线）
  ↓
v1.2.x  Vision → SkinDesignSpec
  ↓
v1.3.x  SkinDesignSpec → SkinPackage
  ↓
v1.4.x  Render → Diff → Repair
  ↓
v1.5.x  AI Skin Lifecycle
  ↓
v1.6.x  Workshop Read / Download
  ↓
v1.7.x  Workshop Upload / Publish
  ↓
v1.8.x  Security / Compatibility
  ↓
v2.0    Skin Ecosystem
```

## 2. 各阶段内容（契约优先，冻结 API 而非实现）

### Phase 1 — Skin Contract（v1.0.0 已具形，本阶段 = 正式冻结 + 契约文档化）
- 冻结对象：SkinManifest / SkinPackage（manifest.json + theme/ + styles/ + client/ + preview/ + integrity.json，skinApiVersion=1）/ SkinRepository API / SkinRuntime API / SkinRuntimeContext / SkinError / SkinSource。
- Repository API 冻结面：`install(package)`、`uninstall(id)`、`get(id)`、`list()`、`validate(package)`。
- Runtime API 冻结面：`preview(id)`、`apply(id)`、`dispose(id)`、`switch(id)`、`restore()`；Try-on：`enter(id)`、`exit()`。
- 明确：manifest 存哪里、registry 怎么存、CSS 怎么加载、bundle 怎么加载都是内部实现，不是契约。
- 出口：src/core 类型与校验不变（仅补契约测试），新增 docs/skin-api-contract.md 契约文档。
- 验收：Phase 1 单元测试 + 契约文档评审（对照 ACCEPTANCE_MATRIX §Phase1）。

### Phase 2 — Skin Runtime（v1.0.0 已验收，本阶段 = 提炼 + residue 专项）
- 三条铁链：default→A→B→default；A apply→B apply 失败→清理 B→恢复 A；A→try-on B→exit→A。
- 专项（把 run-002 发现转成测试）：restore 后瞬时空 `style=""` 必须消失或在 e2e 断言中被明确定义为“刷新后清零”。
- 强化验证维度：Apply / Refresh / Restart / Restore / Switch / Failed Apply / Partial Apply / Double Dispose / Repeated Switch / Try-on Race。
- residue 指标（全部 = 0）：DOM residue、CSS residue、attribute residue、listener residue、observer residue、timer residue。
- 不改动 Apply/Restore 语义与持久化模型（FROZEN）。

### Phase 3 — Local Repository（v1.0.0 已具形，本阶段 = 失败注入 + 恢复门）
- 目录：skins/{installed,generated,downloaded,cache,staging}；优先级 installed>generated>downloaded>builtin；trust=downloaded→untrusted。
- 核心流程：package → validate → stage → integrity → atomic commit → registry；卸载：validate → dispose → remove → registry update；任何一步失败 → rollback。
- 新增验收：F repository recovery、J malformed skin（见 ACCEPTANCE_MATRIX）。

### Phase 4 — Skin Center（v1.0.0 已具形，本阶段 = 只动 UI 层）
- UI 只调用 SkinController（Repository + Runtime 的编排面），不感知 CSS 装载/清单校验/文件保存/bundle 构建。
- 本阶段不新增 host 机制；如需新路由必须先在契约文档登记。

### Phase 5 — E2E / Hardening（生产式验收）
- 复用 run-002 的 A~E 门（共存/clean 全链/gallery install/六连压力/真实对话保护），新增 F~J 门（仓库恢复/失败回滚/试穿竞态/崩溃恢复/畸形皮肤）。
- 通过后 = Runtime Gate + Repository Gate 双通过，才允许进入 v1.1.x。

## 3. v1.1.x QUALITY 线（五问，逐项独立交付）

| 编号 | 问题 | 目标（不以“变好看”为判据） |
| --- | --- | --- |
| Q1 | 参考图保真度判据 | **已完成（run-010）**：docs/quality-reference-fidelity.md + fidelity.ts 五维指标 + 每迭代 fidelity.json；轮间稳定性保留为辅；run-001 数据已重解释 |
| Q2 | Eyes 结构化颜色 | **已完成（run-010）**：VisionEvidence schema + toEvidence 唯一闸门 + 本地确定性量化兜底（colorSource 标注）；colors.json 4/4 样本非空全 #RRGGBB；Eyes/Brain 分层保持 |
| Q3 | 中文泄漏 | **已完成（run-010）**：字段感知校验（core/css-strings + spec 接线）+ codegen 输出整表校验；真实链阻断 2 例泄漏；反例矩阵全绿（中文 description 合法保留） |
| Q4 | CSS 质量 | **已完成（run-011）**：结构化渲染（css-parse/css-render）+ 确定性输出 + 快照 + 结构校验；修复嵌套选择器整体无效与 @keyframes 损坏（真实链捕获） |
| Q5 | OVH 429 fallback | **已完成（run-011）**：VisionQueue（同 provider 串行/上限 4/QUEUE_CANCELLED）+ 缓存 v2 键（provider/model 入键、Windows 安全）+ 4MP 像素预算降采样 + 10 类失败分类；无叠加 retry（单元断言单次调用）；本地皮肤隔离验证 |

## 4. AI 线拆分（v1.2 → v1.4，每层独立验收）

- v1.2 Vision → SkinDesignSpec：参考图 → 合法 spec（判定 = schema 校验 + 图意比对）；问题定位域 = Vision。**已完成（run-012，PASS/CLOSED）**。
- v1.3 SkinDesignSpec → SkinPackage：spec → 包（判定 = 包契约 + CSS 语法 + 截图存在）；问题定位域 = LLM 生成 / CSS 实现。**已完成（run-013，PASS/CLOSED）**：Deterministic Package Builder（src/generator/package-build.ts，BuildConfig 显式化 + 单一产物校验器 + sealPackage integrity）；A/B/跨目录/跨进程字节级可复现；4 真实 Spec 构建 + :3081 安装烟测；失败域拆分 PACKAGE_BUILD/MANIFEST_BUILD/ASSET_BUILD/CSS_VALIDATION/PACKAGE_VALIDATION/INTEGRITY；规范见 docs/v1.3-package-build-audit.md + docs/v1.3-determinism.md。
- v1.4 Render → Diff → Repair：包渲染 → 参考图保真度 diff → DeepSeek 修复迭代（判定 = Q1 指标 + 收敛语义）；问题定位域 = 视觉验证。**已完成（run-014，PASS/CLOSED）**：RenderResult 元数据；WorstRegion 升级（页面区域映射/候选字段/裁剪件）+ Spec Responsibility Map；RegionEvidence（区域二次观察，统一坐标系 crop + Eyes seam，429→VISION_RECHECK 安全停止）；RepairDecision（结构化决策/白名单/保护路径/expectedEffect/预算/单次重问）+ specPatch + 振荡护栏；状态机 IMPROVED/UNCHANGED/REGRESSED/CONVERGED/OSCILLATION/MAX_ITERATIONS/FAILED；规范见 docs/v1.4-render-repair-audit.md + docs/v1.4-repair-decision.md + docs/v1.4-repair-policy.md。
- 链式定位规则：一层不过，绝不在另一层打补丁掩盖。

## 5. Workshop（v1.6~v1.7，与 Local Repository 解耦）

- LocalRepository / RemoteRepository 统一接口：search()/get()/download()/install()/publish()/update()。
- RemoteRepository 永远不得成为 SkinRuntime 的依赖；网络挂掉时本地皮肤完整可用（v1.0.0 已满足，保持）。

## 6. 版本与上游联动

- 上游 developer preview：每次上游升级 → 先跑 Phase 5 门 + 契约测试；发现破坏性变更 → docs/ 记录并仅调整适配层（src/index.ts 宿主胶水），不推倒冻结面。
- settings 网关白名单（WEB_SETTINGS_NAMESPACES）一旦上游开放 settings.register() 暴露 → /dsh-skin/api/active loopback 退役，作为兼容项保留一个版本。
