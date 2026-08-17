# dsh-skin Quality：Reference Fidelity 指标定义（Q1）

> 状态：v1.1.x Quality Task A 的指标规范。指标必须可解释；不用单一 pixel ratio 作为完整质量判据；
> 不设僵化阈值（score>=0.9=pass 之类），先建立可解释指标。

## 1. 基本定义（回答 10 问）

1. **什么是参考图？** 用户提交的参考图片（生成输入 input.png 的原字节）。
2. **什么是生成截图？** 生成皮肤包的 preview.html 经无头浏览器（puppeteer-core + Edge/Chrome 跨平台发现）渲染的 1200x720 PNG——即用户将看到的皮肤渲染。
3. **什么区域应该比较？** 全图。参考图在比较前按最近邻缩放/裁剪至生成截图尺寸（先等比缩放覆盖，再居中裁剪），避免长宽比差异扭曲。
4. **全图 diff 是否足够？** 不够。全图像素 diff 对纹理丰富的照片过严、对纯色皮肤过松，必须与颜色/布局/区域指标并置解释。
5. **颜色差异如何计算？** 双方分别做 4-bit 每通道量化（64 级直方图），取 Top-N bin 作为调色板；调色板相似度 = 直方图交集 + 主导色逐对最近距离均值。
6. **布局差异如何计算？** 4x4 网格每格灰度均值构成 16 维向量，余弦相似度表达明暗结构分布。
7. **局部区域如何处理？** 8x8 网格逐格平均通道差：记录均值与最差格；worstRegions 沿用既有 diff.ts 的 8x8 最差区域（与 vision_pixel_diff 语义对齐）。
8. **哪些差异属于预期 Harness UI 差异？** 预览页本身带 Harness 壳（预览容器/占位灰块）；这些差异恒定存在，因此指标只做相对解释（迭代间改善/样本间比较），不做绝对达标线。
9. **什么情况表示「改善」？** 同一参考图下，较后迭代的 referenceFidelity 不下降且 iterationStability 上升（或 repair 未使 fidelity 变差）。
10. **什么情况表示「没有收敛」？** iterationStability 持续显著（diffRatio 高于既有 CONVERGENCE_THRESHOLD 且指纹变化）直到 maxIterations；或 referenceFidelity 在最后一轮仍低于第一轮。

## 2. 三类指标（禁止混成一个数）

| 类别 | 比较对象 | 含义 | 主/辅 |
| --- | --- | --- | --- |
| Reference Fidelity | 生成截图 vs 参考图 | 是否越来越像参考图 | **主** |
| Iteration Stability | 迭代 N vs N+1 截图 | 修改是否趋于稳定 | 辅（沿用既有收敛判据） |
| Runtime Correctness | build/apply/dispose/screenshot | 生成链是否正常运转 | 前置条件（不满足=生成失败，不计入质量） |

## 3. fidelity.json 结构

```json
{
  "reference": "input.png",
  "generated": "iteration-N/screenshot.png",
  "metrics": {
    "palette": { "intersection": 0..1, "dominantDistance": 0..441.7, "referenceTop": ["#rrggbb"], "generatedTop": ["#rrggbb"] },
    "layout": { "cosine": -1..1 },
    "region": { "meanDelta": 0..255, "worstCell": { "x1,y1,x2,y2": 0..255 } },
    "pixel": { "diffRatio": 0..1, "threshold": 16 },
    "structure": { "nonBlank": true }
  },
  "iteration": { "stability": { "diffRatio": 0..1, "fingerprintChanged": true|false } },
  "interpretation": { "summary": "…", "improved": true|false|unknown, "converged": true|false }
}
```

## 4. 边界与职责

- 本地像素度量（pngjs 解码 + 量化）是 dsh-skin 既有生成闭环的一部分（diff.ts 同源，因 sharp 原生绑定问题而采用），**不构成对 vision-router 像素工具的重实现**；视觉语义观察（Eyes）只经 llm seam 的 vision-http。
- 参考图 JPEG 解码经无头浏览器 canvas 转 PNG（复用既有 puppeteer 栈，不新增依赖、不重新实现解码器）。
- 生成循环的停止判据保持既有 Iteration Stability 语义（v1.0.0 行为冻结）；Reference Fidelity 本阶段作为评估与诊断数据落盘，循环行为改造属 v1.4。

