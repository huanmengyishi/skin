import { describe, expect, it } from 'vitest'
import { liveBrain, type LlmFace } from '../../src/generator/vision'

function fakeLlm(visionText: string): LlmFace {
  return {
    listProviders: () => [{ id: 'vision-http' }, { id: 'deepseek-official' }],
    listModels: (p: string) => p === 'vision-http' ? [{ id: 'ovh/Qwen2.5-VL-72B-Instruct' }] : [{ id: 'deepseek-v4-flash', modality: 'text' }],
    stream: async function* (options: { provider: string }) {
      if (options.provider === 'vision-http') yield { type: 'text-delta', text: visionText }
      else yield { type: 'text-delta', text: '{}' }
      yield { type: 'finish', reason: 'stop' }
    },
  }
}

const att = { saveImage: async () => ({ attachmentId: 'sha256:fake' }) }
const TINY = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

describe('v1.2 VisionEvidence schema（事实层）', () => {
  it('schema 字段齐备 + source/colorSource/raw 可追踪', async () => {
    const text = JSON.stringify({ summary: '深蓝夜', layout: [{ region: 'header', content: '深色' }], entities: ['moon'], colors: [{ hex: '#1a1a2e', share: 0.6 }], text: '' })
    const brain = liveBrain(fakeLlm(text), att)
    const p = (await import('node:os')).tmpdir() + '/dsh-skin-ve-' + Date.now() + '.png'
    const { writeFileSync, rmSync } = await import('node:fs')
    writeFileSync(p, TINY)
    const evidence = await brain.analyzeImage(p)
    rmSync(p, { force: true })
    expect(evidence.summary).toBe('深蓝夜')
    expect(evidence.colors).toEqual([{ hex: '#1a1a2e', share: 0.6 }])
    expect(evidence.source?.kind).toBe('vision-json')
    expect(evidence.colorSource).toBe('vision')
    expect(evidence.raw).toBe(text)
  })

  it('归一化：非法颜色丢弃不伪造；region 证据 = layout（模型观察，vision_ground 属 agent seam 边界）', async () => {
    const text = JSON.stringify({ summary: 'x', layout: [{ region: 'sidebar', content: '窄栏' }], entities: [], colors: [{ hex: '蓝色', share: 0.5 }, { hex: '#12345', share: 0.5 }], text: '' })
    const brain = liveBrain(fakeLlm(text), att)
    const p = (await import('node:os')).tmpdir() + '/dsh-skin-ve2-' + Date.now() + '.png'
    const { writeFileSync, rmSync } = await import('node:fs')
    writeFileSync(p, TINY)
    const evidence = await brain.analyzeImage(p)
    rmSync(p, { force: true })
    expect(evidence.colors).toEqual([])
    expect(evidence.layout).toEqual([{ region: 'sidebar', content: '窄栏' }])
    expect(evidence.source?.kind).toBe('vision-json')
  })
})

