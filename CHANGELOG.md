# Changelog

本项目版本以语义化版本发布（run-NNN 为本地验收证据编号，非版本号）。

## [1.5.0] - 2026-08-17

### Added

- AI Skin Lifecycle（本地生命周期：创建/重新生成/取消/恢复/重装/导出）
- GenerationRecord / GenerationStore（原子索引）+ GenerationService（状态机、同 skin 并发锁、版本 patch++、父子链）
- 两段式生成 API（create → run，可轮询/取消）+ 设计编辑（Spec Patch → 新版本）+ 重新安装
- Skin Center「My AI Skins」面板与生成状态/取消/历史 UI
- 崩溃恢复（RUNNING 记录对账 → FAILED/RECOVERY）

### Foundation（随本版本发布的历史验收）

- Phase 0~5：Skin Package/Repository/Runtime/Center + A~J 集成门（run-009）
- v1.1.x Quality：Q1 参考图保真度、Q2 结构化视觉证据、Q3 中文泄漏、Q4 CSS 结构化渲染、Q5 视觉 provider 韧性（run-010/011）
- v1.2 Vision → SkinDesignSpec：证据/设计分层 + provenance + 一致性校验（run-012）
- v1.3 SkinDesignSpec → SkinPackage：确定性构建（跨目录/跨进程字节级一致）（run-013）
- v1.4 Render → Diff → Repair：最差区域诊断/区域二次观察/结构化修复决策/振荡与退化护栏（run-014）

### Validation

- 单元/契约/集成：232/232（40 文件）
- E2E：9/9（含生命周期 UI 全链）
- 基础回归：A/B/C/D/G/H 实跑 PASS；F/I/J 契约测试；E=run-002 生产验收门
- 生产环境 untouched（本地验收证据 run-009~run-015）
