# SkinDesignSpec：设计决策契约（v1.2）

## 定位
Spec = 设计决策（DeepSeek 解释）；输入事实来自 VisionEvidence。字段分层校验（v1.2 §18）：
Layer1 schema（required/types/enums）、Layer2 字段语义（Q3：hex/CSS 片段/字体规则）、Layer3 证据一致性（兼容判定）。

## Schema（src/core/spec.ts；v1.2 增 provenance?）
```
SkinDesignSpec {
  visualStyle, colorPalette[{hex,role,share}], typography{family,mono}, spacing{density,radius},
  shapeLanguage/borderStyle/shadowStyle/backgroundStyle/headerStyle/sidebarStyle/messageStyle/
  inputStyle/buttonStyle/cardStyle/iconStyle（CSS 声明片段）, chromeElements[], decorativeElements[],
  assetCandidates[], customCss?, provenance?: SpecProvenance
}
```

## 证据 → Spec 映射规则
- colorPalette.hex 必须取自 evidence.colors（角色分配是设计）；偏离 → WARN + interpretation 记录。
- CSS 字段/typography/spacing = 模型设计（依据 summary/layout），逐字段 provenance 标注 model-design。
- layout/entities 只解释不改写（system 提示明示）。
- visualStyle = 对 summary 的设计解释（允许自然语言，Q3 合法）。

## 一致性策略（§19）
兼容而非相等：所有 spec 颜色与证据色最近距离均 > 120 → WARN（记录，不 REJECT）；
非法 hex 仍 REJECT（Layer2）。证据无颜色 → WARN 要求显式 fallback 标注。

