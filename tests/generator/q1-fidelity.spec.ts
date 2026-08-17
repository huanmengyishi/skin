import { describe, expect, it } from 'vitest'
import { quantizeTop, paletteSimilarity, layoutCosine, regionMeanDelta, pixelDiffRatio, nonBlank, computeFidelityReport, type RgbaImage } from '../../src/generator/fidelity'

function solid(w: number, h: number, rgb: [number, number, number]): RgbaImage {
  const data = new Uint8Array(w * h * 4)
  for (let i = 0; i < w * h; i++) { data[i * 4] = rgb[0]; data[i * 4 + 1] = rgb[1]; data[i * 4 + 2] = rgb[2]; data[i * 4 + 3] = 255 }
  return { width: w, height: h, data }
}

describe('Q1 Reference Fidelity 指标（可解释、三类分离）', () => {
  it('quantizeTop：确定性 + 纯色图单一主色', () => {
    const img = solid(64, 64, [10, 20, 30])
    const a = quantizeTop(img, 8)
    const b = quantizeTop(img, 8)
    expect(a).toEqual(b)
    expect(a).toHaveLength(1)
    expect(a[0].share).toBe(1)
  })

  it('paletteSimilarity：相同 → intersection=1/distance=0；全异 → 0/大距离', () => {
    const p = [{ hex: '#0a141e', share: 1 }]
    const same = paletteSimilarity(p, [{ hex: '#0a141e', share: 1 }])
    expect(same.intersection).toBe(1)
    expect(same.dominantDistance).toBeLessThan(1)
    const diff = paletteSimilarity(p, [{ hex: '#fafafa', share: 1 }])
    expect(diff.intersection).toBe(0)
    expect(diff.dominantDistance).toBeGreaterThan(300)
  })

  it('layoutCosine：相同结构 → 1；互补 → 负', () => {
    const a = solid(64, 64, [200, 200, 200])
    expect(layoutCosine(a, a)).toBe(1)
    const dark = solid(64, 64, [10, 10, 10])
    const light = solid(64, 64, [245, 245, 245])
    expect(layoutCosine(dark, light)).toBeGreaterThan(0.99)
  })

  it('regionMeanDelta / pixelDiffRatio / nonBlank：同一图 → 0/0/结构判定', () => {
    const a = solid(64, 64, [100, 110, 120])
    expect(regionMeanDelta(a, a).meanDelta).toBe(0)
    expect(pixelDiffRatio(a, a)).toBe(0)
    expect(nonBlank(a)).toBe(false)
    const grad = solid(64, 64, [100, 110, 120])
    for (let x = 0; x < 64; x++) for (let y = 0; y < 64; y++) { const o = (y * 64 + x) * 4; grad.data[o] = x * 4; grad.data[o + 1] = y * 4; grad.data[o + 2] = 128 }
    expect(nonBlank(grad)).toBe(true)
  })

  it('computeFidelityReport：metrics 与 iteration.stability 分槽；报告形状完整', () => {
    const ref = solid(64, 64, [10, 20, 10])
    const shot = solid(64, 64, [10, 20, 10])
    const report = computeFidelityReport({
      reference: ref, screenshot: shot, referencePath: 'reference.png', screenshotPath: 'iteration-0/screenshot.png',
      iterationDiffRatio: 0.001, fingerprintChanged: false, converged: true, previousFidelity: null,
    })
    expect(report.metrics.palette.intersection).toBe(1)
    expect(report.metrics.pixel.diffRatio).toBe(0)
    expect(report.metrics.structure.nonBlank).toBe(false)
    expect(report.iteration.stability.diffRatio).toBe(0.001)
    expect(report.iteration.stability.fingerprintChanged).toBe(false)
    expect(report.interpretation.converged).toBe(true)
    expect(report.interpretation.improved).toBeNull()
    expect(Object.keys(report.metrics)).toEqual(['palette', 'layout', 'region', 'pixel', 'structure'])
  })
})

