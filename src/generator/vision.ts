/**
 * GeneratorBrain：视觉证据与规格生成的大脑接口。
 * - FixtureBrain：确定性夹具（测试 / DSH_SKIN_TEST_MODE 下使用，绝不伪装成真实视觉）。
 * - LiveBrain：经宿主 llm seam 调用 vision-router 注册的视觉路由（vision-http）与文本模型。
 * 视觉缺失时 visionAvailable()=false，入口必须显式提示，禁止静默伪造结果。
 * @module dsh-skin/src/generator/vision
 */

import type { SkinDesignSpec } from '../core/spec.ts'
import { validateSkinDesignSpec } from '../core/spec.ts'
import type { FidelityMetrics } from './fidelity.ts'
import type { RegionEvidence, WorstRegion } from './diagnosis.ts'
import type { RepairDecision } from './repair.ts'

export interface VisionEvidence {
  summary: string
  layout: Array<{ region: string; content: string }>
  entities: string[]
  colors: Array<{ hex: string; share: number }>
  text: string
  /** 原始视觉响应文本（Q2 可追踪性：vision-raw.json 落盘用）。 */
  raw?: string
  /** 视觉来源元数据（谁看到的事实）。 */
  source?: { kind: 'vision-json' | 'vision-prose' | 'fixture'; provider?: string; model?: string }
  /** 颜色来源：模型结构化输出，或本地确定性量化兜底（Q2 保证非空可验证）。 */
  colorSource?: 'vision' | 'local-quantization' | 'none'
}

/** v1.4 修复输入：当前 Spec + 全局证据 + 五维指标 + 最差区域 + 区域二次观察（Evidence 层，归一化后）。 */
export interface RepairInput {
  spec: SkinDesignSpec
  evidence: VisionEvidence
  metrics: FidelityMetrics
  worstRegions: WorstRegion[]
  regionEvidence: RegionEvidence[]
}

export interface GeneratorBrain {
  /** 提示词记录面（诊断/落盘用；LiveBrain 提供，夹具可缺省）。 */
  promptRecords?: { designSpec: string; repair: string; repairRaw: string; system: string; raw: string; interpretation: string[] }
  /** 视觉目标（provider/model）：缓存键与队列键的组成（Q5）；夹具可缺省（无视觉目标=不走队列/降采样）。 */
  visionTarget?: () => { provider: string; model: string }
  /** v1.2：DeepSeek 输出的 interpretation（设计解释，进 provenance）。 */
  lastInterpretation?: () => string[]
  visionAvailable(): boolean
  analyzeImage(_imagePath: string): Promise<VisionEvidence>
  designSpec(evidence: VisionEvidence, hints: { name: string; description: string }): Promise<SkinDesignSpec>
  /** v1.4：结构化修复决策（DeepSeek = Repair Decision；输出必须经 validateRepairDecision）。 */
  repairDecision?(input: RepairInput): Promise<RepairDecision>
  /** v1.4：区域二次观察（Eyes；输入=统一坐标系裁剪件路径）。 */
  reobserveRegion?(_cropPath: string, _regionId: string): Promise<VisionEvidence>
}

/** llm seam 的最小面（宿主注入；类型擦除避免耦合宿主类型图）。 */
export interface LlmFace {
  listProviders(): Array<{ id: string }>
  listModels(provider: string): Array<{ id: string; modality?: string }>
  stream(options: {
    provider: string
    model: string
    messages: Array<{ role: string; content: unknown }>
    system?: string
    maxTokens?: number
  }): AsyncIterable<{ type: string; text?: string; reason?: string; block?: { type?: string; text?: string } }>
}

async function streamText(llm: LlmFace, options: Parameters<LlmFace['stream']>[0]): Promise<string> {
  let text = ''
  let reasoning = ''
  for await (const chunk of llm.stream(options)) {
    if (chunk.type === 'text-delta' && chunk.text !== undefined) text += chunk.text
    if (chunk.type === 'reasoning-delta' && chunk.text !== undefined) reasoning += chunk.text
    if (chunk.type === 'block-end' && (chunk.block as { type?: string; text?: string } | undefined)?.type === 'text') text += (chunk.block as { text?: string }).text ?? ''
    if (chunk.type === 'finish') {
      const reason = (chunk as { reason?: string | { kind: string; failure?: { message?: string } } }).reason
      if (reason !== undefined) {
        if (typeof reason === 'string') {
          if (reason !== 'stop' && reason !== 'end') throw new Error('视觉调用提前结束：' + reason)
        } else if (reason.kind !== 'stop' && reason.kind !== 'tool-calls') {
          throw new Error('视觉调用结束异常（' + reason.kind + '）：' + String(reason.failure?.message ?? JSON.stringify(reason).slice(0, 300)))
        }
      }
    }
  }
  if (text.length === 0 && reasoning.length > 0) throw new Error('视觉模型只输出了 reasoning 而没有文本（reasoning 片段：' + reasoning.slice(0, 200) + '）')
  return text
}

/** 扫描第一个括号配平（字符串/转义感知）的 JSON 对象片段。 */
function firstBalancedObject(text: string, from: number): string | undefined {
  let depth = 0; let inString = false; let escaped = false
  for (let i = from; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      if (escaped) { escaped = false; continue }
      if (c.charCodeAt(0) === 92) { escaped = true; continue }
      if (c.charCodeAt(0) === 34) inString = false
      continue
    }
    if (c.charCodeAt(0) === 34) { inString = true; continue }
    if (c === '{') { depth++; continue }
    if (c === '}') { depth--; if (depth === 0) return text.slice(from, i + 1) }
  }
  return undefined
}

/** 从模型文本中提取 JSON（容忍代码围栏、前后说明、截断外的多余文本）。 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim()
  const parts = trimmed.split('```')
  const candidates = []
  if (parts.length >= 3) candidates.push(parts[1])
  candidates.push(trimmed)
  for (const candidate of candidates) {
    const start = candidate.indexOf('{')
    if (start < 0) continue
    const end = candidate.lastIndexOf('}')
    if (end > start) {
      try { return JSON.parse(candidate.slice(start, end + 1)) } catch (e) {}
    }
    const balanced = firstBalancedObject(candidate, start)
    if (balanced !== undefined) {
      try { return JSON.parse(balanced) } catch (e) {}
    }
  }
  return undefined
}

/** 附件服务最小面（host ctx.attachments；真实视觉链用内容寻址图像块）。 */
export interface AttachmentsFace {
  saveImage(args: { data: Uint8Array; mediaType: string; name: string }): Promise<unknown>
}

/** 图片字节 → MIME（magic bytes）。 */
export function sniffMediaType(bytes: Uint8Array): string | undefined {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (bytes.length >= 12 && String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]) === 'WEBP') return 'image/webp'
  if (bytes.length >= 6 && String.fromCharCode(bytes[0], bytes[1], bytes[2]) === 'GIF') return 'image/gif'
  return undefined
}

const DESIGN_SPEC_SYSTEM = [
  '你是皮肤设计规格转换器。输入是视觉证据 JSON，输出必须是合法的 SkinDesignSpec JSON。',
  '字段：visualStyle(字符串)、colorPalette([{hex:"#RRGGBB",role:"bg-base|bg-layer|border|brand|label|label-secondary|accent|other",share:0..1}])、',
  'typography({family,mono})、spacing({density:"compact|comfortable|spacious",radius:0..32})、',
  'shapeLanguage/borderStyle/shadowStyle/backgroundStyle/headerStyle/sidebarStyle/messageStyle/inputStyle/buttonStyle/cardStyle/iconStyle（CSS 片段字符串）、',
  'chromeElements/decorativeElements/assetCandidates（字符串数组）、customCss（可选 CSS 规则文本）。',
  '重要：shapeLanguage/borderStyle/shadowStyle/backgroundStyle/headerStyle/sidebarStyle/messageStyle/inputStyle/buttonStyle/cardStyle/iconStyle/customCss 这些字段只允许合法 CSS（声明片段如 border: 1px solid var(--x); 或规则文本），禁止自然语言描述与中文（引号内字体名除外）；shapeLanguage 用几何声明（如 border-radius: 14px;）或留空字符串。visualStyle 才允许自然语言风格描述。',
  '只输出 JSON，不要解释。',
].join('\n')

/** v1.4 修复决策系统提示词：白名单/预算/证据纪律（颜色必须来自证据或区域观察，禁止新造）。 */
const REPAIR_DECISION_SYSTEM = [
  '你是皮肤修复决策器（Repair Decision）。输入含当前 SkinDesignSpec、全局视觉证据、保真度指标、最差区域与区域二次观察。',
  '输出必须是合法 JSON 对象：{"targetRegions":["..."],"problemAssessment":"...","specChanges":[{"path":"...","newValue":...,"reason":"...","targetRegion":"...","expectedEffect":"..."}],"confidence":0..1}',
  'path 只允许设计字段：colorPalette[i].hex/role/share、typography.family/mono、spacing.density/radius、shapeLanguage/borderStyle/shadowStyle/backgroundStyle/headerStyle/sidebarStyle/messageStyle/inputStyle/buttonStyle/cardStyle/iconStyle、customCss、visualStyle、chromeElements/decorativeElements/assetCandidates。',
  '每轮最多 4 条修改；颜色新值必须取自全局证据或区域观察的 colors（#RRGGBB），禁止新造颜色；CSS 字段只允许合法 CSS 声明片段（禁止自然语言/中文，引号内字体名除外）。',
  '每条修改必须给出 reason（为什么）与 expectedEffect（期望改善哪个指标/区域）。targetRegion 必须是 targetRegions 之一或 global。',
  '只输出 JSON，不要解释；reason/expectedEffect 各不超过 60 字；输出总长不超过 1500 字。',
].join('\n')

const HEX_PATTERN = /^#[0-9a-fA-F]{6}$/

/** 唯一归一化闸门（Q2）：视觉原始文本 → 结构化 VisionEvidence；颜色必须 #RRGGBB，非法颜色丢弃而非伪造。 */
function toEvidence(text: string): VisionEvidence | undefined {
  const json = extractJson(text)
  if (json === undefined || typeof json !== 'object') return undefined
  const raw = json as Record<string, unknown>
  const colors = Array.isArray(raw.colors)
    ? raw.colors
        .map(entry => {
          const c = entry as Record<string, unknown>
          return { hex: typeof c.hex === 'string' ? c.hex : '', share: typeof c.share === 'number' ? c.share : 0 }
        })
        .filter(color => HEX_PATTERN.test(color.hex) && color.share >= 0 && color.share <= 1)
        .slice(0, 16)
    : []
  return {
    summary: typeof raw.summary === 'string' ? raw.summary : '',
    layout: Array.isArray(raw.layout) ? raw.layout.map(entry => {
      const l = entry as Record<string, unknown>
      return { region: String(l.region ?? ''), content: String(l.content ?? '') }
    }) : [],
    entities: Array.isArray(raw.entities) ? raw.entities.map(String) : [],
    colors,
    text: typeof raw.text === 'string' ? raw.text : '',
  }
}

/** LiveBrain：视觉经 vision-http 路由（vision-router 注册），文本经首个非视觉 provider。 */
export function liveBrain(llm: LlmFace, attachments?: AttachmentsFace): GeneratorBrain {
  let lastPrompt = ''
  let lastRepairPrompt = ''
  let lastRaw = ''
  let lastInterpretation: string[] = []
  const promptRecords = {
    get designSpec(): string { return lastPrompt },
    get repair(): string { return lastRepairPrompt },
    get repairRaw(): string { return lastRaw },
    get system(): string { return DESIGN_SPEC_SYSTEM },
    get raw(): string { return lastRaw },
    get interpretation(): string[] { return lastInterpretation },
  }
  const visionModels = (): string[] => {
    try {
      return llm.listModels('vision-http').map(model => model.id)
    } catch {
      return ['ovh/Qwen2.5-VL-72B-Instruct']
    }
  }
  const textProvider = (): { provider: string; model: string } => {
    const providers = llm.listProviders()
    const text = providers.find(entry => entry.id !== 'vision-http' && !entry.id.includes('vision'))
    if (text === undefined) throw new Error('未注册文本模型 provider（DeepSeek）')
    let model = ''
    try {
      const models = llm.listModels(text.id).filter(m => m.modality === undefined || m.modality === 'text')
      model = models[0]?.id ?? ''
    } catch { model = '' }
    if (model.length === 0 && text.id === 'deepseek-official') model = 'deepseek-v4-flash'
    if (model.length === 0) throw new Error('文本模型 provider 无可用模型：' + text.id)
    return { provider: text.id, model }
  }
  const askText = async (prompt: string, maxTokens = 4000): Promise<string> => {
    return askTextRaw(prompt, maxTokens)
  }
  const askTextRaw = async (prompt: string, maxTokens = 4000): Promise<string> => {
    const target = textProvider()
    return streamText(llm, {
      provider: target.provider,
      model: target.model,
      system: DESIGN_SPEC_SYSTEM,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      maxTokens,
    })
  }
  const askRepairRaw = async (prompt: string, maxTokens = 4000): Promise<string> => {
    const target = textProvider()
    return streamText(llm, {
      provider: target.provider,
      model: target.model,
      system: REPAIR_DECISION_SYSTEM,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      maxTokens,
    })
  }
  const regionPromptRecords = { raw: '' }
  return {
    visionAvailable: () => llm.listProviders().some(entry => entry.id === 'vision-http'),
    promptRecords,
    visionTarget: () => ({ provider: 'vision-http', model: visionModels()[0] ?? 'unknown' }),
    lastInterpretation: () => lastInterpretation,
    reobserveRegion: async (cropPath, regionId) => {
      if (attachments === undefined) throw new Error('attachments 服务未挂载（区域二次观察需要内容寻址图像块）')
      const { readFileSync } = await import('node:fs')
      const bytes = new Uint8Array(readFileSync(cropPath))
      const mediaType = sniffMediaType(bytes) ?? 'image/png'
      const ref = await attachments.saveImage({ data: bytes, mediaType, name: 'skin-region-' + regionId }) as { attachmentId?: string; id?: string }
      const model = visionModels()[0]
      if (model === undefined) throw new Error('vision-http 无模型')
      const text = await streamText(llm, {
        provider: 'vision-http',
        model,
        system: [
          '你是视觉观察者（Eyes）。输入是参考图的一个局部区域裁剪。输出必须是合法 JSON 对象，字段：',
          'summary（一句话描述该区域）、layout（[{region,content}]，通常一条）、entities（区域元素清单）、',
          'colors（[{hex,share}]，hex 必须是 #RRGGBB 六位十六进制，share 0..1，按占比从大到小最多 8 个）、',
          'text（区域中的文字，没有则空字符串）。只输出 JSON。',
        ].join('\n'),
        messages: [{ role: 'user', content: [{ type: 'text', text: '观察参考图的这个局部区域（用于皮肤修复诊断），输出结构化 JSON。' }, { type: 'image', attachment: ref }] }],
        maxTokens: 1200,
      })
      regionPromptRecords.raw = text
      const evidence = toEvidence(text)
      if (evidence !== undefined) {
        const summary = evidence.summary.trim().length > 0 ? evidence.summary : text.slice(0, 500)
        return { ...evidence, summary, raw: text, source: { kind: 'vision-json', provider: 'vision-http', model }, colorSource: evidence.colors.length > 0 ? 'vision' : 'none' }
      }
      return { summary: text, layout: [], entities: [], colors: [], text: '', raw: text, source: { kind: 'vision-prose', provider: 'vision-http', model }, colorSource: 'none' }
    },
    analyzeImage: async imagePath => {
      if (attachments === undefined) throw new Error('attachments 服务未挂载（真实视觉链需要内容寻址图像块）')
      const { readFileSync } = await import('node:fs')
      const bytes = new Uint8Array(readFileSync(imagePath))
      const mediaType = sniffMediaType(bytes)
      if (mediaType === undefined) throw new Error('不支持的图片格式（仅 PNG/JPEG/WebP/GIF）')
      const ref = await attachments.saveImage({ data: bytes, mediaType, name: 'skin-reference' }) as { attachmentId?: string; id?: string }
      const model = visionModels()[0]
      if (model === undefined) throw new Error('vision-http 无模型')
      const text = await streamText(llm, {
        provider: 'vision-http',
        model,
        system: [
          '你是视觉观察者（Eyes）。输出必须是合法 JSON 对象，字段：',
          'summary（一段话总结画面）、layout（[{region,content}] 布局分区）、entities（画面元素清单）、',
          'colors（[{hex,share}]，hex 必须是 #RRGGBB 六位十六进制，share 是 0..1 的视觉占比，按占比从大到小最多 12 个）、',
          'text（画面中的文字，没有则空字符串）。',
          '只输出 JSON，不要任何解释或 Markdown。',
        ].join('\n'),
        messages: [{ role: 'user', content: [{ type: 'text', text: '观察这张参考图，输出结构化视觉观察 JSON。' }, { type: 'image', attachment: ref }] }],
        maxTokens: 2000,
      })
      // Eyes 给观察，Brain（DeepSeek）做结构化：JSON 直接用；散文原文照存（raw 落盘），交给 designSpec 的结构化转换。
      const evidence = toEvidence(text)
      if (evidence !== undefined) {
        // 归一化兜底：模型未按 schema 输出时，summary 用散文前 500 字（EVIDENCE_NORMALIZATION 域）
        const summary = evidence.summary.trim().length > 0 ? evidence.summary : text.slice(0, 500)
        return {
          ...evidence,
          summary,
          raw: text,
          source: { kind: 'vision-json', provider: 'vision-http', model },
          colorSource: evidence.colors.length > 0 ? 'vision' : 'none',
        }
      }
      return {
        summary: text,
        layout: [],
        entities: [],
        colors: [],
        text: '',
        raw: text,
        source: { kind: 'vision-prose', provider: 'vision-http', model },
        colorSource: 'none',
      }
    },
    designSpec: async (evidence, hints) => {
      const prompt = JSON.stringify({ evidence, hints })
      lastPrompt = prompt
      const text = await askTextRaw(prompt, 8000)
      lastRaw = text
      if (text.trim().length === 0) throw new Error('DeepSeek 返回空响应')
      const raw = extractJson(text)
      const interpretation = (raw !== null && typeof raw === 'object' && Array.isArray((raw as Record<string, unknown>).interpretation))
        ? ((raw as Record<string, unknown>).interpretation as unknown[]).map(String).slice(0, 8)
        : []
      lastInterpretation = interpretation
      const result = validateSkinDesignSpec(raw)
      if (!result.ok) {
        throw new Error('设计规格校验失败：' + result.issues.join('；') + '（DeepSeek 原始响应片段：' + text.slice(0, 300).replace(/\n/g, ' ') + '）')
      }
      return result.spec
    },
    repairDecision: async input => {
      const { provenance: _prov, ...designSpec } = input.spec as SkinDesignSpec & { provenance?: unknown }
      const prompt = JSON.stringify({
        currentSpec: designSpec,
        evidence: input.evidence,
        fidelityMetrics: input.metrics,
        worstRegions: input.worstRegions.map(region => ({ id: region.id, bbox: { x1: Math.round(region.bbox.x1), y1: Math.round(region.bbox.y1), x2: Math.round(region.bbox.x2), y2: Math.round(region.bbox.y2) }, metric: region.metric, score: region.score, pageRegion: region.pageRegion, candidateSpecFields: region.candidateSpecFields })),
        regionEvidence: input.regionEvidence.map(region => ({ regionId: region.regionId, bbox: region.bbox, observation: region.observation.slice(0, 300), colors: region.colors, text: region.text.slice(0, 200), shape: region.shape.slice(0, 120), degraded: region.degraded })),
        instruction: '定位最差区域的原因并给出结构化修复决策。',
      })
      lastRepairPrompt = prompt
      const text = await askRepairRaw(prompt, 8000)
      lastRaw = text
      if (text.trim().length === 0) throw new Error('DeepSeek 返回空响应')
      const raw = extractJson(text)
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('修复决策不是 JSON 对象（DeepSeek 原始响应片段：' + text.slice(0, 300).replace(/\n/g, ' ') + '）')
      return raw as never as RepairDecision
    },
  }
}

/** 确定性夹具（测试/演练用）：绝不冒充真实视觉分析。 */
export function fixtureBrain(): GeneratorBrain {
  const base: SkinDesignSpec = {
    visualStyle: 'fixture-terminal',
    colorPalette: [
      { hex: '#132413', role: 'bg-base', share: 0.5 },
      { hex: '#101a10', role: 'bg-layer', share: 0.25 },
      { hex: '#33ff66', role: 'brand', share: 0.1 },
      { hex: '#b8ffc8', role: 'label', share: 0.08 },
      { hex: '#1e3a1e', role: 'border', share: 0.07 },
    ],
    typography: { family: '"Cascadia Mono", Consolas, monospace', mono: '"Cascadia Mono", Consolas, monospace' },
    spacing: { density: 'comfortable', radius: 2 },
    shapeLanguage: '',
    borderStyle: 'border: 1px solid var(--dsw-alias-border-l2);',
    shadowStyle: 'box-shadow: 0 0 12px rgba(51,255,102,0.25);',
    backgroundStyle: 'background: radial-gradient(ellipse at 50% -20%, rgba(51,255,102,0.12), transparent 60%), var(--dsw-alias-bg-base);',
    headerStyle: 'border-bottom: 1px solid var(--dsw-alias-border-l1);',
    sidebarStyle: 'background: var(--dsw-specific-sidebar-fill); border-right: 1px solid var(--dsw-alias-border-l1);',
    messageStyle: '',
    inputStyle: 'background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary);',
    buttonStyle: 'background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary);',
    cardStyle: 'background: var(--dsw-alias-bg-layer-1);',
    iconStyle: '',
    chromeElements: ['scanlines', 'statusbar'],
    decorativeElements: ['glow'],
    assetCandidates: [],
  }
  let repairCount = 0
  return {
    visionAvailable: () => true,
    analyzeImage: async () => ({
      summary: 'fixture：磷光终端风格参考图',
      layout: [{ region: 'sidebar', content: '深色窄栏' }, { region: 'main', content: '墨绿背景与磷光文字' }],
      entities: ['terminal', 'crt'],
      colors: [{ hex: '#0b120b', share: 1 }],
      text: 'FIXTURE-VISION',
      raw: 'fixture（确定性测试夹具，非真实视觉）',
      source: { kind: 'fixture' as const },
      colorSource: 'vision' as const,
    }),
    designSpec: async (_evidence, hints) => ({ ...base, visualStyle: 'fixture-' + hints.name }),
    reobserveRegion: async (_cropPath, regionId) => ({
      summary: 'fixture 区域观察：参考色 #0b120b（确定性测试夹具，非真实视觉）',
      layout: [{ region: regionId, content: '均匀底色' }],
      entities: ['background'],
      colors: [{ hex: '#0b120b', share: 1 }],
      text: '',
      raw: 'fixture-region',
      source: { kind: 'fixture' as const },
      colorSource: 'vision' as const,
    }),
    repairDecision: async input => {
      repairCount += 1
      void input
      // fixture 修复决策：底色对齐参考（#132413 → #0b120b）；同一决策重复时循环由振荡护栏停止
      return {
        targetRegions: ['global'],
        problemAssessment: 'fixture 修复：背景色偏离参考色',
        specChanges: [{
          path: 'colorPalette[0].hex',
          newValue: '#0b120b',
          reason: 'fixture 确定性决策：底色对齐参考 #0b120b',
          targetRegion: 'global',
          expectedEffect: '降低 pixel.diffRatio 与 region.meanDelta',
        }],
        confidence: 0.8,
      }
    },
  }
}
