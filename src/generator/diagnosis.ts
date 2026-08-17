/**
 * v1.4 诊断层：WorstRegion 升级（id/bbox/metric/score/rank/页面区域/问题域/候选字段/裁剪件）、
 * Spec Responsibility Map（页面区域 → 候选 Spec 字段）、metricDelta（多目标退化护栏的输入）、
 * 区域裁剪（统一 1200×720 坐标系内 pngjs 裁剪 + 最近邻放大，供 Vision 二次观察）。
 * 诊断 = Evidence：只产出结构化事实与候选提示；最终修改决策归 DeepSeek（repair.ts）。
 * @module dsh-skin/src/generator/diagnosis
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { computePixelDiff } from './diff.ts'
import type { FidelityMetrics } from './fidelity.ts'
import type { VisionEvidence } from './vision.ts'

export type IssueDomain = 'PALETTE' | 'LAYOUT' | 'TYPOGRAPHY' | 'SHAPE' | 'BACKGROUND' | 'DECORATION' | 'STRUCTURE' | 'UNKNOWN'
export type PageRegion = 'sidebar' | 'conversation' | 'input' | 'overlay' | 'unknown'

export interface Bbox { x1: number; y1: number; x2: number; y2: number }

export interface WorstRegion {
  id: string
  bbox: Bbox
  /** 指标归属：pixel=逐像素差异率最差格；region=平均通道差最差格 */
  metric: 'pixel' | 'region'
  score: number
  rank: number
  pageRegion: PageRegion
  likelyIssueDomain: IssueDomain
  candidateSpecFields: string[]
  referenceCropPath?: string
  generatedCropPath?: string
}

export interface MetricDelta {
  paletteIntersection: number
  paletteDominantDistance: number
  layoutCosine: number
  regionMeanDelta: number
  pixelDiffRatio: number
  structureNonBlank: 'stable' | 'true->false' | 'false->true'
}

export interface RegionEvidence {
  regionId: string
  bbox: Bbox
  observation: string
  colors: Array<{ hex: string; share: number }>
  text: string
  shape: string
  source?: { kind: string; provider?: string; model?: string }
  degraded: boolean
  provenance: { imageKey?: string; provider?: string; model?: string; analysisVersion?: string }
}

/** 壳 mock 固定几何：sidebar 220px；overlay 右上（right:24 top:24 宽 280）；输入区在会话区底部（y≥500）。 */
const SHELL_GEOMETRY = { sidebarWidth: 220, overlayRight: 24, overlayTop: 24, overlayWidth: 280, overlayBottom: 200, inputTop: 500 }

/** Spec Responsibility Map：页面区域 → 候选 Spec 字段（提示用；最终决策归 DeepSeek）。 */
export const SPEC_RESPONSIBILITY_MAP: Record<PageRegion, string[]> = {
  sidebar: ['sidebarStyle', 'headerStyle', 'typography', 'colorPalette', 'spacing', 'backgroundStyle'],
  conversation: ['cardStyle', 'messageStyle', 'backgroundStyle', 'typography', 'colorPalette'],
  input: ['inputStyle', 'buttonStyle', 'borderStyle', 'spacing.radius', 'colorPalette'],
  overlay: ['cardStyle', 'borderStyle', 'shadowStyle', 'colorPalette'],
  unknown: ['colorPalette', 'typography', 'spacing', 'backgroundStyle'],
}

/** 全局问题域的候选字段（palette/layout 指标主导时）。 */
export const GLOBAL_CANDIDATES: Record<'PALETTE' | 'LAYOUT', string[]> = {
  PALETTE: ['colorPalette'],
  LAYOUT: ['spacing.density', 'spacing.radius', 'backgroundStyle', 'shapeLanguage'],
}

/** bbox 中心 → 页面区域（固定壳几何；映射只作候选提示）。 */
export function pageRegionOf(bbox: Bbox, width = 1200, height = 720): PageRegion {
  const cx = (bbox.x1 + bbox.x2) / 2
  const cy = (bbox.y1 + bbox.y2) / 2
  if (cx < SHELL_GEOMETRY.sidebarWidth) return 'sidebar'
  if (cx >= width - SHELL_GEOMETRY.overlayRight - SHELL_GEOMETRY.overlayWidth && cy < SHELL_GEOMETRY.overlayBottom) return 'overlay'
  if (cy >= SHELL_GEOMETRY.inputTop && cy < height) return 'input'
  return 'conversation'
}

/** 全局问题域判定（解释性规则）：调色板/布局显著偏离时标 PALETTE/LAYOUT，否则 UNKNOWN（不伪造）。 */
export function globalIssueDomain(metrics: FidelityMetrics): IssueDomain {
  if (metrics.palette.intersection < 0.5) return 'PALETTE'
  if (metrics.layout.cosine < 0.8) return 'LAYOUT'
  return 'UNKNOWN'
}

/**
 * 最差区域构建：diff.ts 8×8 逐像素最差格（pixel）+ region 指标最差格（region），
 * 统一 id/bbox/页面区域/问题域/候选字段；坐标 = 1200×720 归一坐标系（与参考图/截图一致）。
 */
export function buildWorstRegions(
  reference: { width: number; height: number; data: Uint8Array },
  screenshot: { width: number; height: number; data: Uint8Array },
  metrics: FidelityMetrics,
  options: { maxRegions?: number } = {},
): { regions: WorstRegion[]; issues: string[] } {
  const issues: string[] = []
  const maxRegions = options.maxRegions ?? 5
  const pixel = computePixelDiff(reference, screenshot)
  const regions: WorstRegion[] = []
  const domain = globalIssueDomain(metrics)
  const seen = new Set<string>()
  const push = (bbox: Bbox, metric: 'pixel' | 'region', score: number): void => {
    const id = 'cell-' + Math.round(bbox.x1) + '-' + Math.round(bbox.y1)
    if (seen.has(id)) return
    seen.add(id)
    const pageRegion = pageRegionOf(bbox)
    const candidates = [...SPEC_RESPONSIBILITY_MAP[pageRegion]]
    if (domain === 'PALETTE' && !candidates.includes('colorPalette')) candidates.unshift('colorPalette')
    if (domain === 'LAYOUT') for (const f of GLOBAL_CANDIDATES.LAYOUT) if (!candidates.includes(f)) candidates.push(f)
    regions.push({
      id,
      bbox: { x1: bbox.x1, y1: bbox.y1, x2: bbox.x2, y2: bbox.y2 },
      metric,
      score: +score.toFixed(4),
      rank: 0,
      pageRegion,
      likelyIssueDomain: domain,
      candidateSpecFields: candidates,
    })
  }
  for (const region of pixel.worstRegions) push({ x1: region.x1, y1: region.y1, x2: region.x2, y2: region.y2 }, 'pixel', region.ratio)
  push(metrics.region.worstCell, 'region', metrics.region.worstCell.ratio)
  if (regions.length === 0) issues.push('无可用最差区域（图像可能等尺寸空白）')
  regions.sort((a, b) => b.score - a.score)
  regions.slice(0, maxRegions).forEach((region, index) => { region.rank = index + 1 })
  return { regions: regions.slice(0, maxRegions), issues }
}

interface PngModule {
  PNG: {
    sync: {
      read(buffer: Buffer): { width: number; height: number; data: Buffer }
      write(png: { width: number; height: number; data: Buffer }): Buffer
    }
    new (options: { width: number; height: number }): { width: number; height: number; data: Buffer }
  }
}

async function pngModule(): Promise<PngModule> {
  return import('pngjs') as unknown as PngModule
}

/**
 * 区域裁剪：统一坐标系内的 PNG 按 bbox 裁剪（clamp）→ 最近邻放大 scale 倍（默认 3，≤4MP 预算）→ 写 PNG。
 * 输入必须是已归一化（1200×720）的 reference.png / screenshot.png——保证与全部指标同一坐标系（§8）。
 */
export async function cropPng(inputPath: string, bbox: Bbox, outPath: string, scale = 3): Promise<void> {
  const png = await pngModule()
  const source = png.PNG.sync.read(readFileSync(inputPath))
  const x1 = Math.max(0, Math.floor(bbox.x1))
  const y1 = Math.max(0, Math.floor(bbox.y1))
  const x2 = Math.min(source.width, Math.ceil(bbox.x2))
  const y2 = Math.min(source.height, Math.ceil(bbox.y2))
  const cropW = Math.max(1, x2 - x1)
  const cropH = Math.max(1, y2 - y1)
  const width = cropW * scale
  const height = cropH * scale
  const target = new png.PNG({ width, height })
  for (let y = 0; y < height; y++) {
    const sy = y1 + Math.floor((y * cropH) / height)
    for (let x = 0; x < width; x++) {
      const sx = x1 + Math.floor((x * cropW) / width)
      const src = (sy * source.width + sx) * 4
      const dst = (y * width + x) * 4
      target.data[dst] = source.data[src]
      target.data[dst + 1] = source.data[src + 1]
      target.data[dst + 2] = source.data[src + 2]
      target.data[dst + 3] = source.data[src + 3]
    }
  }
  writeFileSync(outPath, png.PNG.sync.write(target))
}

/** 二次观察 → 归一化 RegionEvidence（V2：仍过 toEvidence 语义的颜色/结构；V3：source + provenance 落盘）。 */
export function regionEvidenceFromObservation(
  observation: VisionEvidence,
  region: { id: string; bbox: Bbox },
  meta: { imageKey?: string; provider?: string; model?: string; analysisVersion?: string },
  degraded = false,
): RegionEvidence {
  const colors = (observation.colors ?? []).map(c => ({ hex: c.hex.toLowerCase(), share: c.share }))
  const layoutFirst = observation.layout?.[0]
  return {
    regionId: region.id,
    bbox: { x1: region.bbox.x1, y1: region.bbox.y1, x2: region.bbox.x2, y2: region.bbox.y2 },
    observation: observation.summary ?? '',
    colors,
    text: observation.text ?? '',
    shape: layoutFirst?.content ?? '',
    source: observation.source ?? { kind: 'fixture' },
    degraded,
    provenance: { ...meta },
  }
}

/** 轮间指标差（多目标护栏输入）：正数=变好（距离类取负增量，已在汇总前取反）。 */
export function computeMetricDelta(prev: FidelityMetrics, next: FidelityMetrics): MetricDelta {
  return {
    paletteIntersection: +(next.palette.intersection - prev.palette.intersection).toFixed(4),
    paletteDominantDistance: +(next.palette.dominantDistance - prev.palette.dominantDistance).toFixed(2),
    layoutCosine: +(next.layout.cosine - prev.layout.cosine).toFixed(4),
    regionMeanDelta: +(next.region.meanDelta - prev.region.meanDelta).toFixed(2),
    pixelDiffRatio: +(next.pixel.diffRatio - prev.pixel.diffRatio).toFixed(6),
    structureNonBlank: next.structure.nonBlank === prev.structure.nonBlank ? 'stable' : next.structure.nonBlank ? 'false->true' : 'true->false',
  }
}
