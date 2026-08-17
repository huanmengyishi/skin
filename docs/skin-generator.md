# Skin Generator（AI 生成 + 视觉验证，v0.3.0）

AI 只是 Skin Package Producer：图片 → 视觉证据 → 结构化 SkinDesignSpec → 模板代码生成 → 渲染 → 截图 → 像素 diff + 样式指纹 → 修复迭代 → 最终验证门 → 安装进本地仓库。
生成的皮肤与内置/本地皮肤共用同一 Skin Package 契约与同一 SkinRuntime。

## 管线

```text
POST /dsh-skin/api/generate { imageBase64, name, id?, author?, description?, tags?, maxIterations? }
  1. 检测视觉依赖（ctx.llm.listProviders() 含 vision-http = dsh-vision-router 已挂载）；缺失 → 503 显式报缺，绝不伪造
  2. 视觉证据（vision-http 路由 + 结构化 JSON 提问）→ generation/<run>/analysis.json
  3. DeepSeek（文本 provider）→ SkinDesignSpec → design-spec.json（schema 校验，失败即停）
  4. 迭代 i（maxIterations 默认 3，上限 8）：模板代码生成（确定性）→ 自包含预览 HTML → 无头浏览器截图 →
     pixel diff（pngjs 纯 JS，等尺寸最近邻归一）+ 渲染样式指纹（body/sidebar/overlay 计算样式）双判据
  5. 不收敛且未达上限 → brain.repair(spec, diffReport) → 下一轮；工件 iteration-N/{skin,preview.html,screenshot.png} 逐轮落盘
  6. 最终门：manifest 校验 + integrity 生成与复核 + runtime 形态（__ModuleLoader__ 工厂）+ 截图存在 → repository.install（staging+atomic）
  7. 报告 generation/<run>/report.json（迭代 diffRatio/converged/worstRegions/截图路径）
```

## 关键决策

- SkinDesignSpec（src/core/spec.ts）是视觉证据与代码之间唯一的可校验/可缓存/可 diff 中间层；视觉输出绝不直接拼代码。
- 代码生成是确定性模板（spec → manifest/theme/styles/preview），模型只产出 spec（可含 customCss，自动被皮肤 scope 包裹）。
- 视觉验证双判据：pixel diff（无头浏览器组合可能对 CSS 变化不敏感）+ 计算样式指纹（确定性），任一变化即不收敛。
- 跨平台浏览器发现（DSH_SKIN_CHROME_PATH → Windows Edge/Chrome → macOS → Linux）；vision-router 的 html_screenshot 探测仅 macOS，故自建。
- 无真实视觉 API 的环境用确定性 FixtureBrain（DSH_SKIN_TEST_MODE=1，测试专用，绝不冒充真实视觉）；LiveBrain 经 ctx.llm 调用 vision-http 与文本 provider。
- 生成入口仅 loopback + 同源；图片 ≤ 8MB（PNG/JPEG/WebP/GIF）。

## 验证

- 单元（62 用例含生成器 10 例）：spec 校验/slugify、diff 阈值与区域、codegen 确定性与 scope 约束、preview 自包含、fixture 全链路（缺失视觉明确失败/收敛路径/不收敛上限）、extractJson。
- 真实 GUI E2E-5：上传 PNG → 生成（3 轮真实无头截图 + 指纹判据）→ 工件落盘核验（input/analysis/design-spec/iteration-N/final/report）→ 安装 → 试穿 → 退出 → 卸载，同一 Runtime 无差别。


## 生成皮肤生命周期（v0.4.0）

- 来源分层：安装落位 generated/（builtin/installed/generated/downloaded 四根，优先级 installed > generated > downloaded > builtin）。
- 编辑 metadata：POST /dsh-skin/api/skins/:id/meta（name/author/description/tags，内置拒绝）——manifest 更新后 integrity.json 原子重算，registry 刷新。
- 导出：GET /dsh-skin/api/skins/:id/export → zip（fflate；统一 Skin Package 交换格式，E2E 验证 PK 头 + 可解包 + 内容一致；symlink 拒绝）。
- 重新生成：POST /dsh-skin/api/regenerate { skinId }（仅 generated）——从 generation 工作区读取既有 design-spec + 参考图，跳过视觉分析（无 vision-router 也能重生成），重跑迭代并以 replace（旧包挪垃圾桶 → 新包原子落位 → 失败回滚）覆盖安装。
- 命名：id 在生成时定（slugify + 用户可改）；Phase 4 提供 metadata 编辑，id 变更不提供（路径/激活状态迁移成本，文档化）。
- 验证：68 单测（replace 成功/失败回滚/内置拒绝、initialSpec 无视觉重生成、zip 往返与 symlink 拒绝）+ E2E-6 全生命周期。
