/**
 * 视觉分析队列（Q5）：按 provider 串行化受限资源；有界队列（满则分类拒绝）；全程可观测。
 * 不做 provider retry（vision-router 职责）；不同 provider 各自成链互不阻塞。
 * @module dsh-skin/src/generator/vision-queue
 */

import type { VisionFailureClass } from './failure.ts'
import { classifyVisionFailure } from './failure.ts'

export interface VisionQueueRecord {
  queueKey: string
  queuedAt: number
  startedAt: number
  finishedAt: number
  ok: boolean
  failureClass: VisionFailureClass | null
  durationMs: number
}

export class VisionQueue {
  private readonly chains = new Map<string, Promise<unknown>>()
  private readonly pending = new Map<string, number>()
  constructor(private readonly options: { maxQueueSize?: number; observer?: (record: VisionQueueRecord) => void } = {}) {}

  private get maxQueueSize(): number { return this.options.maxQueueSize ?? 4 }

  pendingCount(key: string): number { return this.pending.get(key) ?? 0 }

  /** 按 key（provider）串行执行；队列满抛 QUEUE_CANCELLED 分类错误。 */
  async run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const current = this.pending.get(key) ?? 0
    if (current >= this.maxQueueSize) {
      const error = new Error('vision 队列已满（provider=' + key + '，maxQueueSize=' + this.maxQueueSize + '）')
      Object.assign(error, { visionFailureClass: 'QUEUE_CANCELLED' as VisionFailureClass })
      throw error
    }
    this.pending.set(key, current + 1)
    const queuedAt = Date.now()
    const record: VisionQueueRecord = { queueKey: key, queuedAt, startedAt: 0, finishedAt: 0, ok: false, failureClass: null, durationMs: 0 }
    const previous = this.chains.get(key) ?? Promise.resolve()
    const run = previous.then(async (): Promise<T> => {
      record.startedAt = Date.now()
      try {
        const value = await task()
        record.ok = true
        return value
      } catch (error) {
        record.failureClass = classifyVisionFailure(error)
        throw error
      } finally {
        record.finishedAt = Date.now()
        record.durationMs = record.finishedAt - record.startedAt
        this.pending.set(key, (this.pending.get(key) ?? 1) - 1)
        this.options.observer?.(record)
      }
    })
    this.chains.set(key, run.catch(() => undefined))
    return await run
  }
}

