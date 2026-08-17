/**
 * 视觉失败分类（Q5）：只消费 vision-router 抛出的错误结构并分类；
 * 不在 dsh-skin 内实现任何 provider retry/fallback（retry ownership 属于 vision-router）。
 * @module dsh-skin/src/generator/failure
 */

export type VisionFailureClass =
  | 'RATE_LIMITED' | 'PROVIDER_UNAVAILABLE' | 'TIMEOUT' | 'INVALID_INPUT'
  | 'AUTH_FAILURE' | 'MODEL_UNAVAILABLE' | 'VISION_OUTPUT_INVALID' | 'CACHE_ERROR'
  | 'QUEUE_CANCELLED' | 'UNKNOWN'

/** 按 vision-router 实际错误文本/结构分类（字符串模式，不伪造 provider 错误）。 */
export function classifyVisionFailure(error: unknown): VisionFailureClass {
  if (error !== null && typeof error === 'object' && 'visionFailureClass' in error && typeof (error as { visionFailureClass?: unknown }).visionFailureClass === 'string') {
    return (error as { visionFailureClass: VisionFailureClass }).visionFailureClass
  }
  const message = String((error as { message?: unknown } | null)?.message ?? error ?? '')
  if (/429|rate.?limit|too many requests|quota/i.test(message)) return 'RATE_LIMITED'
  if (/timed? ?out|timeout/i.test(message)) return 'TIMEOUT'
  if (/401|403|unauthorized|forbidden|api[ -]?key|auth/i.test(message)) return 'AUTH_FAILURE'
  if (/model.*(not|invalid|unavailable)|INVALID_MODEL/i.test(message)) return 'MODEL_UNAVAILABLE'
  if (/invalid input|unsupported|不支持的图片|图片.*(格式|解码|为空)/.test(message)) return 'INVALID_INPUT'
  if (/ECONN|ENOTFOUND|ETIMEDOUT|connect|unavailable|down|5\d\d|failed to fetch/i.test(message)) return 'PROVIDER_UNAVAILABLE'
  if (/vision|视觉|evidence|输出|output/i.test(message)) return 'VISION_OUTPUT_INVALID'
  return 'UNKNOWN'
}

