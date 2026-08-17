# dsh-skin Quality：CSS 生成链审计与结构化策略（Q4）

> 状态：v1.1.x Quality Task B。先审计后修改；目标是结构化/确定性/可验证，不是 regex 清洗。

## 1. 当前 CSS 生成路径（审计于本文件落笔时）

SkinDesignSpec → codegen.cssFromSpec → theme.css：
- 模板字段：font-family / border-radius / 槽位选择器由模板生成；
- DeepSeek 自由文本字段：shapeLanguage/backgroundStyle/sidebarStyle/cardStyle/borderStyle/shadowStyle/inputStyle/buttonStyle/iconStyle/customCss 直接字符串拼接；
- customCss 原样嵌入 scope 块内部。

## 2. 既有缺陷（v1.0.0 实测）

1. **`;;`**：字段已带分号 + 模板补分号（run-001 实证）。
2. **空声明块**：字段为空时输出 `selector { ; }`。
3. **嵌套选择器整体无效**：槽位规则与 customCss 被放进 `body[data-dsh-skin]` 块内部——嵌套规则是非法 CSS，浏览器静默丢弃（皮肤视觉效果实际只来自 token 覆盖）。
4. 自由文本拼接导致输出不稳定、无法 snapshot。

## 3. 允许的 CSS 文法（结构化层）

- 声明片段字段：`property: value;` 序列（引号感知分号切分；无冒号片段丢弃并记 issue）；
- customCss：完整规则文本（Q3 已校验平衡），作为顶层块输出在 scope 之外；
- 输出统一：`selector {` + 缩进两空格声明 + `}`，块间空行，顺序固定。

## 4. 校验点

- 生成后 parseStylesheet（core/css-parse.ts）：块/声明结构解析 + 空声明块/重复声明/重复选择器/未配对/引号外 CJK 检测；
- 失败域：CODEGEN_OUTPUT / CSS_VALIDATION（与 Q3 的 SPEC 域衔接，双道防线）。

## 5. 确定性输出策略

同 spec → 同 theme.css：块顺序固定（body 基础 → 槽位 → 输入/按钮 → 代码 → 图标 → customCss）；声明按 parse 顺序去重（同属性首个胜出，记 issue）；白空/分号/换行固定。snapshot 锁定。

