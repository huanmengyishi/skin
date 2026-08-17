/**
 * Q1 Reference Fidelity：生成截图 vs 参考图的多维可解释指标（palette/layout/region/pixel/structure）。
 * 与 Iteration Stability（既有收敛判据）与 Runtime Correctness（build/apply/dispose/screenshot）分离，三类不合并。
 * 本地像素度量基于 pngjs（diff.ts 同源），不构成对 vision-router 工具的重实现；视觉语义观察仍只经 llm seam。
 * @module dsh-skin/src/generator/fidelity
 */

import { readFileSync } from 'node:fs'
import type { PNG } from 'pngjs'

export interface RgbaImage {
  width: number
  height: number
  data: Uint8Array
}

interface PngModule { PNG: { sync: { read(buffer: Buffer): { width: number; height: number; data: Buffer } } } }

/** 解码 PNG 为 RGBA（pngjs 纯 JS）。 */
export async function decodePngRgba(path: string): Promise<RgbaImage> {
  const module = await import('pngjs') as unknown as PngModule
  const png = module.PNG.sync.read(readFileSync(path))
  return { width: png.width, height: png.height, data: new Uint8Array(png.data) }
}

/** 4-bit 每通道量化 Top-N 调色板（确定性、可复现）。 */
export function quantizeTop(image: RgbaImage, n = 8): Array<{ hex: string; share: number }> {
  const bins = new Map<number, number>()
  const total = image.width * image.height
  for (let i = 0; i < image.data.length; i += 4) {
    const key = ((image.data[i] >> 4) << 8) | ((image.data[i + 1] >> 4) << 4) | (image.data[i + 2] >> 4)
    bins.set(key, (bins.get(key) ?? 0) + 1)
  }
  const top = [...bins.entries()].sort((a, b) => b[1] - a[1]).slice(0, n)
  return top.map(([key, count]) => {
    const r = ((key >> 8) & 15) * 16 + 8
    const g = ((key >> 4) & 15) * 16 + 8
    const b = (key & 15) * 16 + 8
    return { hex: '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join(''), share: count / total }
  })
}

function hexToRgb(hex: string): [number, number, number] {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)]
}

export interface PaletteMetric {
  intersection: number
  dominantDistance: number,
  referenceTop: string[],
  generatedTop: string[],
}

/** 调色板相似度：直方图交集（4-bit bin 集合重叠）+ 主导色逐对最近欧氏距离均值。 */
export function paletteSimilarity(refTop: Array<{ hex: string; share: number }>, genTop: Array<{ hex: string; share: number }>): PaletteMetric {
  const refKeys = new Set(refTop.map(c => c.hex))
  const genKeys = new Set(genTop.map(c => c.hex))
  let overlap = 0
  for (const key of refKeys) if (genKeys.has(key)) overlap += 1
  const intersection = refKeys.size === 0 ? 0 : overlap / refKeys.size
  let sum = 0
  for (const r of refTop.slice(0, 3)) {
    const [r1, g1, b1] = hexToRgb(r.hex)
    let best = 441.7
    for (const g of genTop) {
      const [r2, g2, b2] = hexToRgb(g.hex)
      const d = Math.sqrt((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2)
      if (d < best) best = d
    }
    sum += best
  }
  return { intersection: +intersection.toFixed(4), dominantDistance: +(sum / Math.max(1, Math.min(3, refTop.length))).toFixed(1), referenceTop: refTop.map(c => c.hex), generatedTop: genTop.map(c => c.hex) }
}

/** 布局相似度：4x4 网格灰度均值向量的余弦相似度（-1..1）。 */
export function layoutCosine(a: RgbaImage, b: RgbaImage): number {
  const grid = (img: RgbaImage): number[] => {
    const cells = 4
    const cellW = Math.max(1, Math.ceil(img.width / cells))
    const cellH = Math.max(1, Math.ceil(img.height / cells))
    const sums = new Float64Array(cells * cells)
    const counts = new Float64Array(cells * cells)
    for (let y = 0; y < img.height; y++) {
      for (let x = 0; x < img.width; x++) {
        const o = (y * img.width + x) * 4
        const gray = 0.299 * img.data[o] + 0.587 * img.data[o + 1] + 0.114 * img.data[o + 2]
        const ci = Math.min(cells - 1, Math.floor(y / cellH)) * cells + Math.min(cells - 1, Math.floor(x / cellW))
        sums[ci] += gray
        counts[ci] += 1
      }
    }
    return [...sums].map((v, i) => v / Math.max(1, counts[i]))
  }
  const va = grid(a)
  const vb = grid(b)
  let dot = 0; let na = 0; let nb = 0
  for (let i = 0; i < va.length; i++) {
    dot += va[i] * vb[i]
    na += va[i] * va[i]
    nb += vb[i] * vb[i]
  }
  return na === 0 || nb === 0 ? 0 : +(dot / Math.sqrt(na * nb)).toFixed(4)
}

export interface RegionMetric {
  meanDelta: number,
  worstCell: { ratio: number; x1: number; y1: number; x2: number; y2: number },
}

/** 区域相似度：8x8 网格逐格平均通道差的均值与最差格。 */
export function regionMeanDelta(a: RgbaImage, b: RgbaImage): RegionMetric {
  if (a.width !== b.width || a.height !== b.height) throw new Error('region 指标需要等尺寸图像')
  const cells = 8
  const cellW = Math.max(1, Math.ceil(a.width / cells))
  const cellH = Math.max(1, Math.ceil(a.height / cells))
  const sums = new Float64Array(cells * cells)
  const counts = new Float64Array(cells * cells)
  for (let y = 0; y < a.height; y++) {
    for (let x = 0; x < a.width; x++) {
      const o = (y * a.width + x) * 4
      const d = (Math.abs(a.data[o] - b.data[o]) + Math.abs(a.data[o + 1] - b.data[o + 1]) + Math.abs(a.data[o + 2] - b.data[o + 2])) / 3
      const ci = Math.min(cells - 1, Math.floor(y / cellH)) * cells + Math.min(cells - 1, Math.floor(x / cellW))
      sums[ci] += d
      counts[ci] += 1
    }
  }
  let total = 0
  let worst = 0
  let worstIdx = 0
  for (let i = 0; i < sums.length; i++) {
    const mean = sums[i] / Math.max(1, counts[i])
    total += mean
    if (mean > worst) { worst = mean; worstIdx = i }
  }
  const cx = worstIdx % cells
  const cy = Math.floor(worstIdx / cells)
  return {
    meanDelta: +(total / (cells * cells)).toFixed(2),
    worstCell: { ratio: +worst.toFixed(2), x1: cx * cellW, y1: cy * cellH, x2: Math.min(a.width, (cx + 1) * cellW), y2: Math.min(a.height, (cy + 1) * cellH) },
  }
}

/** 结构正确性：截图非空白（方差阈值）。 */
export function nonBlank(image: RgbaImage, varianceThreshold = 8): boolean {
  let mean = 0
  const n = image.width * image.height
  for (let i = 0; i < image.data.length; i += 4) mean += (image.data[i] + image.data[i + 1] + image.data[i + 2]) / 3
  mean /= n
  let variance = 0
  for (let i = 0; i < image.data.length; i += 4) {
    const v = (image.data[i] + image.data[i + 1] + image.data[i + 2]) / 3
    variance += (v - mean) ** 2
  }
  return Math.sqrt(variance / n) > varianceThreshold
}

export interface FidelityMetrics {
  palette: PaletteMetric
  layout: { cosine: number }
  region: RegionMetric
  pixel: { diffRatio: number; threshold: number }
  structure: { nonBlank: boolean }
}

export interface FidelityReport {
  reference: string
  generated: string
  metrics: FidelityMetrics
  iteration: { stability: { diffRatio: number | null; fingerprintChanged: boolean | null } }
  interpretation: { summary: string; improved: boolean | null; converged: boolean | null }
}

/** 汇总：reference fidelity（主）与 iteration stability（辅）分槽记录，不做单一合并分。 */
export function computeFidelityReport(input: {
  reference: RgbaImage
  screenshot: RgbaImage
  referencePath: string
  screenshotPath: string
  iterationDiffRatio: number | null
  fingerprintChanged: boolean | null
  converged: boolean | null
  previousFidelity: FidelityMetrics | null
}): FidelityReport {
  if (input.reference.width !== input.screenshot.width || input.reference.height !== input.screenshot.height) {
    throw new Error('fidelity 需要等尺寸参考图与截图（参考图应先经 renderImageToPng 归一）')
  }
  const palette = paletteSimilarity(quantizeTop(input.reference), quantizeTop(input.screenshot))
  const layout = { cosine: layoutCosine(input.reference, input.screenshot) }
  const region = regionMeanDelta(input.reference, input.screenshot)
  const pixel = { diffRatio: +pixelDiffRatio(input.reference, input.screenshot, 16).toFixed(6), threshold: 16 }
  const structure = { nonBlank: nonBlank(input.screenshot) }
  const metrics: FidelityMetrics = { palette, layout, region, pixel, structure }
  const improved = input.previousFidelity === null ? null : fidelityNotWorse(metrics, input.previousFidelity)
  const summary = [
    'palette.intersection=' + palette.intersection,
    'layout.cosine=' + layout.cosine,
    'region.meanDelta=' + region.meanDelta,
    'pixel.diffRatio=' + pixel.diffRatio,
    'structure.nonBlank=' + String(structure.nonBlank),
  ].join('；')
  return {
    reference: input.referencePath,
    generated: input.screenshotPath,
    metrics,
    iteration: { stability: { diffRatio: input.iterationDiffRatio, fingerprintChanged: input.fingerprintChanged } },
    interpretation: { summary, improved, converged: input.converged },
  }
}

/** 逐像素差异率（与 diff.ts 同阈同义，但直接吃 RGBA）。 */
export function pixelDiffRatio(a: RgbaImage, b: RgbaImage, threshold = 16): number {
  if (a.width !== b.width || a.height !== b.height) throw new Error('pixel 指标需要等尺寸图像')
  let differing = 0
  const total = a.width * a.height
  for (let i = 0; i < a.data.length; i += 4) {
    const d = Math.max(Math.abs(a.data[i] - b.data[i]), Math.abs(a.data[i + 1] - b.data[i + 1]), Math.abs(a.data[i + 2] - b.data[i + 2]))
    if (d > threshold) differing += 1
  }
  return total === 0 ? 0 : differing / total
}

/** 简化「不劣化」判定：任一主指标显著变差则 false（解释性规则，非僵化阈值）。 */
function fidelityNotWorse(next: FidelityMetrics, prev: FidelityMetrics): boolean {
  const regionWorse = next.region.meanDelta > prev.region.meanDelta + 10
  const layoutWorse = next.layout.cosine < prev.layout.cosine - 0.05
  const paletteWorse = next.palette.intersection < prev.palette.intersection - 0.1
  return !(regionWorse || layoutWorse || paletteWorse)
}

