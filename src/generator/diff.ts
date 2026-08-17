/**
 * 像素级视觉差异（确定性图像数学，非视觉模型）：ratio + 8×8 最差区域。
 * 输入为等尺寸 RGBA 缓冲；尺寸归一由调用方（sharp）完成。
 * @module dsh-skin/src/generator/diff
 */

export interface ImageBuffer {
  width: number
  height: number
  /** RGBA, length = width*height*4 */
  data: Uint8Array
}

export interface DiffRegion {
  x1: number
  y1: number
  x2: number
  y2: number
  ratio: number
  differing: number
  total: number
}

export interface DiffReport {
  width: number
  height: number
  differingPixels: number
  totalPixels: number
  diffRatio: number
  /** 差异最严重的区域（8×8 网格，按 ratio 降序，最多 5 个） */
  worstRegions: DiffRegion[]
}

export function computePixelDiff(original: ImageBuffer, rebuilt: ImageBuffer, threshold = 16): DiffReport {
  if (original.width !== rebuilt.width || original.height !== rebuilt.height) {
    throw new Error('diff 需要等尺寸图像（请先 resize）')
  }
  const { width, height } = original
  const cells = 8
  const cellW = Math.max(1, Math.ceil(width / cells))
  const cellH = Math.max(1, Math.ceil(height / cells))
  const cellHits = new Uint32Array(cells * cells)
  const cellTotals = new Uint32Array(cells * cells)
  let differing = 0
  const total = width * height
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4
      const dr = Math.abs(original.data[offset] - rebuilt.data[offset])
      const dg = Math.abs(original.data[offset + 1] - rebuilt.data[offset + 1])
      const db = Math.abs(original.data[offset + 2] - rebuilt.data[offset + 2])
      const delta = Math.max(dr, dg, db)
      const cx = Math.min(cells - 1, Math.floor(x / cellW))
      const cy = Math.min(cells - 1, Math.floor(y / cellH))
      cellTotals[cy * cells + cx] += 1
      if (delta > threshold) {
        differing += 1
        cellHits[cy * cells + cx] += 1
      }
    }
  }
  const regions: DiffRegion[] = []
  for (let cy = 0; cy < cells; cy++) {
    for (let cx = 0; cx < cells; cx++) {
      const idx = cy * cells + cx
      const cellTotal = cellTotals[idx]
      if (cellTotal === 0) continue
      regions.push({
        x1: cx * cellW,
        y1: cy * cellH,
        x2: Math.min(width, (cx + 1) * cellW),
        y2: Math.min(height, (cy + 1) * cellH),
        ratio: cellHits[idx] / cellTotal,
        differing: cellHits[idx],
        total: cellTotal,
      })
    }
  }
  regions.sort((a, b) => b.ratio - a.ratio)
  return {
    width,
    height,
    differingPixels: differing,
    totalPixels: total,
    diffRatio: total === 0 ? 0 : differing / total,
    worstRegions: regions.slice(0, 5),
  }
}
