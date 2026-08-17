# VisionEvidence：图像事实的标准中间表示（v1.2）

## 定位
VisionEvidence = 事实；SkinDesignSpec = 设计决策。本层由 toEvidence() 归一化（唯一闸门），
颜色兜底为本地确定性量化（colorSource 标注）；region 证据 = layout[]（模型观察；vision_ground/crop 属 agent 工具 seam，宿主生成器不可调用——边界在案）。

## Schema（src/generator/vision.ts）
```
VisionEvidence {
  summary: string            // 观察总结（模型；空时散文前 500 字兜底）
  layout: [{region,content}] // 区域观察（模型）
  entities: string[]         // 元素清单
  colors: [{hex,share}[]]    // #RRGGBB（非法丢弃不伪造；空则本地量化兜底）
  text: string               // 画面文字
  raw?: string               // 原始响应（vision-raw.json）
  source?: {kind:'vision-json'|'vision-prose'|'fixture', provider?, model?}
  colorSource?: 'vision'|'local-quantization'|'none'
  meta?: {imageKey,provider,model,analysisVersion,cacheHit,at}  // iterate 写入 evidence.json
}
```

## 可信度与来源
每个事实可回答：是什么/来自哪里/如何得到/可信度如何——颜色经 colorSource+share；区域经 layout.region；
模型观察（vision-json）与散文（vision-prose）经 source.kind 区分；本地量化是确定性算法（可复现）。

