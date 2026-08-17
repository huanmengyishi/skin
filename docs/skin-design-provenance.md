# SkinDesignProvenance：来源追踪模型（v1.2）

## 模型
```
SpecProvenance {
  fields: Record<fieldPath, {source: 'vision'|'local-quantization'|'model-design'|'fallback', ref?, note?}>
  evidenceRef: {imageKey?, provider?, model?, analysisVersion?}
  interpretation: string[]   // DeepSeek 输出的设计解释（≤8 条）
}
```

## 构建规则（src/generator/provenance.ts）
- 颜色：最近邻匹配 evidence.colors（距离 ≤120）→ source=vision/local-quantization + ref（evidence.colors[i]）；否则 model-design + 偏离 note。
- 其余字段：model-design + 语义 note；禁止全字段统一 source=vision。
- 缓存命中后 provenance 重建（evidenceRef 随缓存元数据写入，不随缓存丢失）。

## 追踪链
spec.colorPalette[0] → evidence.colors[2] → colorSource → imageKey/provider/model/analysisVersion（provenance.json + evidence.json.meta + cache-log.json）。

## 安全
只记录 image hash/provider/model/version/region/confidence；禁止 API key/会话秘密/token。

