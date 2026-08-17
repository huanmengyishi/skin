import { describe, expect, it } from 'vitest'
import { mkdirSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { nodeFs } from '../../src/repository/fs.ts'
import { SkinRepository } from '../../src/repository/repository.ts'
import { resolveSkinRoots } from '../../src/repository/store.ts'
import { validateSkinDesignSpec, slugifySkinId } from '../../src/core/spec.ts'
import { computePixelDiff } from '../../src/generator/diff.ts'
import { cssFromSpec, tokensFromSpec } from '../../src/generator/codegen.ts'
import { writeSkinPackage } from '../../src/generator/package-build.ts'
import { buildPreviewHtml } from '../../src/generator/render.ts'
import { generateSkin } from '../../src/generator/iterate.ts'
import { fixtureBrain, extractJson, type GeneratorBrain, type VisionEvidence } from '../../src/generator/vision.ts'
import { validateManifest } from '../../src/core/manifest.ts'
import type { RepairDecision } from '../../src/generator/repair.ts'
import type { SkinDesignSpec } from '../../src/core/spec.ts'

async function loadSharp(): Promise<(options: unknown) => { png(): { toBuffer(): Promise<Buffer>; toFile(path: string): Promise<void> } }> {
  const module = await import('sharp') as { default?: unknown }
  return (typeof module.default === 'function' ? module.default : module) as never
}

async function pngBytes(color: [number, number, number], size = 16): Promise<Uint8Array> {
  const sharp = await loadSharp()
  const buffer = await sharp({ create: { width: size, height: size, channels: 3, background: { r: color[0], g: color[1], b: color[2] } } }).png().toBuffer()
  return new Uint8Array(buffer)
}

/** 双色参考 PNG（方差 > 8 → structure.nonBlank=true；用于 no-repair/converged 等精确判定）。 */
async function twoTonePng(top: [number, number, number], bottom: [number, number, number], width = 1200, height = 720): Promise<Uint8Array> {
  const { PNG } = await import('pngjs') as { PNG: new (options: { width: number; height: number }) => { data: Buffer } }
  const canvas = new PNG({ width, height })
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4
      const c = y < height / 2 ? top : bottom
      canvas.data[o] = c[0]; canvas.data[o + 1] = c[1]; canvas.data[o + 2] = c[2]; canvas.data[o + 3] = 255
    }
  }
  const { PNG: P } = await import('pngjs') as { PNG: { sync: { write(png: unknown): Buffer } } }
  return new Uint8Array(P.sync.write(canvas))
}

const validSpec = () => ({
  visualStyle: 'fixture', colorPalette: [
    { hex: '#0b120b', role: 'bg-base', share: 0.5 },
    { hex: '#33ff66', role: 'brand', share: 0.3 },
    { hex: '#b8ffc8', role: 'label', share: 0.2 },
  ],
  typography: { family: 'mono', mono: 'mono' },
  spacing: { density: 'comfortable' as const, radius: 4 },
  shapeLanguage: '', borderStyle: '', shadowStyle: '', backgroundStyle: '', headerStyle: '',
  sidebarStyle: '', messageStyle: '', inputStyle: '', buttonStyle: '', cardStyle: '', iconStyle: '',
  chromeElements: [], decorativeElements: [], assetCandidates: [],
})

describe('SkinDesignSpec', () => {
  it('合法 spec 通过校验', () => {
    expect(validateSkinDesignSpec(validSpec()).ok).toBe(true)
  })
  it('非法 spec 逐字段报错', () => {
    const bad = { ...validSpec(), colorPalette: [{ hex: 'red', role: 'x', share: 9 }], spacing: { density: 'wide', radius: 99 } }
    const result = validateSkinDesignSpec(bad)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.issues.join(';')).toContain('colorPalette')
      expect(result.issues.join(';')).toContain('spacing')
    }
  })
  it('slugify：ASCII 化 + 回退', () => {
    expect(slugifySkinId('My Windows 98')).toBe('my-windows-98')
    expect(slugifySkinId('我的 Windows 98')).toBe('windows-98')
    expect(slugifySkinId('！！！')).toBe('skin')
  })
})

describe('computePixelDiff', () => {
  it('相同缓冲 → 0；全异 → 1；阈值生效', () => {
    const make = (value: number) => ({ width: 2, height: 2, data: new Uint8Array(16).fill(value) })
    expect(computePixelDiff(make(100), make(100)).diffRatio).toBe(0)
    expect(computePixelDiff(make(0), make(255)).diffRatio).toBe(1)
    expect(computePixelDiff(make(0), make(10)).diffRatio).toBe(0)
    const partial = make(0)
    partial.data[0] = 200
    expect(computePixelDiff(make(0), partial).diffRatio).toBe(0.25)
  })
})

describe('codegen / render', () => {
  it('确定性写包 + manifest/css/scope 约束', async () => {
    const dir = join(tmpdir(), 'dsh-skin-gen-' + Date.now())
    const naming = { id: 'demo', name: 'Demo', author: 'a', description: 'd', tags: ['demo'] }
    await writeSkinPackage(nodeFs(), dir, validSpec() as never, naming)
    const files = ['manifest.json', 'theme/light.json', 'theme/dark.json', 'styles/theme.css', 'client/index.js', 'preview/light.svg', 'preview/dark.svg']
    for (const rel of files) expect(existsSync(join(dir, rel)), rel).toBe(true)
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'))
    expect(validateManifest(manifest).ok).toBe(true)
    const css = readFileSync(join(dir, 'styles', 'theme.css'), 'utf8')
    expect(css).toContain('body[data-dsh-skin="demo"]')
    const dir2 = join(tmpdir(), 'dsh-skin-gen-' + Date.now() + '-2')
    await writeSkinPackage(nodeFs(), dir2, validSpec() as never, naming)
    for (const rel of files) {
      expect(readFileSync(join(dir, rel)).equals(readFileSync(join(dir2, rel))), rel).toBe(true)
    }
    rmSync(dir, { recursive: true, force: true })
    rmSync(dir2, { recursive: true, force: true })
  })
  it('preview html 自包含（scope/tokens/shim/bundle）', () => {
    const tokens = tokensFromSpec(validSpec() as never)
    const html = buildPreviewHtml({ id: 'demo', name: 'Demo', tokens, css: cssFromSpec(validSpec() as never, 'demo'), clientJs: 'window.__ModuleLoader__.load({ id: "x", factory: function () { return { apply: function () {} }; } });' })
    expect(html).toContain('data-dsh-skin')
    expect(html).toContain('__ModuleLoader__')
    expect(html).toContain('--dsw-alias-bg-base')
    expect(html).toContain('data-slot="sidebar"')
  })
})

interface LoopEnv {
  home: string
  env: {
    fs: typeof nodeFs extends (...args: never[]) => infer R ? R : never
    workspaceRoot: string
    brain: GeneratorBrain
    repository: SkinRepository
    screenshot: (htmlPath: string, outPath: string) => Promise<string>
    renderReference: (inputPath: string, outPath: string, width: number, height: number) => Promise<void>
  }
}

async function makeEnv(brain: GeneratorBrain, screenshot: (htmlPath: string, outPath: string) => Promise<string>, reference: Uint8Array): Promise<LoopEnv> {
  const home = join(tmpdir(), 'dsh-skin-iter-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6))
  const roots = resolveSkinRoots(home)
  mkdirSync(roots.installed, { recursive: true })
  mkdirSync(roots.generated, { recursive: true })
  mkdirSync(roots.staging, { recursive: true })
  mkdirSync(roots.cache, { recursive: true })
  const repository = new SkinRepository(nodeFs(), roots, undefined)
  await repository.hydrate()
  const renderReference = async (_inputPath: string, outPath: string): Promise<void> => {
    await nodeFs().writeFile(outPath, reference)
  }
  return { home, env: { fs: nodeFs(), workspaceRoot: join(roots.cache, 'generation'), brain, repository, screenshot, renderReference } }
}

function scriptedBrain(decisions: RepairDecision[]): GeneratorBrain {
  let calls = 0
  return {
    visionAvailable: () => true,
    visionTarget: () => ({ provider: 'vision-http', model: 'fixture' }),
    analyzeImage: async (): Promise<VisionEvidence> => ({
      summary: 'fixture 参考', layout: [], entities: [], colors: [{ hex: '#0b120b', share: 1 }], text: '',
      raw: 'fixture', source: { kind: 'fixture' }, colorSource: 'vision',
    }),
    designSpec: async (): Promise<SkinDesignSpec> => ({ ...validSpec(), visualStyle: 'fixture-loop' } as never),
    reobserveRegion: async (): Promise<VisionEvidence> => ({
      summary: 'fixture 区域', layout: [], entities: [], colors: [{ hex: '#0b120b', share: 1 }], text: '',
      raw: 'fixture-region', source: { kind: 'fixture' }, colorSource: 'vision',
    }),
    repairDecision: async (): Promise<RepairDecision> => {
      const decision = decisions[Math.min(calls, decisions.length - 1)]
      calls += 1
      return decision
    },
  }
}

/** 截图序列替身：按调用次数写不同 PNG（像素级可控，不依赖真实浏览器）。 */
function sequenceScreenshots(pngs: Uint8Array[], fingerprints: string[]): (htmlPath: string, outPath: string) => Promise<string> {
  let calls = 0
  return async (_htmlPath, outPath) => {
    const index = Math.min(calls, pngs.length - 1)
    calls += 1
    await nodeFs().writeFile(outPath, pngs[index])
    return fingerprints[Math.min(index, fingerprints.length - 1)]
  }
}

describe('generateSkin v1.4 闭环（fixture）', () => {
  it('缺失视觉依赖 → 明确失败且不安装任何皮肤', async () => {
    const missing: GeneratorBrain = { visionAvailable: () => false, analyzeImage: async () => ({} as never), designSpec: async () => ({} as never) }
    const { env, home } = await makeEnv(missing, sequenceScreenshots([await pngBytes([1, 2, 3])], ['fp']), await pngBytes([1, 2, 3]))
    const result = await generateSkin(env, { imageBytes: await pngBytes([1, 2, 3]), name: 'Demo' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.issues.join(';')).toContain('视觉依赖不可用')
    expect(readdirSync(resolveSkinRoots(home).installed)).toEqual([])
    rmSync(home, { recursive: true, force: true })
  })

  it('无修复收敛：iteration-0 五维达标 → CONVERGED（不调用修复模型）', async () => {
    const reference = await twoTonePng([10, 10, 10], [200, 200, 200])
    const screenshot = await twoTonePng([10, 10, 10], [200, 200, 200])
    const decisions: RepairDecision[] = [{ targetRegions: ['global'], problemAssessment: 'x', specChanges: [{ path: 'visualStyle', newValue: 'x', reason: 'r', targetRegion: 'global', expectedEffect: 'e' }] }]
    const { env, home } = await makeEnv(scriptedBrain(decisions), sequenceScreenshots([screenshot], ['fp-same']), reference)
    const result = await generateSkin(env, { imageBytes: reference, name: 'No Repair', maxIterations: 3 })
    expect(result.ok, result.ok ? '' : result.issues.join('；')).toBe(true)
    if (!result.ok) throw new Error(result.issues.join(';'))
    expect(result.loopStatus).toBe('CONVERGED')
    expect(result.iterations.length).toBe(1)
    expect(result.iterations[0].status).toBe('CONVERGED')
    expect(result.iterations[0].repairDecision).toBeNull()
    const report = JSON.parse(readFileSync(result.reportPath, 'utf8'))
    expect(report.stopReason).toBe('NO_REPAIR_NEEDED')
    expect(report.requestStats.deepseekCalls).toBe(1) // 仅 designSpec；修复决策未被调用
    expect(existsSync(join(resolveSkinRoots(home).generated, result.skinId, 'manifest.json'))).toBe(true)
    rmSync(home, { recursive: true, force: true })
  }, 30_000)

  it('修复 → 改善 → 振荡停止：同决策重现 → OSCILLATION，包=改善后状态', async () => {
    const reference = await twoTonePng([10, 10, 10], [200, 200, 200])
    const shot1 = await twoTonePng([10, 10, 10], [210, 210, 210]) // meanDelta 5
    const shot2 = await twoTonePng([10, 10, 10], [200, 200, 200]) // meanDelta 0（|Δ|=10≤16 → 轮间 diffRatio 0）
    const decisions: RepairDecision[] = [{
      targetRegions: ['global'], problemAssessment: '底色偏离', specChanges: [{ path: 'visualStyle', newValue: 'fixture-loop-x', reason: '对齐参考', targetRegion: 'global', expectedEffect: '降低 region.meanDelta' }], confidence: 0.8,
    }]
    const { env, home } = await makeEnv(scriptedBrain(decisions), sequenceScreenshots([shot1, shot2], ['fp-a', 'fp-b']), reference)
    const result = await generateSkin(env, { imageBytes: reference, name: 'Osc', maxIterations: 3 })
    expect(result.ok, result.ok ? '' : result.issues.join('；')).toBe(true)
    if (!result.ok) throw new Error(result.issues.join(';'))
    expect(result.loopStatus).toBe('OSCILLATION')
    expect(result.iterations.length).toBe(2)
    expect(result.iterations[0].status).toBe('INITIAL')
    expect(result.iterations[1].status).toBe('IMPROVED')
    expect(result.iterations[1].repairDecision).not.toBeNull()
    const report = JSON.parse(readFileSync(result.reportPath, 'utf8'))
    expect(report.bestIteration).toBe(1)
    expect(report.requestStats.deepseekCalls).toBe(3) // designSpec + 2 轮修复决策
    expect(report.requestStats.repairRounds).toBe(2)
    rmSync(home, { recursive: true, force: true })
  })

  it('修复后收敛：有意义改善 + 轮间稳定 + 指纹不变 → CONVERGED', async () => {
    const reference = await twoTonePng([10, 10, 10], [200, 200, 200])
    const shot1 = await twoTonePng([10, 10, 10], [210, 210, 210]) // meanDelta 5
    const shot2 = await twoTonePng([10, 10, 10], [200, 200, 200]) // meanDelta 0；轮间 diffRatio 0（|Δ|=10≤16）
    const decisions: RepairDecision[] = [{
      targetRegions: ['global'], problemAssessment: '底色偏离', specChanges: [{ path: 'visualStyle', newValue: 'fixture-loop-x', reason: '对齐参考', targetRegion: 'global', expectedEffect: '降低 region.meanDelta' }], confidence: 0.8,
    }]
    const { env, home } = await makeEnv(scriptedBrain(decisions), sequenceScreenshots([shot1, shot2], ['fp-same', 'fp-same']), reference)
    const result = await generateSkin(env, { imageBytes: reference, name: 'Conv', maxIterations: 3 })
    expect(result.ok, result.ok ? '' : result.issues.join('；')).toBe(true)
    if (!result.ok) throw new Error(result.issues.join(';'))
    expect(result.loopStatus).toBe('CONVERGED')
    expect(result.iterations[1].status).toBe('CONVERGED')
    expect(result.iterations[1].metricDelta?.regionMeanDelta).toBeLessThan(0)
    rmSync(home, { recursive: true, force: true })
  })

  it('退化停止：改善后一轮恶化 → REGRESSED，最终包=上一轮（最后非退化）', async () => {
    const reference = await twoTonePng([10, 10, 10], [200, 200, 200])
    const shot1 = await twoTonePng([10, 10, 10], [210, 210, 210]) // meanDelta 5
    const shot2 = await twoTonePng([10, 10, 10], [200, 200, 200]) // meanDelta 0（改善）
    const shot3 = await twoTonePng([10, 10, 10], [150, 150, 150]) // meanDelta 25（恶化）
    const decisions: RepairDecision[] = [
      { targetRegions: ['global'], problemAssessment: '底色偏离', specChanges: [{ path: 'visualStyle', newValue: 'fixture-loop-a', reason: '对齐参考', targetRegion: 'global', expectedEffect: '降低 region.meanDelta' }] },
      { targetRegions: ['global'], problemAssessment: '试验', specChanges: [{ path: 'visualStyle', newValue: 'fixture-loop-b', reason: '实验性调整', targetRegion: 'global', expectedEffect: '试验' }] },
    ]
    const { env, home } = await makeEnv(scriptedBrain(decisions), sequenceScreenshots([shot1, shot2, shot3], ['fp-a', 'fp-b', 'fp-c']), reference)
    const result = await generateSkin(env, { imageBytes: reference, name: 'Reg', maxIterations: 3 })
    expect(result.ok, result.ok ? '' : result.issues.join('；')).toBe(true)
    if (!result.ok) throw new Error(result.issues.join(';'))
    expect(result.loopStatus).toBe('REGRESSED')
    expect(result.iterations[2].status).toBe('REGRESSED')
    const report = JSON.parse(readFileSync(result.reportPath, 'utf8'))
    expect(report.bestIteration).toBe(1)
    // 最终安装包 = iteration-1 的 spec（spec-patch 证据链可查）
    const finalSpec = JSON.parse(readFileSync(join(result.reportPath, '..', 'design-spec-iteration-1.json'), 'utf8'))
    expect(finalSpec.visualStyle).toBe('fixture-loop-a')
    const manifest = JSON.parse(readFileSync(join(resolveSkinRoots(home).generated, result.skinId, 'manifest.json'), 'utf8'))
    expect(validateManifest(manifest).ok).toBe(true)
    rmSync(home, { recursive: true, force: true })
  })

  it('无改善停止：delta 全低于有意义阈值 → UNCHANGED', async () => {
    const reference = await twoTonePng([10, 10, 10], [200, 200, 200])
    const shot = await twoTonePng([40, 40, 40], [200, 200, 200])
    const decisions: RepairDecision[] = [{ targetRegions: ['global'], problemAssessment: 'x', specChanges: [{ path: 'visualStyle', newValue: '无像素影响的修改', reason: 'r', targetRegion: 'global', expectedEffect: 'e' }] }]
    const { env, home } = await makeEnv(scriptedBrain(decisions), sequenceScreenshots([shot, shot], ['fp-a', 'fp-a']), reference)
    const result = await generateSkin(env, { imageBytes: reference, name: 'NoImp', maxIterations: 3 })
    expect(result.ok, result.ok ? '' : result.issues.join('；')).toBe(true)
    if (!result.ok) throw new Error(result.issues.join(';'))
    expect(result.loopStatus).toBe('UNCHANGED')
    expect(result.iterations[1].status).toBe('UNCHANGED')
    const report = JSON.parse(readFileSync(result.reportPath, 'utf8'))
    expect(report.stopReason).toBe('NO_IMPROVEMENT')
    expect(report.bestIteration).toBe(0)
    rmSync(home, { recursive: true, force: true })
  })

  it('预算耗尽：持续改善至 maxIterations → MAX_ITERATIONS', async () => {
    const reference = await twoTonePng([10, 10, 10], [200, 200, 200])
    const shots = [await twoTonePng([60, 60, 60], [200, 200, 200]), await twoTonePng([30, 30, 30], [200, 200, 200]), await twoTonePng([12, 12, 12], [200, 200, 200])]
    const decisions: RepairDecision[] = [
      { targetRegions: ['global'], problemAssessment: 'x', specChanges: [{ path: 'visualStyle', newValue: 'fixture-loop-a', reason: 'r', targetRegion: 'global', expectedEffect: 'e' }] },
      { targetRegions: ['global'], problemAssessment: 'x', specChanges: [{ path: 'visualStyle', newValue: 'fixture-loop-b', reason: 'r', targetRegion: 'global', expectedEffect: 'e' }] },
    ]
    const { env, home } = await makeEnv(scriptedBrain(decisions), sequenceScreenshots(shots, ['fp-1', 'fp-2', 'fp-3']), reference)
    const result = await generateSkin(env, { imageBytes: reference, name: 'Max', maxIterations: 2 })
    expect(result.ok, result.ok ? '' : result.issues.join('；')).toBe(true)
    if (!result.ok) throw new Error(result.issues.join(';'))
    expect(result.loopStatus).toBe('MAX_ITERATIONS')
    expect(result.iterations.length).toBe(3) // iteration-0 + 2 repair 轮
    expect(result.iterations[2].status).toBe('MAX_ITERATIONS')
    rmSync(home, { recursive: true, force: true })
  })

  it('无效修复决策：schema 拒绝 → FAILED（REPAIR_DECISION），保留 iteration-0 包', async () => {
    const reference = await twoTonePng([10, 10, 10], [200, 200, 200])
    const shot = await twoTonePng([40, 40, 40], [200, 200, 200])
    const decisions: RepairDecision[] = [{ targetRegions: ['nonexistent'], problemAssessment: 'x', specChanges: [{ path: 'visualStyle', newValue: 'x', reason: 'r', targetRegion: 'global', expectedEffect: 'e' }] }]
    const { env, home } = await makeEnv(scriptedBrain(decisions), sequenceScreenshots([shot], ['fp-a']), reference)
    const result = await generateSkin(env, { imageBytes: reference, name: 'BadDecision', maxIterations: 2 })
    expect(result.ok, result.ok ? '' : result.issues.join('；')).toBe(true)
    if (!result.ok) throw new Error(result.issues.join(';'))
    expect(result.loopStatus).toBe('FAILED')
    const report = JSON.parse(readFileSync(result.reportPath, 'utf8'))
    expect(report.stopReason).toBe('REPAIR_DECISION')
    expect(report.bestIteration).toBe(0)
    expect(existsSync(join(resolveSkinRoots(home).generated, result.skinId, 'manifest.json'))).toBe(true)
    rmSync(home, { recursive: true, force: true })
  })

  it('initialSpec：跳过视觉分析（无 vision-router 也可重生成）并覆盖安装', async () => {
    const home = join(tmpdir(), 'dsh-skin-regen-' + Date.now())
    const roots = resolveSkinRoots(home)
    for (const dir of [roots.installed, roots.generated, roots.staging, roots.cache]) mkdirSync(dir, { recursive: true })
    const repository = new SkinRepository(nodeFs(), roots, undefined)
    await repository.hydrate()
    const missing: GeneratorBrain = { visionAvailable: () => false, analyzeImage: async () => ({} as never), designSpec: async () => ({} as never) }
    const reference = await twoTonePng([9, 16, 9], [120, 140, 120])
    const shot = await twoTonePng([9, 16, 9], [120, 140, 120])
    const first = await generateSkin(
      { fs: nodeFs(), workspaceRoot: join(roots.cache, 'generation'), brain: fixtureBrain(), repository, screenshot: sequenceScreenshots([shot], ['fp-1']), renderReference: async (_i: string, out: string) => { await nodeFs().writeFile(out, reference) } },
      { imageBytes: await pngBytes([1, 2, 3]), name: 'Regen Skin' },
    )
    expect(first.ok, first.ok ? '' : first.issues.join('；')).toBe(true)
    if (!first.ok) throw new Error(first.issues.join(';'))
    const skinId = first.skinId
    const second = await generateSkin(
      { fs: nodeFs(), workspaceRoot: join(roots.cache, 'generation'), brain: missing, repository, screenshot: sequenceScreenshots([shot], ['fp-2']), renderReference: async (_i: string, out: string) => { await nodeFs().writeFile(out, reference) } },
      { imageBytes: await pngBytes([1, 2, 3]), name: 'Regen Skin', id: skinId, initialSpec: first.iterations[0].spec, replaceExisting: true, maxIterations: 2 },
    )
    expect(second.ok, second.ok ? '' : second.issues.join('；')).toBe(true)
    if (!second.ok) throw new Error(second.issues.join(';'))
    expect(repository.get(skinId)?.source).toBe('generated')
    rmSync(home, { recursive: true, force: true })
  })
})

describe('extractJson', () => {
  it('容忍围栏与说明文本', () => {
    const fence = String.fromCharCode(96, 96, 96)
    expect(extractJson('前缀说明' + fence + 'json' + String.fromCharCode(10) + '{"a":1}' + String.fromCharCode(10) + fence)).toEqual({ a: 1 })
    expect(extractJson('xx {"b": 2} yy')).toEqual({ b: 2 })
    expect(extractJson('no json here')).toBeUndefined()
  })
})
