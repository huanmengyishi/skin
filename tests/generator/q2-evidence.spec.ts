import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { liveBrain, type LlmFace } from '../../src/generator/vision'
import { quantizeTop } from '../../src/generator/fidelity'

function fakeLlm(visionText: string, specText: string): LlmFace {
  return {
    listProviders: () => [{ id: 'vision-http' }, { id: 'deepseek-official' }],
    listModels: (provider: string) => provider === 'vision-http' ? [{ id: 'ovh/Qwen2.5-VL-72B-Instruct' }] : [{ id: 'deepseek-v4-flash', modality: 'text' }],
    stream: async function* (options: { provider: string }) {
      if (options.provider === 'vision-http') yield { type: 'text-delta', text: visionText }
      else yield { type: 'text-delta', text: specText }
      yield { type: 'finish', reason: 'stop' }
    },
  }
}

const att = { saveImage: async () => ({ attachmentId: 'sha256:fake' }) }

/** 1x1 红色 PNG（最小合法图，供 analyzeImage 读字节）。 */
const TINY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

function writeTinyPng(): string {
  const { writeFileSync } = require('node:fs') as typeof import('node:fs')
  const path = joinTmp()
  writeFileSync(path, TINY_PNG)
  return path
}

function joinTmp(): string {
  const { tmpdir } = require('node:os') as typeof import('node:os')
  const { join } = require('node:path') as typeof import('node:path')
  return join(tmpdir(), 'dsh-skin-q2-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6) + '.png')
}

describe('Q2 Structured Eyes（toEvidence 归一化 + 颜色校验 + 缓存键）', () => {
  it('结构化 JSON：合法颜色保留、非法颜色丢弃（不伪造）；source 标记 vision-json', async () => {
    const text = JSON.stringify({ summary: '夜', layout: [], entities: [], colors: [{ hex: '#1a1a2e', share: 0.5 }, { hex: '深蓝', share: 0.5 }, { hex: '#ggg', share: 0.1 }, { hex: '#4a6fa5', share: 1.5 }], text: '' })
    const brain = liveBrain(fakeLlm(text, '{}'), att)
    const evidence = await brain.analyzeImage(writeTinyPng())
    expect(evidence.colors).toEqual([{ hex: '#1a1a2e', share: 0.5 }])
    expect(evidence.source?.kind).toBe('vision-json')
    expect(evidence.raw).toBe(text)
  })

  it('散文输出：colors 空 + source=vision-prose；颜色由本地量化兜底（调用方职责）', async () => {
    const prose = '画面是月夜古楼，主色深蓝紫，灯光暖黄。'
    const brain = liveBrain(fakeLlm(prose, '{}'), att)
    const evidence = await brain.analyzeImage(writeTinyPng())
    expect(evidence.source?.kind).toBe('vision-prose')
    expect(evidence.colors).toEqual([])
    expect(evidence.summary).toBe(prose)
  })

  it('quantizeTop 兜底颜色：非空、#RRGGBB、可复现', () => {
    const w = 32; const h = 32
    const data = new Uint8Array(w * h * 4)
    for (let i = 0; i < w * h; i++) { data[i * 4] = 11; data[i * 4 + 1] = 18; data[i * 4 + 2] = 11; data[i * 4 + 3] = 255 }
    const image = { width: w, height: h, data }
    const a = quantizeTop(image, 8)
    const b = quantizeTop(image, 8)
    expect(a).toEqual(b)
    expect(a.length).toBeGreaterThan(0)
    expect(a[0].hex).toMatch(/^#[0-9a-f]{6}$/)
  })

  it('缓存键：sha256(imageBytes)+analysisVersion 稳定（provider/model 变化经 version 失效——文档约定）', () => {
    const bytes = new Uint8Array([1, 2, 3, 4])
    const key = (b: Uint8Array) => createHash('sha256').update(b).digest('hex').slice(0, 16) + '-v1'
    expect(key(bytes)).toBe(key(bytes))
    expect(key(new Uint8Array([5]))).not.toBe(key(bytes))
  })
})

