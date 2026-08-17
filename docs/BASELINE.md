# dsh-skin 开发基线 BASELINE

> 本文件是 dsh-skin 的**冻结基线声明**。任何 Agent 开始任何工作之前必须先读本文件。
> 最后更新：2026-08-16（run-001 真实链验收 + run-002 生产 profile 验证完成后）。

## Version

`dsh-skin v1.0.0`（代码库 D:\deepskin\dsh-skin；构建基线 deepseek-harness @ 47f9438 / 0.1.0-rc.5）

## 验收状态（已闭环证据）

| 维度 | 结论 | 证据 |
| --- | --- | --- |
| Runtime | **PASS** | run-002 A/B/D（apply/refresh/restart/restore/switch 全链） |
| Lifecycle | **PASS** | run-002 B/C（试穿→应用→刷新→重启→还原，多次循环） |
| Pipeline | **PASS** | run-001（真实 Vision + 真实 DeepSeek → 包 → 仓库） |
| Repository | **PASS** | run-001 install + run-002 /api/install → skins/installed |
| Vision | **PASS** | run-001 vision/analysis.json（Qwen2.5-VL 真实观察） |
| DeepSeek | **PASS** | run-001 design/design-spec.json + design-raw.txt |
| Production Validation | **PASS** | run-002（A 共存 / B clean / C gallery / D 六连压力 / E 真实对话保护，v1.0.1 production profile validation = PASS） |

- 验证产物目录：`D:\deepskin\图库\dsh-skin-test\run-001`（真实链验收）、`run-002`（生产 profile 验证，含 gui/*.png 与 stage-*.json 逐步证据）。

## Known non-blocking（已知非阻塞项）

1. Restore Default 当次会话内 body 残留空 `style=""`，刷新即消失（不持久、无视觉影响，低优先级；已列入 Phase 2 专项测试）。
2. run-002 E2 首条对话为测试驱动失误（新会话未打开即发送），按正确流程重做通过——非插件缺陷。
3. ~~Skin Center Apply 失败产生未处理 rejection（UI 层）~~——已于 Phase 4（run-008）修复：全部生命周期操作经 SkinController 统一 try/catch 展示（P4-3 pageerror=[]）。

## FROZEN（冻结面——v1.1.x 质量工作不得擅自重构）

- Skin Runtime（apply/dispose/switch/tryOn/exit、SkinContext 效果面）
- Apply/Restore 语义（activeSkin 持久化、失败回滚、dispose 验证）
- persistence model（settings seam 的 dsh-skin namespace + /dsh-skin/api/active loopback）
- production installation model（profile package.json `dsh.profile.bundles` + `profiles/node_modules/dsh-skin` junction）
- Skin Package 契约（manifest/theme/styles/client/integrity，skinApiVersion=1）
- Repository 目录布局（skins/{installed,generated,downloaded,cache,staging}，precedence installed>generated>downloaded>builtin，trust=downloaded→untrusted）

> **规则：v1.0.0 已验收。v1.1.x Quality 问题（保真度、Eyes 结构化、中文泄漏、CSS 质量、429 fallback）单独成线，不因 Quality 问题重构上述冻结面。** 确需改动时先过架构否决门并升级 minor 版本。

## 开发沙盒（v1.1+ 唯一执行环境）

```powershell
$env:DSH_HOME = "D:\deepseek\dsh-dev-home"
cd D:\deepskin\deepseek-harness
pnpm dsh web --port 3081
```

- 源码：`D:\deepskin\dsh-skin`
- 开发 profile：`D:\deepseek\dsh-dev-home`（已装 dsh-skin link，activeSkin=default）
- 验证端口：`:3081`（重启/破坏不影响生产）
- 生产环境（只读心态）：`D:\deepseek\deepseek-harness` + `C:\Users\deco1\.dsh` + `:3080`——v1.1.x 开发**禁止**直接进入；仅在专门的生产验收阶段操作。

## 修改 → 验证闭环

```text
修改源码 → 构建（tsdown）→ 开发 profile（dsh-dev-home）→ :3081 验证 → 记录 → 停止
```

## 历史文档

本目录旧文档（SKIN_*.md、skin-*.md、phase0-notes/00-*.md）为 v1.0.0 建设期档案；v1.1+ 以本基线 + 本次 Phase 0 审计产出的 ARCHITECTURE_AUDIT.md / REFERENCE_MAPPING.md / IMPLEMENTATION_PLAN.md / ACCEPTANCE_MATRIX.md 为准。
