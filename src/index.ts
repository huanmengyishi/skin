/**
 * dsh-skin 宿主半边：
 * - SkinRepository 服务（ctx.skinRepository）
 * - settings namespace 'dsh-skin'（activeSkin 持久化）
 * - /dsh-skin/* HTTP 路由（registry 投影、皮肤包文件服务、安装/卸载入口）
 * 皮肤包文件只经路径守卫提供；写路由带同源栅栏；皮肤状态绝不写 cordis.patch.yml。
 * @module dsh-skin/src/index
 */

import { createHash } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zipSync } from 'fflate'
import type { Context } from '@deepseek-ai/cordis'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { nodeFs, resolveInside } from './repository/fs.ts'
import { SkinRepository } from './repository/repository.ts'
import { isValidSkinId, validateManifest } from './core/manifest.ts'
import { slugifySkinId, validateSkinDesignSpec } from './core/spec.ts'
import { resolveSkinRoots } from './repository/store.ts'
import { generateSkin } from './generator/iterate.ts'
import { GenerationService, GenerationStore, bumpPatchVersion, evidenceHashOf, type CreateGenerationInput } from './generator/lifecycle.ts'
import { applySpecPatch, specSha256, validateRepairDecision, type RepairDecision } from './generator/repair.ts'
import { packageTreeSha256 } from './generator/package-build.ts'
import type { VisionEvidence } from './generator/vision.ts'
import { fixtureBrain, liveBrain, type LlmFace } from './generator/vision.ts'
import { WorkshopClient } from './workshop/client.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 宿主侧皮肤仓库服务（SkinRepository）。 */
    skinRepository: SkinRepository
  }
}

export const name = 'dsh-skin'

/** 需要 webServer；settings 可选（缺省时 activeSkin 仅进程内有效）。 */
export const inject = ['webServer']

/** 用户设置 schema：唯一持久化字段 activeSkin。 */
export const ActiveSkinSettingsSchema = z.object({
  activeSkin: z.string().default(''),
  workshopUrl: z.string().default(''),
})
export type ActiveSkinSettings = { activeSkin: string; workshopUrl: string }

const CONTENT_TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
}

function contentTypeOf(path: string): string {
  const dot = path.lastIndexOf('.')
  if (dot < 0) return 'application/octet-stream'
  return CONTENT_TYPES[path.slice(dot).toLowerCase()] ?? 'application/octet-stream'
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(body)
}

/** 同源栅栏：写路由只接受同源（或无 Sec-Fetch-Site 的非浏览器客户端）。 */
function isSameOrigin(req: IncomingMessage): boolean {
  const site = req.headers['sec-fetch-site']
  return site === undefined || site === 'same-origin' || site === 'none'
}

export function apply(ctx: Context): void {
  const home = resolveDshHome()
  const roots = resolveSkinRoots(home)
  const builtinRoot = fileURLToPath(new URL('../skins', import.meta.url))
  const atomicWrite = (path: string, text: string): Promise<void> => writeFileAtomic(path, text, { mode: 0o600 })

  const repository = new SkinRepository(nodeFs(), roots, builtinRoot, atomicWrite)
  ctx.provide('skinRepository', repository)
  void repository.hydrate().catch(error => {
    ctx.logger?.warn?.('dsh-skin: repository hydrate failed:', error)
  })

  // v1.5 AI Skin Lifecycle：生成记录索引（原子写）+ 托管服务（取消/并发锁/阶段/恢复）
  const generationRoot = join(roots.cache, 'generation')
  const generationStore = new GenerationStore(nodeFs(), join(generationRoot, 'records.json'), atomicWrite)
  const generationService = new GenerationService(nodeFs(), generationRoot, generationStore)
  void generationService.recover().then(stale => {
    if (stale.length > 0) ctx.logger?.warn?.('dsh-skin: recovered interrupted generations:', stale.length)
  })

  // 可选依赖 settings：注册 activeSkin namespace（无 settings 提供者时整体跳过）
  ctx.inject(['settings'], settingsCtx => {
    settingsCtx.settings.register(settingsNamespace('dsh-skin'), ActiveSkinSettingsSchema)
  })

  ctx.inject(['webServer'], httpCtx => {
    httpCtx.effect(() => {
      const disposers: (() => void)[] = []

      disposers.push(httpCtx.webServer.register({
        kind: 'exact',
        path: '/dsh-skin/api/skins',
        handler: async (_req, res) => {
          try {
            await repository.registry.refresh()
            const entries = repository.list().map(entry => ({
              id: entry.id,
              source: entry.source,
              version: entry.version,
              name: entry.name,
              author: entry.author,
              description: entry.description,
              tags: entry.tags,
              skinApiVersion: entry.skinApiVersion,
              preview: entry.preview,
              state: entry.state,
              issues: entry.issues.slice(0, 8),
              shadowsBuiltin: entry.shadowsBuiltin,
              updatedAtMs: entry.updatedAtMs,
              trust: entry.trust,
            }))
            sendJson(res, 200, { skins: entries })
          } catch (error) {
            sendJson(res, 500, { error: 'dsh-skin: registry refresh failed', detail: String((error as Error).message) })
          }
        },
      }))

      disposers.push(httpCtx.webServer.register({
        kind: 'prefix',
        path: '/dsh-skin/api/skins',
        handler: async (req, res) => {
          const url = new URL(req.url ?? '/', 'http://dsh-skin.local')
          const rest = url.pathname.slice('/dsh-skin/api/skins'.length)
          const parts = rest.split('/').filter(Boolean)
          const id = parts[0] ?? ''
          const action = parts[1] ?? ''
          const entry = isValidSkinId(id) ? repository.get(id) : undefined
          // v1.5：reinstall 允许未安装的 AI Skin（历史 final 包重装）；其余动作仍要求 registry 条目存在
          if (entry === undefined && action !== 'reinstall') return sendJson(res, 404, { error: 'skin not found', id })
          // v1.5 重新安装：仅从最新 COMPLETED 历史 final 包（不调用 Vision/DeepSeek）
          if (action === 'reinstall' && req.method === 'POST') {
            if (!isSameOrigin(req)) return sendJson(res, 403, { error: 'cross-site request rejected' })
            if (!isLoopback(req)) return sendJson(res, 403, { error: '重新安装仅允许 loopback' })
            const latest = await generationService.latestCompleted(id)
            if (latest === undefined) return sendJson(res, 404, { error: '无已完成的生成历史可重装' })
            const finalDir = join(generationRoot, latest.generationId, 'final')
            try {
              await nodeFs().readText(join(finalDir, 'manifest.json'))
            } catch {
              return sendJson(res, 400, { error: '历史 final 包缺失', detail: finalDir })
            }
            const existing = repository.get(id)
            const installed = existing !== undefined
              ? await repository.replace(finalDir, { kind: 'generated' })
              : await repository.install(finalDir, { kind: 'generated' })
            if (!installed.ok) return sendJson(res, 400, { ok: false, issues: installed.issues, failureDomain: 'INSTALL' })
            return sendJson(res, 200, { ok: true, skinId: id, version: latest.packageVersion, reinstalled: true })
          }
                    // v1.5：reinstall 之外的其余动作要求 registry 条目存在（TS 收窄）
          if (entry === undefined) return sendJson(res, 404, { error: 'skin not found', id })
          // 生成/本地皮肤生命周期：编辑 metadata（仅非内置）
          if (action === 'meta' && req.method === 'POST') {
            if (!isSameOrigin(req)) return sendJson(res, 403, { error: 'cross-site request rejected' })
            if (!isLoopback(req)) return sendJson(res, 403, { error: '编辑仅允许 loopback' })
            if (entry.source === 'builtin') return sendJson(res, 403, { error: '内置皮肤不可编辑' })
            let body = ''
            for await (const chunk of req) body += String(chunk)
            let patch: Record<string, unknown>
            try { patch = JSON.parse(body) as Record<string, unknown> } catch { return sendJson(res, 400, { error: 'bad json body' }) }
            try {
              const manifestPath = join(entry.path, 'manifest.json')
              const current = JSON.parse(await fsp.readFile(manifestPath, 'utf8')) as Record<string, unknown>
              if (typeof patch.name === 'string' && patch.name.trim().length > 0 && patch.name.trim().length <= 64) current.name = patch.name.trim()
              if (typeof patch.author === 'string' && patch.author.trim().length > 0) current.author = patch.author.trim()
              if (typeof patch.description === 'string' && patch.description.length <= 512) current.description = patch.description
              if (Array.isArray(patch.tags)) {
                const tags = patch.tags.filter((tag): tag is string => typeof tag === 'string' && /^[a-z0-9][a-z0-9-]{0,31}$/.test(tag)).slice(0, 16)
                current.tags = tags
              }
              const validation = validateManifest(current)
              if (!validation.ok) return sendJson(res, 400, { error: '更新后 manifest 非法', issues: validation.issues.map(i => i.path + ' ' + i.message) })
              await atomicWrite(manifestPath, JSON.stringify(current, null, 2) + '\n')
              const { hashPackage } = await import('./core/integrity.ts')
              const integrity = await hashPackage(nodeFs(), entry.path)
              await atomicWrite(join(entry.path, 'integrity.json'), JSON.stringify(integrity, null, 2) + '\n')
              await repository.registry.refresh()
              const updated = repository.get(id)
              return sendJson(res, 200, { ok: true, name: updated?.name, author: updated?.author, description: updated?.description, tags: updated?.tags })
            } catch (error) {
              return sendJson(res, 500, { error: 'metadata 更新失败', detail: String((error as Error).message) })
            }
          }
          // 导出：包目录 → zip（统一 Skin Package 交换格式）
          if (action === 'export' && req.method === 'GET') {
            if (!isSameOrigin(req)) return sendJson(res, 403, { error: 'cross-site request rejected' })
            if (entry.source === 'builtin') return sendJson(res, 403, { error: '内置皮肤无需导出' })
            try {
              const { buildPackageZip } = await import('./repository/export.ts')
              const zipped = await buildPackageZip(nodeFs(), entry.path)
              res.writeHead(200, {
                'Content-Type': 'application/zip',
                'Content-Disposition': 'attachment; filename="' + id + '-' + entry.version + '.skinpackage.zip"',
              })
              res.end(Buffer.from(zipped))
              return
            } catch (error) {
              return sendJson(res, 500, { error: '导出失败', detail: String((error as Error).message), domain: 'EXPORT' })
            }
          }
          // v1.5 设计编辑：Spec Patch（复用 v1.4 repair.ts 校验/应用）→ 新 generation（parent 链）→ v1.3 构建 + v1.4 修复环 → 原子 replace
          if (action === 'spec-edit' && req.method === 'POST') {
            if (!isSameOrigin(req)) return sendJson(res, 403, { error: 'cross-site request rejected' })
            if (!isLoopback(req)) return sendJson(res, 403, { error: '设计编辑仅允许 loopback' })
            if (entry.source !== 'generated') return sendJson(res, 400, { error: '仅生成的皮肤支持设计编辑' })
            let body = ''
            for await (const chunk of req) body += String(chunk)
            let parsed: Record<string, unknown>
            try { parsed = JSON.parse(body) as Record<string, unknown> } catch { return sendJson(res, 400, { error: 'bad json body' }) }
            const runDir = await latestRunDirFor(entry.id)
            if (runDir === undefined) return sendJson(res, 404, { error: '未找到该皮肤的历史生成记录' })
            let imageBytes: Uint8Array
            let currentSpec: unknown
            let initialEvidence: VisionEvidence | undefined
            try {
              imageBytes = new Uint8Array(await nodeFs().readFile(join(runDir, 'input.png')))
              currentSpec = await readRunSpec(runDir)
              try { initialEvidence = JSON.parse(await nodeFs().readText(join(runDir, 'evidence.json'))) as VisionEvidence } catch { initialEvidence = undefined }
            } catch (error) {
              return sendJson(res, 500, { error: '读取历史生成记录失败', detail: String((error as Error).message) })
            }
            const decision = parsed.decision as unknown
            const validated = validateRepairDecision(decision, { worstRegionIds: [], maxChangedFields: 4 })
            if (!validated.ok) return sendJson(res, 400, { ok: false, issues: validated.issues, failureDomain: 'GENERATION_INPUT' })
            const patched = applySpecPatch(currentSpec as never, validated.decision)
            if (!patched.ok) return sendJson(res, 400, { ok: false, issues: patched.issues, failureDomain: 'SPEC' })
            const specCheck = validateSkinDesignSpec(patched.spec)
            if (!specCheck.ok) return sendJson(res, 400, { ok: false, issues: ['patch 后 spec 校验失败：' + specCheck.issues.join('；')], failureDomain: 'SPEC_VALIDATION' })
            const parent = await generationService.latestCompleted(entry.id)
            const version = bumpPatchVersion(entry.version)
            const created = await generationService.create({
              skinId: entry.id,
              name: entry.name,
              description: entry.description,
              tags: entry.tags,
              version,
              imageBytes,
              source: 'design-edit',
              parentGenerationId: parent?.generationId,
            } satisfies CreateGenerationInput)
            if (!created.ok) return sendJson(res, 400, { ok: false, issues: created.issues, failureDomain: created.failureDomain })
            const outcome = await runGeneration({
              generationId: created.record.generationId,
              skinId: entry.id,
              name: entry.name,
              author: entry.author,
              description: entry.description,
              tags: entry.tags,
              imageBytes,
              initialSpec: specCheck.spec,
              initialEvidence,
              version,
              replaceExisting: true,
              maxIterations: typeof parsed.maxIterations === 'number' ? parsed.maxIterations : undefined,
            })
            return sendJson(res, outcome.status, outcome.body)
          }

          if (action !== '') return sendJson(res, 404, { error: 'not found' })
          const clientPath = 'client/index.js'
          let rev = ''
          try {
            const bytes = await repository.readFile(id, clientPath)
            if (bytes !== undefined) rev = createHash('sha1').update(bytes).digest('hex').slice(0, 12)
          } catch { /* rev 留空 */ }
          sendJson(res, 200, {
            id: entry.id,
            source: entry.source,
            state: entry.state,
            issues: entry.issues.slice(0, 8),
            manifest: {
              id: entry.id,
              version: entry.version,
              name: entry.name,
              author: entry.author,
              description: entry.description,
              tags: entry.tags,
              skinApiVersion: entry.skinApiVersion,
              preview: entry.preview,
            },
            files: {
              bundle: '/dsh-skin/skins/' + entry.id + '/files/' + clientPath + (rev.length > 0 ? '?v=' + rev : ''),
              styles: '/dsh-skin/skins/' + entry.id + '/files/styles/theme.css',
              themeLight: '/dsh-skin/skins/' + entry.id + '/files/theme/light.json',
              themeDark: '/dsh-skin/skins/' + entry.id + '/files/theme/dark.json',
              previewLight: entry.preview.light !== undefined ? '/dsh-skin/skins/' + entry.id + '/files/' + entry.preview.light : undefined,
              previewDark: entry.preview.dark !== undefined ? '/dsh-skin/skins/' + entry.id + '/files/' + entry.preview.dark : undefined,
            },
            rev,
            updatedAtMs: entry.updatedAtMs,
            trust: entry.trust,
          })
        },
      }))

      // ---- v1.5 生成托管助手（generate/regenerate/spec-edit 共用；记录/取消/恢复经 GenerationService） ----
      const llm = ctx.get('llm')
      const attachments = ctx.get('attachments')
      const brain = process.env.DSH_SKIN_TEST_MODE === '1'
        ? fixtureBrain()
        : llm === undefined
          ? { visionAvailable: () => false } as never
          : liveBrain(llm as unknown as LlmFace, attachments as never | undefined)
      const runSpecFile = (runDir: string, bestIteration: number): string => {
        return bestIteration === 0 ? 'design-spec.json' : 'design-spec-iteration-' + bestIteration + '.json'
      }
      const readRunSpec = async (runDir: string): Promise<unknown> => {
        let best = 0
        try { best = Number((JSON.parse(await nodeFs().readText(join(runDir, 'report.json'))) as { bestIteration?: number }).bestIteration ?? 0) } catch { best = 0 }
        return JSON.parse(await nodeFs().readText(join(runDir, runSpecFile(runDir, best))))
      }
      const runGeneration = async (params: {
        generationId: string
        skinId: string
        name: string
        imageBytes: Uint8Array
        initialSpec?: unknown
        initialEvidence?: VisionEvidence
        version?: string
        replaceExisting: boolean
        maxIterations?: number
        description?: string
        tags?: string[]
        author?: string
      }): Promise<{ status: number; body: Record<string, unknown> }> => {
        const started = await generationService.start(params.generationId)
        if (!started.ok) return { status: 400, body: { ok: false, issues: started.issues, failureDomain: started.failureDomain } }
        const onStage = (stage: string, detail?: Record<string, unknown>): void => {
          void generationService.onStage(params.generationId, stage as never, detail).catch(() => undefined)
        }
        const result = await generateSkin(
          {
            fs: nodeFs(),
            workspaceRoot: generationRoot,
            brain,
            repository,
            signal: started.signal,
            onStage: onStage as never,
          },
          {
            imageBytes: params.imageBytes,
            name: params.name,
            id: params.skinId,
            description: params.description,
            tags: params.tags,
            author: params.author,
            maxIterations: params.maxIterations,
            version: params.version,
            initialSpec: params.initialSpec as never,
            initialEvidence: params.initialEvidence,
            replaceExisting: params.replaceExisting,
            runId: params.generationId,
          },
        )
        const runDir = join(generationRoot, params.generationId)
        let evidenceHash: string | undefined
        let specHash: string | undefined
        let packageHash: string | undefined
        try { evidenceHash = evidenceHashOf(JSON.parse(await nodeFs().readText(join(runDir, 'evidence.json')))) } catch { /* 无证据面（旧 initialSpec 路径） */ }
        try { specHash = (JSON.parse(await nodeFs().readText(join(runDir, 'build-manifest.json'))) as { inputIdentity?: { specSha256?: string } }).inputIdentity?.specSha256 } catch { /* 构建未达 */ }
        try { packageHash = await packageTreeSha256(nodeFs(), join(runDir, 'final')) } catch { /* 未封存 */ }
        if (result.ok) {
          await generationService.complete(params.generationId, { status: 'COMPLETED', evidenceHash, specHash, packageHash })
          return {
            status: 200,
            body: {
              ok: true,
              skinId: result.skinId,
              generationId: params.generationId,
              runId: result.runId,
              iterations: result.iterations.map(iteration => ({ index: iteration.index, status: iteration.status, diffRatio: iteration.diffRatio, converged: iteration.converged })),
              finalDiffRatio: result.finalDiffRatio,
              loopStatus: result.loopStatus,
              requestStats: result.requestStats,
              reportPath: result.reportPath,
            },
          }
        }
        const cancelled = result.failureDomain === 'CANCELLED'
        await generationService.complete(params.generationId, {
          status: cancelled ? 'CANCELLED' : 'FAILED',
          failureDomain: result.failureDomain,
          failureMessage: result.issues.join('；'),
          evidenceHash,
          specHash,
        })
        return {
          status: result.issues.some(issue => issue.includes('视觉依赖不可用')) ? 503 : 400,
          body: { ok: false, issues: result.issues, failureDomain: result.failureDomain, generationId: params.generationId, status: cancelled ? 'CANCELLED' : 'FAILED' },
        }
      }
      const readPendingImage = async (generationId: string): Promise<Uint8Array> => {
        return await nodeFs().readFile(join(generationRoot, 'pending-' + generationId, 'input.png'))
      }
      const readImageBase64 = (base64: string): { ok: true; bytes: Uint8Array } | { ok: false; message: string } => {
        try {
          const buffer = Buffer.from(base64, 'base64')
          if (buffer.length === 0 || buffer.length > 8 * 1024 * 1024) return { ok: false, message: '图片为空或超过 8MB' }
          return { ok: true, bytes: new Uint8Array(buffer) }
        } catch {
          return { ok: false, message: '图片解码失败' }
        }
      }
      const latestRunDirFor = async (skinId: string): Promise<string | undefined> => {
        const latest = await generationService.latestCompleted(skinId)
        if (latest !== undefined) return join(generationRoot, latest.generationId)
        // v1.5 之前的遗留 run（无记录）：扫描 report.json（旧逻辑保留）
        let best: string | undefined
        try {
          for (const entry of await nodeFs().readdir(generationRoot)) {
            if (!entry.isDirectory() || !entry.name.startsWith('gen-')) continue
            try {
              const report = JSON.parse(await nodeFs().readText(join(generationRoot, entry.name, 'report.json'))) as { skinId?: string }
              if (report.skinId === skinId && (best === undefined || entry.name > best)) best = entry.name
            } catch { /* 忽略无报告/损坏的 run */ }
          }
        } catch { best = undefined }
        return best === undefined ? undefined : join(generationRoot, best)
      }
      const ACTIVE_SETTINGS_NS = settingsNamespace('dsh-skin')
      const isLoopback = (req: IncomingMessage): boolean => {
        const address = req.socket.remoteAddress ?? ''
        return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
      }
      const readActive = (): string | null => {
        const settings = ctx.get('settings')
        if (settings === undefined) return null
        const section = settings.get(ACTIVE_SETTINGS_NS) as { activeSkin?: unknown } | undefined
        return typeof section?.activeSkin === 'string' && section.activeSkin.length > 0 ? section.activeSkin : null
      }

      // 宿主 Web settings 网关对浏览器暴露的是硬编码白名单（WEB_SETTINGS_NAMESPACES，
      // 不含插件自有 namespace，settings-not-exposed）→ dsh-skin 走自有 loopback API，
      // 但持久化仍落在官方 settings seam（settings.yaml 的 dsh-skin 段）。
      disposers.push(httpCtx.webServer.register({
        kind: 'exact',
        path: '/dsh-skin/api/active',
        handler: async (req, res) => {
          if (!isSameOrigin(req)) return sendJson(res, 403, { error: 'cross-site request rejected' })
          if (req.method === 'GET') {
            return sendJson(res, 200, { activeSkin: readActive() })
          }
          if (!isLoopback(req)) return sendJson(res, 403, { error: 'active-skin 写入仅允许 loopback（与宿主 settings 网关姿态一致）' })
          let body = ''
          for await (const chunk of req) body += String(chunk)
          let activeSkin: string | null
          try {
            const parsed = JSON.parse(body) as { activeSkin?: unknown }
            if (parsed.activeSkin === null || parsed.activeSkin === '') activeSkin = null
            else if (typeof parsed.activeSkin === 'string' && isValidSkinId(parsed.activeSkin)) activeSkin = parsed.activeSkin
            else return sendJson(res, 400, { error: 'activeSkin 必须是合法 skin id 或 null' })
          } catch {
            return sendJson(res, 400, { error: 'bad json body' })
          }
          const settings = ctx.get('settings')
          if (settings === undefined) return sendJson(res, 503, { error: 'settings 服务未挂载' })
          try {
            await settings.update(ACTIVE_SETTINGS_NS, { activeSkin: activeSkin ?? '' })
            return sendJson(res, 200, { activeSkin })
          } catch (error) {
            return sendJson(res, 500, { error: 'settings 写入失败', detail: String((error as Error).message) })
          }
        },
      }))

      // Workshop 读取/下载/安装（网络层只做 search/metadata/download；安装复用本地仓库管线）
      const readWorkshopUrl = (): string => {
        const settings = ctx.get('settings')
        if (settings === undefined) return ''
        const section = settings.get(settingsNamespace('dsh-skin')) as { workshopUrl?: unknown } | undefined
        return typeof section?.workshopUrl === 'string' ? section.workshopUrl.trim() : ''
      }
      const makeWorkshopClient = (): WorkshopClient => new WorkshopClient(readWorkshopUrl(), fetch as never)
      const offlineBody = (error: unknown): Record<string, unknown> => ({
        configured: readWorkshopUrl().length > 0,
        offline: true,
        error: String((error as Error).message),
        skins: [],
      })

      disposers.push(httpCtx.webServer.register({
        kind: 'exact',
        path: '/dsh-skin/api/config',
        handler: async (req, res) => {
          if (!isSameOrigin(req)) return sendJson(res, 403, { error: 'cross-site request rejected' })
          if (req.method === 'GET') return sendJson(res, 200, { workshopUrl: readWorkshopUrl() })
          if (!isLoopback(req)) return sendJson(res, 403, { error: '配置写入仅允许 loopback' })
          let body = ''
          for await (const chunk of req) body += String(chunk)
          let workshopUrl = ''
          try {
            const parsed = JSON.parse(body) as { workshopUrl?: unknown }
            workshopUrl = typeof parsed.workshopUrl === 'string' ? parsed.workshopUrl.trim() : ''
          } catch { return sendJson(res, 400, { error: 'bad json body' }) }
          if (workshopUrl.length > 0 && !/^https?:\/\//.test(workshopUrl)) return sendJson(res, 400, { error: 'workshopUrl 必须是 http(s) URL 或空' })
          const settings = ctx.get('settings')
          if (settings === undefined) return sendJson(res, 503, { error: 'settings 服务未挂载' })
          try {
            await settings.update(settingsNamespace('dsh-skin'), { workshopUrl })
            return sendJson(res, 200, { workshopUrl })
          } catch (error) {
            return sendJson(res, 500, { error: '配置写入失败', detail: String((error as Error).message) })
          }
        },
      }))

      disposers.push(httpCtx.webServer.register({
        kind: 'exact',
        path: '/dsh-skin/api/workshop/skins',
        handler: async (req, res) => {
          const url = new URL(req.url ?? '/', 'http://dsh-skin.local')
          const q = url.searchParams.get('q') ?? ''
          const tags = (url.searchParams.get('tags') ?? '').split(',').map(t => t.trim()).filter(t => t.length > 0)
          const sort = url.searchParams.get('sort') ?? ''
          try {
            const skins = await makeWorkshopClient().list({ q, tags, sort })
            return sendJson(res, 200, { configured: true, offline: false, skins })
          } catch (error) {
            return sendJson(res, 200, offlineBody(error))
          }
        },
      }))

      disposers.push(httpCtx.webServer.register({
        kind: 'prefix',
        path: '/dsh-skin/api/workshop/skins',
        handler: async (req, res) => {
          const url = new URL(req.url ?? '/', 'http://dsh-skin.local')
          const parts = url.pathname.slice('/dsh-skin/api/workshop/skins'.length).split('/').filter(Boolean)
          const skinId = parts[0] ?? ''
          if (skinId.length === 0) return sendJson(res, 404, { error: 'not found' })
          try {
            if (parts[1] === 'versions') {
              const versions = await makeWorkshopClient().versions(skinId)
              const local = repository.get(skinId)
              let localVersion = local?.version ?? null
              if (local !== undefined && local.source === 'downloaded') {
                const { readProvenance } = await import('./workshop/install.ts')
                const provenance = await readProvenance(nodeFs(), local.path)
                if (provenance !== undefined) localVersion = provenance.remoteVersion
              }
              return sendJson(res, 200, { skinId, versions, localVersion })
            }
            const info = await makeWorkshopClient().detail(skinId)
            const local = repository.get(skinId)
            return sendJson(res, 200, { ...info, localVersion: local?.source === 'downloaded' ? local.version : null })
          } catch (error) {
            return sendJson(res, 200, offlineBody(error))
          }
        },
      }))

      const requireLoopbackPost = async (req: IncomingMessage, res: ServerResponse): Promise<Record<string, unknown> | undefined> => {
        if (!isSameOrigin(req)) { sendJson(res, 403, { error: 'cross-site request rejected' }); return undefined }
        if (!isLoopback(req)) { sendJson(res, 403, { error: '该操作仅允许 loopback' }); return undefined }
        let body = ''
        for await (const chunk of req) body += String(chunk)
        try { return JSON.parse(body) as Record<string, unknown> } catch { sendJson(res, 400, { error: 'bad json body' }); return undefined }
      }

      disposers.push(httpCtx.webServer.register({
        kind: 'exact',
        path: '/dsh-skin/api/workshop/publish',
        handler: async (req, res) => {
          const parsed = await requireLoopbackPost(req, res)
          if (parsed === undefined) return
          const skinId = typeof parsed.skinId === 'string' ? parsed.skinId : ''
          if (!isValidSkinId(skinId)) return sendJson(res, 400, { error: 'skinId 非法' })
          const { publishSkin } = await import('./workshop/publish.ts')
          const result = await publishSkin(nodeFs(), repository, makeWorkshopClient(), skinId, 'new')
          if (!result.ok) return sendJson(res, 400, { ok: false, issues: result.issues })
          sendJson(res, 200, { ok: true, skinId: result.skinId, version: result.version, checksum: result.checksum })
        },
      }))

      disposers.push(httpCtx.webServer.register({
        kind: 'exact',
        path: '/dsh-skin/api/workshop/publish-version',
        handler: async (req, res) => {
          const parsed = await requireLoopbackPost(req, res)
          if (parsed === undefined) return
          const skinId = typeof parsed.skinId === 'string' ? parsed.skinId : ''
          if (!isValidSkinId(skinId)) return sendJson(res, 400, { error: 'skinId 非法' })
          const { publishSkin } = await import('./workshop/publish.ts')
          const result = await publishSkin(nodeFs(), repository, makeWorkshopClient(), skinId, 'version')
          if (!result.ok) return sendJson(res, 400, { ok: false, issues: result.issues })
          sendJson(res, 200, { ok: true, skinId: result.skinId, version: result.version, checksum: result.checksum })
        },
      }))

      disposers.push(httpCtx.webServer.register({
        kind: 'exact',
        path: '/dsh-skin/api/workshop/report',
        handler: async (req, res) => {
          const parsed = await requireLoopbackPost(req, res)
          if (parsed === undefined) return
          const skinId = typeof parsed.skinId === 'string' ? parsed.skinId : ''
          const reason = typeof parsed.reason === 'string' ? parsed.reason.trim().slice(0, 500) : ''
          if (skinId.length === 0 || reason.length === 0) return sendJson(res, 400, { error: 'skinId 与 reason 必填' })
          try {
            const result = await makeWorkshopClient().report(skinId, reason)
            return sendJson(res, 200, { ok: true, reported: result.ok })
          } catch (error) {
            return sendJson(res, 200, { ok: false, offline: error instanceof Error && error.name === 'WorkshopOfflineError', error: String((error as Error).message) })
          }
        },
      }))

      disposers.push(httpCtx.webServer.register({
        kind: 'exact',
        path: '/dsh-skin/api/workshop/download',
        handler: async (req, res) => {
          if (!isSameOrigin(req)) return sendJson(res, 403, { error: 'cross-site request rejected' })
          if (!isLoopback(req)) return sendJson(res, 403, { error: '安装入口仅允许 loopback' })
          let body = ''
          for await (const chunk of req) body += String(chunk)
          let parsed: Record<string, unknown>
          try { parsed = JSON.parse(body) as Record<string, unknown> } catch { return sendJson(res, 400, { error: 'bad json body' }) }
          const skinId = typeof parsed.skinId === 'string' ? parsed.skinId : ''
          const version = typeof parsed.version === 'string' ? parsed.version : undefined
          if (skinId.length === 0) return sendJson(res, 400, { error: 'skinId 必填' })
          const { downloadAndInstall } = await import('./workshop/install.ts')
          const result = await downloadAndInstall(
            nodeFs(),
            repository,
            roots.staging,
            () => makeWorkshopClient().download(skinId, version),
            { skinId, version: version ?? '' },
          )
          if (!result.ok) return sendJson(res, 400, { ok: false, issues: result.issues })
          sendJson(res, 200, { ok: true, skinId: result.skinId, source: 'downloaded' })
        },
      }))

      disposers.push(httpCtx.webServer.register({
        kind: 'exact',
        path: '/dsh-skin/api/workshop/update',
        handler: async (req, res) => {
          if (!isSameOrigin(req)) return sendJson(res, 403, { error: 'cross-site request rejected' })
          if (!isLoopback(req)) return sendJson(res, 403, { error: '更新入口仅允许 loopback' })
          let body = ''
          for await (const chunk of req) body += String(chunk)
          let parsed: Record<string, unknown>
          try { parsed = JSON.parse(body) as Record<string, unknown> } catch { return sendJson(res, 400, { error: 'bad json body' }) }
          const skinId = typeof parsed.skinId === 'string' ? parsed.skinId : ''
          const entry = isValidSkinId(skinId) ? repository.get(skinId) : undefined
          if (entry === undefined || entry.source !== 'downloaded') return sendJson(res, 400, { error: '仅下载来源的皮肤支持更新' })
          const { downloadAndInstall, readProvenance } = await import('./workshop/install.ts')
          const provenance = await readProvenance(nodeFs(), entry.path)
          if (provenance === undefined) return sendJson(res, 400, { error: '缺少下载来源记录（remote.json）' })
          const versions = await makeWorkshopClient().versions(provenance.remoteId)
          const latest = versions[0]
          if (latest === undefined) return sendJson(res, 400, { error: '远端无可用版本' })
          if (latest.version === provenance.remoteVersion) return sendJson(res, 200, { ok: true, updated: false, version: latest.version })
          const result = await downloadAndInstall(
            nodeFs(),
            repository,
            roots.staging,
            () => makeWorkshopClient().download(provenance.remoteId, latest.version),
            { skinId: provenance.remoteId, version: latest.version },
            { replaceExisting: true },
          )
          if (!result.ok) return sendJson(res, 400, { ok: false, issues: result.issues })
          sendJson(res, 200, { ok: true, updated: true, from: provenance.remoteVersion, to: latest.version })
        },
      }))

      // v1.5 Generation API：记录创建（QUEUED）/ 列表 / 详情 / 取消（生命周期面；不触碰 Repository/Runtime）
      disposers.push(httpCtx.webServer.register({
        kind: 'exact',
        path: '/dsh-skin/api/generations',
        handler: async (req, res) => {
          if (!isSameOrigin(req)) return sendJson(res, 403, { error: 'cross-site request rejected' })
          if (req.method === 'GET') {
            const url = new URL(req.url ?? '/', 'http://dsh-skin.local')
            const skinId = url.searchParams.get('skinId') ?? undefined
            return sendJson(res, 200, { generations: await generationService.list(skinId) })
          }
          if (!isLoopback(req)) return sendJson(res, 403, { error: '创建生成仅允许 loopback' })
          let body = ''
          for await (const chunk of req) body += String(chunk)
          let parsed: Record<string, unknown>
          try { parsed = JSON.parse(body) as Record<string, unknown> } catch { return sendJson(res, 400, { error: 'bad json body' }) }
          const name = typeof parsed.name === 'string' ? parsed.name.trim() : ''
          if (name.length === 0) return sendJson(res, 400, { error: 'name 必填' })
          const decoded = typeof parsed.imageBase64 === 'string' && parsed.imageBase64.length > 0 ? readImageBase64(parsed.imageBase64) : { ok: true as const, bytes: new Uint8Array(0) }
          if (!decoded.ok) return sendJson(res, 400, { error: decoded.message })
          const created = await generationService.create({
            skinId: typeof parsed.id === 'string' && parsed.id.length > 0 ? parsed.id : slugifySkinId(name),
            name,
            description: typeof parsed.description === 'string' ? parsed.description : undefined,
            tags: Array.isArray(parsed.tags) ? parsed.tags.filter((t): t is string => typeof t === 'string') : undefined,
            category: typeof parsed.category === 'string' && parsed.category.length > 0 ? parsed.category : undefined,
            version: typeof parsed.version === 'string' && parsed.version.length > 0 ? parsed.version : undefined,
            imageBytes: decoded.bytes.length > 0 ? decoded.bytes : undefined,
            source: 'create',
          } satisfies CreateGenerationInput)
          if (!created.ok) return sendJson(res, 400, { ok: false, issues: created.issues, failureDomain: created.failureDomain })
          return sendJson(res, 200, { ok: true, generationId: created.record.generationId, skinId: created.record.skinId, status: 'QUEUED' })
        },
      }))

      disposers.push(httpCtx.webServer.register({
        kind: 'prefix',
        path: '/dsh-skin/api/generations',
        handler: async (req, res) => {
          if (!isSameOrigin(req)) return sendJson(res, 403, { error: 'cross-site request rejected' })
          const url = new URL(req.url ?? '/', 'http://dsh-skin.local')
          const parts = url.pathname.slice('/dsh-skin/api/generations'.length).split('/').filter(Boolean)
          const generationId = parts[0] ?? ''
          const record = generationId.length > 0 ? await generationService.get(generationId) : undefined
          if (record === undefined) return sendJson(res, 404, { error: 'generation not found', generationId })
          if (parts[1] === 'cancel' && req.method === 'POST') {
            if (!isLoopback(req)) return sendJson(res, 403, { error: '取消仅允许 loopback' })
            const cancelled = await generationService.cancel(generationId)
            if (!cancelled.ok) return sendJson(res, 400, { error: 'cancel failed', issues: cancelled.issues })
            return sendJson(res, 200, { ok: true, generationId, status: 'CANCELLED' })
          }
          if (parts[1] !== undefined) return sendJson(res, 404, { error: 'not found' })
          return sendJson(res, 200, record)
        },
      }))

      // v1.5 AI 生成入口（托管）：
      // - POST {generationId}：消费预先创建（QUEUED）的记录（两段式：先 /api/generations 创建，轮询进度，可取消）。
      // - 遗留一段式（无 generationId）：内联创建记录 + 运行（E2E 兼容），响应含 generationId。
      disposers.push(httpCtx.webServer.register({
        kind: 'exact',
        path: '/dsh-skin/api/generate',
        handler: async (req, res) => {
          if (!isSameOrigin(req)) return sendJson(res, 403, { error: 'cross-site request rejected' })
          if (!isLoopback(req)) return sendJson(res, 403, { error: '生成入口仅允许 loopback' })
          let body = ''
          for await (const chunk of req) body += String(chunk)
          let parsed: Record<string, unknown>
          try { parsed = JSON.parse(body) as Record<string, unknown> } catch { return sendJson(res, 400, { error: 'bad json body' }) }
          const maxIterations = typeof parsed.maxIterations === 'number' ? parsed.maxIterations : undefined
          const generationIdParam = typeof parsed.generationId === 'string' && parsed.generationId.length > 0 ? parsed.generationId : undefined
          if (generationIdParam !== undefined) {
            // 两段式：采纳 QUEUED 记录（图片已在 create 时落 pending 目录）
            const record = await generationService.get(generationIdParam)
            if (record === undefined) return sendJson(res, 404, { error: 'generation not found', generationId: generationIdParam })
            if (record.status !== 'QUEUED') return sendJson(res, 400, { error: 'generation not runnable', status: record.status })
            let imageBytes: Uint8Array
            try {
              imageBytes = await readPendingImage(generationIdParam)
            } catch {
              return sendJson(res, 400, { error: '生成记录缺少参考图（pending 输入缺失）' })
            }
            const outcome = await runGeneration({
              generationId: generationIdParam,
              skinId: record.skinId,
              name: record.name,
              description: record.description,
              tags: record.tags,
              imageBytes,
              version: record.packageVersion,
              replaceExisting: false,
              maxIterations,
            })
            return sendJson(res, outcome.status, outcome.body)
          }
          // 遗留一段式（无 generationId）：内联创建记录 + 运行
          const name = typeof parsed.name === 'string' ? parsed.name.trim() : ''
          if (name.length === 0) return sendJson(res, 400, { error: 'name 必填' })
          const imageBase64 = typeof parsed.imageBase64 === 'string' ? parsed.imageBase64 : ''
          const decoded = readImageBase64(imageBase64)
          if (!decoded.ok) return sendJson(res, 400, { error: decoded.message })
          const skinId = typeof parsed.id === 'string' && parsed.id.length > 0 ? parsed.id : slugifySkinId(name)
          const created = await generationService.create({
            skinId,
            name,
            description: typeof parsed.description === 'string' ? parsed.description : undefined,
            tags: Array.isArray(parsed.tags) ? parsed.tags.filter((t): t is string => typeof t === 'string') : undefined,
            category: typeof parsed.category === 'string' && parsed.category.length > 0 ? parsed.category : undefined,
            version: typeof parsed.version === 'string' ? parsed.version : undefined,
            imageBytes: decoded.bytes,
            source: 'create',
          } satisfies CreateGenerationInput)
          if (!created.ok) return sendJson(res, 400, { ok: false, issues: created.issues, failureDomain: created.failureDomain })
          const outcome = await runGeneration({
            generationId: created.record.generationId,
            skinId,
            name,
            description: typeof parsed.description === 'string' ? parsed.description : undefined,
            tags: Array.isArray(parsed.tags) ? parsed.tags.filter((t): t is string => typeof t === 'string') : undefined,
            author: typeof parsed.author === 'string' ? parsed.author : undefined,
            imageBytes: decoded.bytes,
            version: typeof parsed.version === 'string' ? parsed.version : undefined,
            replaceExisting: false,
            maxIterations,
          })
          return sendJson(res, outcome.status, outcome.body)
        },
      }))

      // v1.5 重新生成（托管）：同一 skinId + 版本 patch++ + 新 generationId（parent 链）；
      // 复用历史 best spec + 历史证据 + 原始参考图 → v1.4 闭环 → 原子 replace（旧版直到新包 commit 前受保护）。
      disposers.push(httpCtx.webServer.register({
        kind: 'exact',
        path: '/dsh-skin/api/regenerate',
        handler: async (req, res) => {
          if (!isSameOrigin(req)) return sendJson(res, 403, { error: 'cross-site request rejected' })
          if (!isLoopback(req)) return sendJson(res, 403, { error: '生成入口仅允许 loopback' })
          let body = ''
          for await (const chunk of req) body += String(chunk)
          let parsed: Record<string, unknown>
          try { parsed = JSON.parse(body) as Record<string, unknown> } catch { return sendJson(res, 400, { error: 'bad json body' }) }
          const skinId = typeof parsed.skinId === 'string' ? parsed.skinId : ''
          const entry = isValidSkinId(skinId) ? repository.get(skinId) : undefined
          if (entry === undefined) return sendJson(res, 404, { error: 'skin not found' })
          if (entry.source !== 'generated') return sendJson(res, 400, { error: '仅生成的皮肤支持重新生成' })
          const runDir = await latestRunDirFor(skinId)
          if (runDir === undefined) return sendJson(res, 404, { error: '未找到该皮肤的历史生成记录（generation 工作区）' })
          let imageBytes: Uint8Array
          let initialSpec: unknown
          let initialEvidence: VisionEvidence | undefined
          try {
            imageBytes = new Uint8Array(await nodeFs().readFile(join(runDir, 'input.png')))
            initialSpec = await readRunSpec(runDir)
            try { initialEvidence = JSON.parse(await nodeFs().readText(join(runDir, 'evidence.json'))) as VisionEvidence } catch { initialEvidence = undefined }
          } catch (error) {
            return sendJson(res, 500, { error: '读取历史生成记录失败', detail: String((error as Error).message) })
          }
          const parent = await generationService.latestCompleted(skinId)
          const version = bumpPatchVersion(entry.version)
          const created = await generationService.create({
            skinId,
            name: entry.name,
            description: entry.description,
            tags: entry.tags,
            version,
            imageBytes,
            source: 'regenerate',
            parentGenerationId: parent?.generationId,
          } satisfies CreateGenerationInput)
          if (!created.ok) return sendJson(res, 400, { ok: false, issues: created.issues, failureDomain: created.failureDomain })
          const outcome = await runGeneration({
            generationId: created.record.generationId,
            skinId,
            name: entry.name,
            author: entry.author,
            description: entry.description,
            tags: entry.tags,
            imageBytes,
            initialSpec,
            initialEvidence,
            version,
            replaceExisting: true,
            maxIterations: typeof parsed.maxIterations === 'number' ? parsed.maxIterations : undefined,
          })
          return sendJson(res, outcome.status, outcome.body)
        },
      }))

      disposers.push(httpCtx.webServer.register({
        kind: 'exact',
        path: '/dsh-skin/api/install',
        handler: async (req, res) => {
          if (!isSameOrigin(req)) return sendJson(res, 403, { error: 'cross-site request rejected' })
          let body = ''
          for await (const chunk of req) body += String(chunk)
          let sourceDir = ''
          try { sourceDir = String(JSON.parse(body).sourceDir ?? '') } catch { return sendJson(res, 400, { error: 'bad json body' }) }
          if (sourceDir.length === 0) return sendJson(res, 400, { error: 'sourceDir required' })
          const result = await repository.install(sourceDir)
          if (!result.ok) return sendJson(res, 400, { error: 'install failed', issues: result.issues })
          sendJson(res, 200, { ok: true })
        },
      }))

      disposers.push(httpCtx.webServer.register({
        kind: 'exact',
        path: '/dsh-skin/api/remove',
        handler: async (req, res) => {
          if (!isSameOrigin(req)) return sendJson(res, 403, { error: 'cross-site request rejected' })
          let body = ''
          for await (const chunk of req) body += String(chunk)
          let id = ''
          try { id = String(JSON.parse(body).id ?? '') } catch { return sendJson(res, 400, { error: 'bad json body' }) }
          if (!isValidSkinId(id)) return sendJson(res, 400, { error: 'invalid skin id' })
          const result = await repository.remove(id)
          if (!result.ok) return sendJson(res, 400, { error: 'remove failed', issues: result.issues })
          sendJson(res, 200, { ok: true })
        },
      }))

      disposers.push(httpCtx.webServer.register({
        kind: 'prefix',
        path: '/dsh-skin/skins',
        handler: async (req, res) => {
          const url = new URL(req.url ?? '/', 'http://dsh-skin.local')
          const rest = url.pathname.slice('/dsh-skin/skins'.length)
          const parts = rest.split('/').filter(Boolean)
          const id = parts[0] ?? ''
          const marker = parts[1] ?? ''
          const rel = parts.slice(2).join('/')
          if (!isValidSkinId(id) || marker !== 'files' || rel.length === 0) {
            return sendJson(res, 404, { error: 'not found' })
          }
          const ref = await repository.fileRef(id, rel)
          if (ref === undefined) return sendJson(res, 404, { error: 'file not found or blocked' })
          let data: Uint8Array
          try {
            data = await fsp.readFile(ref.abs)
          } catch {
            return sendJson(res, 404, { error: 'file not found' })
          }
          res.writeHead(200, {
            'Content-Type': contentTypeOf(rel),
            'Cache-Control': 'no-cache',
            'X-Content-Type-Options': 'nosniff',
          })
          res.end(Buffer.from(data))
        },
      }))

      return () => {
        for (const dispose of disposers.reverse()) dispose()
      }
    }, 'dsh-skin: http routes')
  })
}

export { resolveInside }
