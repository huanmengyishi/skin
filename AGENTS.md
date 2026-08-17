# AGENTS.md — dsh-skin 协作规范

> 本文是 dsh-skin（DeepSeek Harness 皮肤系统插件）项目内的 Agent 协作规范。
> 任何后续会话 / 子代理在动手前必须先读本文件与 docs/SKIN_ARCHITECTURE_AUDIT.md，再读对应阶段所涉源码。
> 任务总纲：D:\deepskin\目标.md（以它为准，本文件是其执行化浓缩，冲突时以目标.md 为准）。

## 1. 项目目标（一句话 + 三阶段）

为官方 DeepSeek Harness 开发**独立插件 dsh-skin**，建立可扩展、可安装、可切换、可试穿、可 AI 生成、可网络共享的完整皮肤生态。

- 阶段一：完整本地皮肤系统（Skin Package 规范 / 注册表 / 内置皮肤 / 皮肤中心 / 预览 / 试穿 / 应用 / 切换 / 恢复默认 / 卸载 / 生命周期 / 作用域隔离 / 本地仓库 / 构建 / 测试 / 文档）。完成后即使没有 AI 与网络，生态也完整可用。
- 阶段二：AI 自定义皮肤。图片 → dsh-vision-router 视觉分析 → 结构化 SkinDesignSpec → DeepSeek 生成 → 构建 → 截图 → 视觉 diff → 自动修正 → 最终 Skin Package → 本地仓库 → 命名 → 预览/试穿/应用。AI 皮肤只是 Skin Package 的一种来源，与普通皮肤共用同一协议与 Runtime。
- 阶段三：Wallpaper Engine 式网络皮肤共享（浏览/搜索/标签/下载/安装/更新/收藏/发布/举报/安全检查/兼容性检查）。网络皮肤与本地皮肤使用统一 Skin Package。

最终实体统一进入同一 Skin Repository：Built-in / Local / AI Generated / Downloaded / Published。

## 2. 总进度协议：Phase 0 → Phase 10

严格按序推进，禁止跳阶段、禁止把三阶段混成一个巨大版本。每个 Phase 独立可运行。

| Phase | 内容 | 计划版本 | 状态 |
| --- | --- | --- | --- |
| 0 | 架构审计 + 协作规范 + 实施方案（决策 D1~D6 已确认） | — | 完成 |
| 1 | Skin Foundation：Manifest/Validator/Repository/Registry/Runtime/SkinContext/activeSkin 持久化/内置皮肤/最小验证入口 | v0.1.0 | 完成（46 单测 + 3 真实 GUI E2E + tsc + 双面构建全绿） |
| 2 | Skin Center：Gallery/Detail/Preview/Try-on/Apply/Switch/Restore Default + 搜索过滤排序 + 安装/卸载 | v0.2.0 | 完成（52 单测 + 4 真实 GUI E2E + tsc + 构建全绿） |
| 3 | AI Skin Generator + Visual Verification（一个完整产品阶段，不拆分） | v0.3.0 | 完成（62 单测 + 5 真实 GUI E2E + tsc + 构建全绿；LiveBrain 已接 ctx.llm，E2E 走确定性 fixture） |
| 4 | Generated Skin Lifecycle（命名/编辑/重新生成/导出/重装） | v0.4.0 | 完成（68 单测 + 6 真实 GUI E2E + tsc + 构建全绿） |
| 5 | Workshop 读取：浏览/搜索/详情/下载/安装/更新（网络层只管 search/metadata/download） | v0.5.0 | 完成（76 单测 + 7 真实 GUI E2E + tsc + 构建全绿） |
| 6 | Workshop 发布：Validate→Build verify→Integrity→Upload→Published + 更新/举报 | v0.6.0 | 完成（79 单测 + 8 真实 GUI E2E + tsc + 构建全绿） |
| 7 | 安全/兼容/治理 + 最终集成（Trusted/Untrusted、zip-slip、兼容矩阵、Windows 专项、完整 E2E、最终文档） | v1.0.0 | 完成（85 单测 + 8 真实 GUI E2E + tsc + 构建全绿；docs 八篇齐备） |

**每个 Phase 的十步流程（必须执行）：**
1. 阅读相关源码（先于任何编码）；2. 明确当前 Harness API（只信源码，不信猜测）；3. 明确依赖；4. 明确修改文件；5. 明确测试；6. 实现；7. 测试；8. 修复；9. 更新文档；10. 输出完成报告。

**Phase 0 完成后暂停**，向用户呈交审计结论与实施方案，经确认后才进入 Phase 1。其它 Phase 完成后同样报告，不自动冲向下一个 Phase。

## 3. 参考资料本地路径（必须读真实源码，禁止凭 README 猜架构）

| 参考项目 | 本地位置 | 用途 |
| --- | --- | --- |
| DeepSeek Harness（宿主） | D:\deepskin\deepseek-harness | 唯一宿主。插件机制、bundle、web、fs、settings、attachment 以当前 master 实际源码为准 |
| dsh-web-ui（dsh-skins 全家桶） | C:\Users\deco1\.dsh\profiles\node_modules\@linxin666\dsh-skins 与 @linxin666\dsh-client-ui-skin-center | 思想参考（skin.json 单一事实源 / registry / apply-dispose / try-on / atomic / 互斥启用）。**禁止照搬代码结构** |
| dsh-vision-router | C:\Users\deco1\.dsh\profiles\web\node_modules\dsh-vision-router | 第二阶段视觉能力（vision_describe / colors / crop / ground / trace / extract_foreground / html_screenshot / pixel_diff） |
| 在线仓库 | github.com/deepseek-ai/deepseek-harness、github.com/zhu1090093659/dsh-web-ui、github.com/ysr666/dsh-vision-router | 对照上游 |

Harness 必读文档（进入 Phase 1 前逐篇过）：AGENTS.md、docs/AGENTS.md、docs/architecture.md、docs/cordis-primer.md、docs/module-graph.md、docs/web-styling.md、docs/persistence-catalog.md、docs/config-catalog.md、docs/capability-seams.md、docs/defensive-patterns.md、docs/testing.md、docs/development.md、packages/README.md。

**"适配而不是搬运"清单：** dsh-web-ui 的 skin.json 单一事实源、Skin Package、registry、scope、apply/dispose、try-on、managed patch、atomic write、resolvability check、client-only skin、preview、repository 是"可复用的思想"；Harness 的 Cordis API、bundle 机制、Web UI、settings、fs、plugin lifecycle、profile/patch、命名、构建、测试体系是"必须重新适配的现实"。最终代码必须像原生 Harness 插件。

## 4. 硬性纪律（违反即返工）

1. **先研究后编码**：不确定的 API 先 grep 源码验证，禁止凭经验写 ctx.xxx() 然后等测试失败。
2. **不污染 Core**：优先 Plugin → 现有扩展点。确需改 Harness core 时，先书面回答：为什么插件做不到、缺哪个扩展点、最小改动是什么、是否影响其他插件、能否提通用扩展点、是否该提交 upstream。禁止为皮肤 fork / 大改 Harness。
3. **所有副作用可回收**：DOM / CSS / observer / listener / timer / subscription / service registration 都必须有明确 disposer；apply/dispose 为核心契约；dispose 只移除自己拥有的效果，绝对禁止 document.body.innerHTML=…、清空全部 style、删除他人 DOM。
4. **失败必须回滚**：install / apply / try-on / switch / AI generation / download 全部需要 rollback 路径；安装必须 staging + atomic rename，禁止直接覆盖 installed/。
5. **不虚报成功**："patch written" ≠ "skin activated"。必须确认 package resolvable → bundle available → runtime loaded → apply succeeded 才算成功。
6. **任意时刻最多一个激活皮肤**；A→B 切换失败必须清理 B 的 partial effects 并恢复 A；不能出现 A+B 并存。
7. **试穿不改持久配置**，epoch/generation 防竞态，覆盖快速连点、加载失败、页面关闭、资源缺失等边界。
8. **信任边界**：第三方皮肤 = untrusted code；不得默认获得文件系统/网络/密钥/会话；Harness 权限模型优先；做不到沙箱就明确标注 Trusted / Untrusted 状态，不假装安全。本地路径防穿越、防 zip-slip、防 symlink 攻击、防 id 冲突与保留字。
9. **可选依赖不阻断核心**：Vision Router 缺失 → 阶段一照常；Workshop 不可用 → 本地皮肤照常。阶段二检测依赖并给出明确缺失提示，禁止静默伪造视觉结果。
10. **Vision = Eyes，DeepSeek = Brain**：视觉输出必须转成结构化 SkinDesignSpec 再交给代码生成器，禁止把视觉文本直接拼进代码；迭代有 maxIterations（默认 3，可配置），中间产物进 cache/generation 工作区，不污染正式 Skin Package。
11. **Windows 一等公民**：路径分隔符、user data 目录、junction/symlink、文件锁、rename、atomic 替换、大小写敏感都要测；禁止只按 Linux 行为实现。
12. **测试与文档同 PR 交付**：每个核心机制有单元测试（见目标.md §32 清单），E2E 覆盖 install→center→try-on→apply→reload→switch→default 全链路；视觉链路无真实 API 时提供 deterministic fixture。

## 5. 架构铁律（组件边界）

- Skin 是插件体系中的**资源实体**，不是独立于 Harness Plugin System 的第二系统。
- **Skin Runtime**（apply/dispose/switch/try-on）与 **Skin Repository**（discover/install/uninstall/metadata/storage/integrity/versions）分离。
- **Skin Center**（UI）与 Runtime 分离：UI 只经 service/controller/API 操作，不直接改皮肤内部状态。
- **AI Generator**（Image→Spec→Package）不碰 DOM；**Network Repository**（search/download/upload/metadata）不碰本地 install 语义。
- **统一 Skin Package** 是唯一数据契约；SkinManifest 含 id/version/name/nameEn/author/description/tags/category/accent/preview/runtime/compatibility/source/license/createdAt/updatedAt/dependencies/integrity；compatibility 声明 harness 版本 + 独立 skinApiVersion（三者分治，不硬编码宿主版本）。
- 每个皮肤唯一 scope（如 body[data-dsh-skin="<id>"] 的命名空间思路），SkinRuntimeContext 提供 ctx.effect / ctx.on / ctx.addStyle / ctx.addElement / ctx.addAttribute / ctx.addObserver / ctx.addTimer 等可追踪副作用 API。
- 本地仓库路径必须基于 Harness 官方 user-data/storage 机制（~/.dsh/storages 或 settings-file 对应根），禁止自造第二套配置根；registry 元数据走 storage-domain（$DSH_HOME/storages/<domain>.json 原子整文件重写），皮肤包目录 $DSH_HOME/skins/{installed,generated,downloaded,cache,staging} 走 ctx.fs，install 两阶段提交 + 启动对账（审计决策 D6）。
- 构建链路 source→build→validate→package→integrity→installable；优先复用 Harness client bundle 体系，不重造 module loader。

## 6. 工作区与交付物约定

- 插件项目根：D:\deepskin\dsh-skin（最终 npm 名形如 dsh-skin / @dsh-skin/*，以 Harness 插件命名与发布方式为准）。
- 文档：dsh-skin/docs/，最终至少 skin-architecture.md、skin-package.md、skin-runtime.md、skin-center.md、skin-generator.md、skin-workshop.md、skin-security.md、skin-authoring.md（第三方开发者不看插件内部源码即可开发皮肤）。
- Phase 0 交付：docs/SKIN_ARCHITECTURE_AUDIT.md（回答目标.md §40 全部 25 问 + What Harness provides / What dsh-web-ui provides / What vision-router provides / What we must implement / What NOT to implement）、docs/SKIN_REFERENCE_MAPPING.md（dsh-web-ui → Harness 映射表）、docs/SKIN_IMPLEMENTATION_PLAN.md（每 Phase 的 Goal/Files/Architecture/Dependencies/Tests/Acceptance Criteria/Risks）。
- 阶段完成报告格式：目标 → 修改文件（用相对路径列出）→ 测试结果（命令+结论）→ 验收对照 → 未决风险 → 下一步（暂停或下一 Phase 声明）。

## 7. 版本规划（每个版本独立可运行）

v0.1.0 Skin Foundation（Manifest→Validator→Repository→Registry→Runtime→SkinContext→activeSkin→内置皮肤→最小验证入口）→ v0.2.0 Skin Center（Gallery/Detail/Preview/Try-on/Apply/Switch/Restore Default）→ v0.3.0 AI Skin Generator + Visual Verification（一体阶段）→ v0.4.0 Generated Skin Lifecycle → v0.5.0 Workshop 读取/下载/安装 → v0.6.0 Workshop 发布/更新/举报 → v1.0.0 安全/兼容/治理 + 最终集成。

## 8. 与宿主的协作边界

- 本插件是独立仓库/包，不在 deepseek-harness 仓库内改任何文件；如需联调，用宿主已提供的 profile/patch/loader 机制安装插件，绝不把皮肤逻辑塞进 packages/。
- 若审计发现宿主缺失扩展点：先在 SKIN_ARCHITECTURE_AUDIT.md 记录证据，按 §4.2 流程决策，默认走"插件内自足"路线。
- 宿主仍处 developer preview（当前 0.1.0-rc.5），API 可能破坏性变更：skinApiVersion 机制与兼容性声明就是为此设计；每次新 Phase 开始先重新核对宿主 master 源码。
