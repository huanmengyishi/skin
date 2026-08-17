# dsh-skin

DeepSeek Harness 皮肤生态插件（host + client 双面 Cordis 插件）：统一 Skin Package、本地 Skin Repository、Skin Runtime、Skin Center，以及完整的 AI 皮肤生成链与生命周期管理。

- 版本：**v1.5.0**（MIT License）
- 平台：DeepSeek Harness（developer preview，@deepseek-ai/cordis）——纯插件实现，不修改 Harness Core

## Features

- **统一 Skin Package**：manifest + theme tokens + 作用域 CSS + client entry + integrity（sha256），skinApiVersion=1。
- **本地 Skin Repository**：$DSH_HOME/skins/{installed,generated,downloaded,cache,staging}；staging → 校验 → integrity → atomic rename 安装；symlink/穿越/可执行/远程 URL 拒绝；冲突与回滚语义。
- **Skin Runtime**：apply/dispose/switch/try-on；SkinContext 所有权追踪（effect/addStyle/addElement/addAttribute/addObserver/addTimer/theme tokens），dispose 后零残留；activeSkin 持久化走官方 settings seam（插件 loopback API）。
- **Skin Center**：Gallery/Detail/搜索/标签/来源/排序、Try-on/Apply/Restore、卸载、导出。
- **AI 皮肤生成链**：
  - v1.2 Vision → SkinDesignSpec（结构化证据 + 逐字段 provenance + 证据一致性校验）
  - v1.3 确定性 Package Builder（同 Spec+BuildConfig ⇒ 字节级一致）
  - v1.4 Render → Diff → Repair（五维保真度、最差区域诊断、区域二次观察、结构化 RepairDecision/Spec Patch、振荡与退化护栏）
  - v1.5 AI Skin Lifecycle（GenerationRecord/状态机/取消/崩溃恢复/版本演进/设计编辑/导出/卸载重装）
- **Workshop**：planned（v1.6 起，本版本 Local only）。

## Architecture

```text
AI Generator → SkinPackage → SkinRepository → SkinRuntime → SkinController → Skin Center
```

设计文档见 docs/：BASELINE.md（冻结面）、skin-api-contract.md（契约）、IMPLEMENTATION_PLAN.md（路线图）、ACCEPTANCE_MATRIX.md（验收矩阵）、v1.2~v1.5 各阶段审计与规范。

## Requirements

- Node.js ≥ 20（开发；运行时由 DeepSeek Harness 提供）
- pnpm（开发构建）
- 无头浏览器（Edge/Chrome，AI 生成的视觉验证截图使用；可用 DSH_SKIN_CHROME_PATH 指定）
- AI 生成功能需要宿主编译进 DeepSeek 文本 provider 与 dsh-vision-router（vision-http 路由）

## Installation

构建产物发布：

```sh
pnpm install
pnpm run build   # 产出 lib/index.mjs（host）与 lib/client.js（client factory bundle）
```

安装到 Harness profile：

```sh
dsh plugin --profile <name> add <本目录或发布包>
```

或按 Harness 惯例在 profile 的 package.json 中声明依赖并加入 `dsh.profile.bundles`（本仓库 cordis.patch.yml 即 bundle patch）。

## Development

```sh
pnpm run typecheck   # tsc --noEmit
pnpm test            # vitest 单元/契约/集成矩阵（Windows 一等公民：junction/symlink/rename 真实文件系统）
pnpm run build       # tsdown
```

E2E（需本地 Harness 实例 + 开发 profile）：

```sh
# 启动 fixture 模式实例（DSH_SKIN_TEST_MODE=1，端口 3099）
vitest run --config vitest.e2e.config.ts
```

真实 AI 链（Vision + DeepSeek）依赖宿主 profile 中的 provider 配置（凭据保存在 Harness profile，不进入本仓库）。

## AI Skin Generation

```text
Reference Image → VisionEvidence → SkinDesignSpec → Deterministic SkinPackage
  → Real Render → Reference Fidelity → Worst Regions → Vision Re-observation
  → DeepSeek RepairDecision → Spec Patch → Rebuild → Re-render → Converge/Stop
```

每代生成（generationId + parent 链）可查询、可取消、可恢复；重新生成/设计编辑走同一确定性构建与修复闭环并产生新 Package 版本；卸载保留历史，可无模型重装。

## Configuration

- 插件唯一持久化设置：activeSkin + workshopUrl（settings seam 的 dsh-skin 段）。
- 视觉截图浏览器：DSH_SKIN_CHROME_PATH。
- 视觉模型/文本模型 provider 在 Harness profile 配置（vision-http 由 dsh-vision-router 提供）。

## Security

- 第三方/下载皮肤 = untrusted（trustOf(source)）；安装期静态安全门（可执行/远程 URL/symlink/zip-slip）。
- AI 修复决策受白名单与结构化校验约束（无 shell/文件系统/网络/任意代码路径）。
- 生成工作区（vision raw/证据/迭代工件）local only，不进正式 SkinPackage。

## Roadmap

- v1.6 Workshop Read / Download
- v1.7 Workshop Upload / Publish
- v1.8 Security / Compatibility
- v2.0 Skin Ecosystem

## License

MIT（见 LICENSE）。参考实现（dsh-web-ui / dsh-vision-router）仅作思想借鉴，不包含其代码与资产。
