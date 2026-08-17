/**
 * Skin Center（Phase 2）：Gallery（预览/搜索/标签/来源/排序）→ Detail（大图预览/元信息/操作）。
 * 只经 SkinRuntime 服务与 host API 操作；不直接触碰 registry / settings 文件 / loader。
 * @module dsh-skin/src/client/ui/skin-card
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { SkinController, WorkshopRemoteSkin } from '../controller/controller.ts'
import type { AIGenerationController, GenerationInfo } from '../controller/generation-controller.ts'
import { collectTags, filterAndSort, formatUpdated, type GalleryFilter, type GallerySort } from '../center/selectors.ts'

export interface SkinCardFace {
  controller: SkinController
  generationController?: AIGenerationController
}

const panelStyle: Record<string, string | number> = {
  display: 'flex', flexDirection: 'column', gap: 10, width: '100%',
}

const gridStyle: Record<string, string | number> = {
  display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10,
}

const cardStyle: Record<string, string | number> = {
  display: 'flex', flexDirection: 'column', gap: 6, padding: 8,
  borderRadius: 8, cursor: 'pointer',
  border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.35))',
  background: 'var(--dsw-alias-bg-layer-1, rgba(255,255,255,0.04))',
}

const detailStyle: Record<string, string | number> = {
  display: 'flex', flexDirection: 'column', gap: 8, padding: 10,
  borderRadius: 8, border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.6))',
  background: 'var(--dsw-alias-bg-layer-1, rgba(255,255,255,0.04))',
}

const tagStyle: Record<string, string | number> = {
  display: 'inline-block', marginRight: 6, padding: '1px 6px', fontSize: 11,
  borderRadius: 999, background: 'rgba(128,128,128,0.18)', color: 'var(--dsw-alias-label-secondary, inherit)',
}

const buttonStyle: Record<string, string | number> = {
  marginRight: 8, padding: '3px 10px', fontSize: 12, borderRadius: 6,
  border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.6))',
  background: 'transparent', cursor: 'pointer',
  color: 'var(--dsw-alias-label-primary, inherit)',
}

const inputStyle: Record<string, string | number> = {
  padding: '4px 8px', fontSize: 12, borderRadius: 6,
  border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.6))',
  background: 'var(--dsw-alias-bg-layer-1, rgba(255,255,255,0.04))',
  color: 'var(--dsw-alias-label-primary, inherit)',
}

function previewUrl(skinId: string, rel: string | undefined): string | undefined {
  if (rel === undefined || rel.length === 0) return undefined
  return '/dsh-skin/skins/' + skinId + '/files/' + rel
}

export function SkinSettingsCard(props: SkinCardFace): React.JSX.Element {
  const { controller, generationController } = props
  const [snapshot, setSnapshot] = useState(() => controller.getSnapshot())
  const [query, setQuery] = useState('')
  const [tags, setTags] = useState<string[]>([])
  const [sources, setSources] = useState<Array<'builtin' | 'installed' | 'generated'>>([])
  const [sort, setSort] = useState<GallerySort>('name')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [previewMode, setPreviewMode] = useState<'light' | 'dark'>('light')

  useEffect(() => controller.subscribe(() => setSnapshot(controller.getSnapshot())), [controller])
  useEffect(() => { void controller.list() }, [controller])

  const allTags = useMemo(() => collectTags(snapshot.skins), [snapshot.skins])
  const filter: GalleryFilter = { query, tags, sources, sort }
  const entries = useMemo(() => filterAndSort(snapshot.skins, filter), [snapshot.skins, query, tags, sources, sort])
  const selected = snapshot.skins.find(skin => skin.id === selectedId) ?? null
  const busy = snapshot.status === 'loading'

  const [genFile, setGenFile] = useState<File | null>(null)
  const [genName, setGenName] = useState('')
  const [genDescription, setGenDescription] = useState('')
  const [genTags, setGenTags] = useState('')
  const [genResult, setGenResult] = useState<string | null>(null)
  const [generating, setGenerating] = useState(false)
  const [editOpen, setEditOpen] = useState(false)
  const [editName, setEditName] = useState('')
  const [editAuthor, setEditAuthor] = useState('')
  const [editDescription, setEditDescription] = useState('')
  const [editTags, setEditTags] = useState('')
  const [lifecycleResult, setLifecycleResult] = useState<string | null>(null)
  const [genStatus, setGenStatus] = useState<string | null>(null)
  const genTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const [editDesignOpen, setEditDesignOpen] = useState(false)
  const [editDesignJson, setEditDesignJson] = useState('')
  const [generations, setGenerations] = useState<GenerationInfo[]>([])
  const [aiRecords, setAiRecords] = useState<Map<string, GenerationInfo[]>>(new Map())
  const [wsSearch, setWsSearch] = useState('')
  const [wsSkins, setWsSkins] = useState<WorkshopRemoteSkin[]>([])
  const [wsStatus, setWsStatus] = useState<string | null>(null)
  const [wsBusy, setWsBusy] = useState(false)

  /** 生命周期操作统一入口：成功静默，失败写入生命周期结果（不再产生未处理 rejection）。 */
  const runAction = async (label: string, action: () => Promise<unknown>): Promise<void> => {
    setLifecycleResult(null)
    try {
      await action()
    } catch (error) {
      setLifecycleResult(label + '失败：' + controller.describeError(error))
    }
  }

  const browseWorkshop = async (): Promise<void> => {
    setWsBusy(true)
    try {
      const payload = (await controller.browseWorkshop(wsSearch)).payload as { configured?: boolean; offline?: boolean; error?: string; skins?: unknown[] }
      if (payload.offline === true || payload.configured === false || payload.skins === undefined) {
        setWsSkins([])
        setWsStatus(payload.offline === true ? '离线/不可达：' + (payload.error ?? '未配置远端地址') : 'Workshop 未配置（可在设置里配置远端地址）')
      } else {
        setWsSkins((payload.skins ?? []) as never)
        setWsStatus(null)
      }
    } catch (error) {
      setWsSkins([])
      setWsStatus('浏览失败：' + String((error as Error).message))
    } finally {
      setWsBusy(false)
    }
  }

  useEffect(() => { void browseWorkshop() }, [])
  useEffect(() => {
    // v1.5 AI 记录投影：全部生成记录按 skinId 聚合（含未安装/已卸载——reinstall 入口）
    if (generationController === undefined) return
    void generationController.list().then(records => {
      const bySkin = new Map<string, GenerationInfo[]>()
      for (const record of records) {
        const list = bySkin.get(record.skinId) ?? []
        list.push(record)
        bySkin.set(record.skinId, list)
      }
      setAiRecords(bySkin)
    }).catch(() => undefined)
  }, [generationController, snapshot.skins])

  const publishLocal = async (skinId: string, mode: 'new' | 'version'): Promise<void> => {
    setWsBusy(true)
    try {
      const { ok, status, payload } = await controller.publish(skinId, mode)
      const p = payload as { ok?: boolean; issues?: string[]; version?: string }
      setLifecycleResult(ok && p.ok === true
        ? '已发布：' + skinId + ' v' + p.version + '（本地皮肤未改动）'
        : '发布失败：' + (p.issues ?? ['HTTP ' + status]).join('；'))
    } catch (error) {
      setLifecycleResult('发布失败：' + String((error as Error).message))
    } finally {
      setWsBusy(false)
    }
  }

  const reportRemote = async (skinId: string): Promise<void> => {
    setWsBusy(true)
    try {
      const { ok, status, payload } = await controller.report(skinId)
      const p = payload as { ok?: boolean; reported?: boolean; error?: string }
      setWsStatus(ok && p.ok === true && p.reported === true ? '已举报：' + skinId : '举报失败：' + (p.error ?? 'HTTP ' + status))
    } catch (error) {
      setWsStatus('举报失败：' + String((error as Error).message))
    } finally {
      setWsBusy(false)
    }
  }

  const workshopAction = async (action: 'download' | 'update', skinId: string): Promise<void> => {
    setWsBusy(true)
    try {
      const { ok, status, payload } = await controller.workshopAction(action, skinId)
      const p = payload as { ok?: boolean; issues?: string[]; updated?: boolean; from?: string; to?: string }
      if (ok && p.ok === true) {
        setWsStatus(action === 'update' ? (p.updated === true ? '已更新 ' + skinId + ' ' + p.from + ' → ' + p.to : skinId + ' 已是最新') : '已下载安装：' + skinId)
        await controller.list()
      } else {
        setWsStatus('操作失败：' + (p.issues ?? ['HTTP ' + status]).join('；'))
      }
    } catch (error) {
      setWsStatus('操作失败：' + String((error as Error).message))
    } finally {
      setWsBusy(false)
    }
  }

  useEffect(() => {
    // 选择变化时重置编辑态
    setEditOpen(false)
    setEditDesignOpen(false)
    setLifecycleResult(null)
    if (selectedId !== null && generationController !== undefined) {
      void generationController.list(selectedId).then(setGenerations).catch(() => setGenerations([]))
    } else {
      setGenerations([])
    }
  }, [selectedId, generationController])

  const openEdit = (): void => {
    if (selected === null) return
    setEditName(selected.name)
    setEditAuthor(selected.author)
    setEditDescription(selected.description)
    setEditTags(selected.tags.join(', '))
    setEditOpen(true)
  }

  const saveEdit = async (): Promise<void> => {
    if (selected === null) return
    try {
      const { ok, status, payload } = await controller.saveMeta(selected.id, {
        name: editName,
        author: editAuthor,
        description: editDescription,
        tags: editTags.split(',').map(tag => tag.trim()).filter(tag => tag.length > 0),
      })
      const p = payload as { ok?: boolean; error?: string; issues?: string[] }
      if (ok && p.ok === true) {
        setLifecycleResult('已保存 metadata（integrity 已重算）')
        setEditOpen(false)
        await controller.list()
      } else {
        setLifecycleResult('保存失败：' + (p.issues?.join('；') ?? p.error ?? 'HTTP ' + status))
      }
    } catch (error) {
      setLifecycleResult('保存失败：' + String((error as Error).message))
    }
  }

  const regenerate = async (): Promise<void> => {
    if (selected === null || generating) return
    setGenerating(true)
    setLifecycleResult('重新生成中…')
    try {
      const { ok, status, payload } = await controller.regenerate(selected.id)
      const p = payload as { ok?: boolean; issues?: string[]; iterations?: Array<{ index: number; diffRatio: number }> }
      if (ok && p.ok === true) {
        const iterText = (p.iterations ?? []).map(iteration => 'iter' + iteration.index + ' diff=' + iteration.diffRatio.toFixed(3)).join('；')
        setLifecycleResult('已重新生成并覆盖安装（' + iterText + '）')
        await controller.list()
      } else {
        setLifecycleResult('重新生成失败：' + (p.issues ?? ['HTTP ' + status]).join('；'))
      }
    } catch (error) {
      setLifecycleResult('重新生成失败：' + String((error as Error).message))
    } finally {
      setGenerating(false)
    }
  }

  const runGenerate = async (): Promise<void> => {
    if (genFile === null || genName.trim().length === 0 || generating || generationController === undefined) return
    setGenerating(true)
    setGenResult('创建生成任务…')
    setGenStatus(null)
    try {
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
        reader.onerror = () => reject(new Error('读取图片失败'))
        reader.readAsDataURL(genFile)
      })
      // 两段式：先创建 GenerationRecord（QUEUED），再运行（可轮询/可取消）
      const created = await generationController.createGeneration({
        name: genName,
        description: genDescription,
        tags: genTags.split(',').map(tag => tag.trim()).filter(tag => tag.length > 0),
        imageBase64: base64,
      })
      const createdPayload = created.payload as { ok?: boolean; generationId?: string; issues?: string[] }
      if (!created.ok || createdPayload.ok !== true || createdPayload.generationId === undefined) {
        setGenResult('创建生成任务失败：' + ((createdPayload.issues ?? []).join('；') || 'HTTP ' + created.status))
        return
      }
      const generationId = createdPayload.generationId
      const timer = setInterval(() => {
        void (async () => {
          const record = await generationController.get(generationId)
          if (record === null) return
          setGenStatus('状态：' + record.stage + (record.failureDomain !== undefined ? '（' + record.failureDomain + '）' : ''))
          if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(record.status) && genTimerRef.current !== null) {
            clearInterval(genTimerRef.current)
            genTimerRef.current = null
          }
        })()
      }, 1200)
      genTimerRef.current = timer
      setGenResult('生成中（任务 ' + generationId + '）…')
      const { ok, status, payload } = await generationController.run(generationId)
      if (genTimerRef.current !== null) {
        clearInterval(genTimerRef.current)
        genTimerRef.current = null
      }
      const p = payload as { ok?: boolean; issues?: string[]; skinId?: string; failureDomain?: string; status?: string; iterations?: Array<{ index: number; diffRatio: number; converged: boolean }> }
      if (p.status === 'CANCELLED' || p.failureDomain === 'CANCELLED') {
        setGenResult('已取消（上一版本不受影响）')
        setGenStatus('状态：CANCELLED')
        return
      }
      if (ok && p.ok === true) {
        const iterText = (p.iterations ?? []).map(iteration => 'iter' + iteration.index + ' diff=' + iteration.diffRatio.toFixed(3) + (iteration.converged ? ' ✓' : '')).join('；')
        setGenResult('已生成并安装：' + p.skinId + '（' + iterText + '）')
        setGenStatus(null)
        await controller.list()
      } else {
        setGenResult('生成失败：' + (p.issues ?? ['HTTP ' + status]).join('；'))
        setGenStatus('状态：' + (p.status ?? 'FAILED') + (p.failureDomain !== undefined ? '（' + p.failureDomain + '）' : ''))
      }
    } catch (error) {
      setGenResult('生成失败：' + String((error as Error).message))
    } finally {
      setGenerating(false)
    }
  }

  const cancelGeneration = async (): Promise<void> => {
    if (generationController === undefined || genTimerRef.current === null) return
    // generationId 从 genResult 文本反查不可靠；以记录列表最近一条 QUEUED/RUNNING 匹配取消
    try {
      const records = await generationController.list()
      const running = records.find(record => ['QUEUED', 'ANALYZING', 'SPEC_GENERATED', 'BUILDING', 'RENDERING', 'REPAIRING', 'VALIDATING'].includes(record.status))
      if (running === undefined) { setGenResult('没有进行中的生成可取消'); return }
      await generationController.cancel(running.generationId)
      setGenStatus('状态：CANCELLING…')
    } catch (error) {
      setGenResult('取消失败：' + String((error as Error).message))
    }
  }

  const toggleTag = (tag: string): void => {
    setTags(current => current.includes(tag) ? current.filter(t => t !== tag) : [...current, tag])
  }
  const toggleSource = (source: 'builtin' | 'installed' | 'generated'): void => {
    setSources(current => current.includes(source) ? current.filter(s => s !== source) : [...current, source])
  }

  return (
    <div style={panelStyle}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <div style={{ fontSize: 14, fontWeight: 600 }}>Skins</div>
        <div style={{ fontSize: 11, opacity: 0.7 }}>{snapshot.skins.length} 个皮肤</div>
        {snapshot.activeId !== null && <span style={{ fontSize: 11, color: 'var(--dsw-alias-state-success-primary, #27ae60)' }}>● 激活：{snapshot.activeId}</span>}
        {snapshot.tryOnId !== null && <span style={{ fontSize: 11 }}>◐ 试穿：{snapshot.tryOnId}</span>}
      </div>

      {busy && <span data-testid="dsh-skin-loading" style={{ fontSize: 11, opacity: 0.7 }}>加载中…</span>}
      {snapshot.error !== null && <div data-testid="dsh-skin-list-error" style={{ color: 'var(--dsw-alias-state-error-primary, #c0392b)', fontSize: 12 }}>{snapshot.error}</div>}

      {/* 工具栏：搜索 / 来源 / 排序 */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          data-testid="dsh-skin-search"
          style={inputStyle}
          placeholder="搜索名称 / ID / 作者 / 描述"
          value={query}
          onChange={event => { setQuery(event.target.value) }}
        />
        <button
          data-testid="dsh-skin-source-builtin"
          style={{ ...buttonStyle, ...(sources.includes('builtin') ? { borderColor: 'var(--dsw-alias-brand-primary, #4d6bfe)' } : {}) }}
          onClick={() => { toggleSource('builtin') }}
        >内置</button>
        <button
          data-testid="dsh-skin-source-installed"
          style={{ ...buttonStyle, ...(sources.includes('installed') ? { borderColor: 'var(--dsw-alias-brand-primary, #4d6bfe)' } : {}) }}
          onClick={() => { toggleSource('installed') }}
        >本地</button>
        <button
          data-testid="dsh-skin-source-generated"
          style={{ ...buttonStyle, ...(sources.includes('generated') ? { borderColor: 'var(--dsw-alias-brand-primary, #4d6bfe)' } : {}) }}
          onClick={() => { toggleSource('generated') }}
        >AI 生成</button>
        <select
          data-testid="dsh-skin-sort"
          style={inputStyle}
          value={sort}
          onChange={event => { setSort(event.target.value as GallerySort) }}
        >
          <option value="name">按名称</option>
          <option value="id">按 ID</option>
          <option value="version">按版本</option>
          <option value="updated">按更新时间</option>
        </select>
        <button data-testid="dsh-skin-refresh" style={buttonStyle} disabled={busy} onClick={() => { void controller.list() }}>刷新</button>
      </div>

      {/* 创建皮肤（从图片生成，Phase 3；无 vision-router 时接口显式报缺） */}
      <div data-testid="dsh-skin-generator" style={detailStyle}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>创建皮肤（从图片生成）</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <input data-testid="dsh-skin-gen-file" type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={event => { setGenFile(event.target.files?.[0] ?? null) }} />
          <input data-testid="dsh-skin-gen-name" style={inputStyle} placeholder="皮肤名称（必填）" value={genName} onChange={event => { setGenName(event.target.value) }} />
          <input data-testid="dsh-skin-gen-description" style={{ ...inputStyle, flex: 1, minWidth: 160 }} placeholder="描述（可选）" value={genDescription} onChange={event => { setGenDescription(event.target.value) }} />
          <input data-testid="dsh-skin-gen-tags" style={{ ...inputStyle, width: 140 }} placeholder="标签，逗号分隔" value={genTags} onChange={event => { setGenTags(event.target.value) }} />
          <button data-testid="dsh-skin-gen-submit" style={buttonStyle} disabled={generating || genFile === null || genName.trim().length === 0} onClick={() => { void runGenerate() }}>生成</button>
          {generating && <button data-testid="dsh-skin-gen-cancel" style={buttonStyle} onClick={() => { void cancelGeneration() }}>取消</button>}
        </div>
        {genStatus !== null && <div data-testid="dsh-skin-gen-status" style={{ fontSize: 11, opacity: 0.85 }}>{genStatus}</div>}
        {genResult !== null && <div data-testid="dsh-skin-gen-result" style={{ fontSize: 11, opacity: 0.9 }}>{genResult}</div>}
      </div>

      {/* 在线皮肤（Workshop，Phase 5）：浏览/搜索/下载/更新；离线时本地皮肤不受影响 */}
      <div data-testid="dsh-skin-workshop" style={detailStyle}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>在线皮肤</div>
          <input
            data-testid="dsh-skin-workshop-search"
            style={inputStyle}
            placeholder="搜索在线皮肤"
            value={wsSearch}
            onChange={event => { setWsSearch(event.target.value) }}
            onKeyDown={event => { if (event.key === 'Enter') void browseWorkshop() }}
          />
          <button data-testid="dsh-skin-workshop-refresh" style={buttonStyle} disabled={wsBusy} onClick={() => { void browseWorkshop() }}>刷新</button>
        </div>
        {wsStatus !== null && <div data-testid="dsh-skin-workshop-status" style={{ fontSize: 11, opacity: 0.9 }}>{wsStatus}</div>}
        {wsSkins.map(remote => {
          const local = snapshot.skins.find(skin => skin.id === remote.skinId)
          const localVersion = local?.source === 'downloaded' ? local.version : null
          const hasUpdate = localVersion !== null && localVersion !== remote.version
          return (
            <div key={remote.skinId} data-testid={'dsh-skin-workshop-item-' + remote.skinId} style={{ ...cardStyle, cursor: 'default' }}>
              <div style={{ display: 'flex', gap: 6, alignItems: 'baseline', flexWrap: 'wrap' }}>
                <b style={{ fontSize: 13 }}>{remote.name}</b>
                <code style={{ fontSize: 10, opacity: 0.8 }}>{remote.skinId}</code>
                <span style={{ fontSize: 10, opacity: 0.7 }}>{remote.author} · v{remote.version} · ↓{remote.downloadCount} · ★{remote.rating}</span>
              </div>
              <div style={{ fontSize: 11, opacity: 0.85 }}>{remote.description}</div>
              <div>{remote.tags.map(tag => <span key={tag} style={tagStyle}>{tag}</span>)}</div>
              <div>
                {localVersion === null
                  ? <button data-testid={'dsh-skin-workshop-download-' + remote.skinId} style={buttonStyle} disabled={wsBusy} onClick={() => { void workshopAction('download', remote.skinId) }}>下载并安装</button>
                  : hasUpdate
                    ? <button data-testid={'dsh-skin-workshop-update-' + remote.skinId} style={buttonStyle} disabled={wsBusy} onClick={() => { void workshopAction('update', remote.skinId) }}>更新（{localVersion} → {remote.version}）</button>
                    : <span style={{ fontSize: 11, opacity: 0.8 }}>已安装（v{localVersion}）</span>}
                <button data-testid={'dsh-skin-workshop-report-' + remote.skinId} style={buttonStyle} disabled={wsBusy} onClick={() => { void reportRemote(remote.skinId) }}>举报</button>
              </div>
            </div>
          )
        })}
        {wsSkins.length === 0 && wsStatus === null && <div style={{ fontSize: 11, opacity: 0.7 }}>没有在线皮肤（配置远端地址后点刷新）。</div>}
      </div>

      {/* v1.5 My AI Skins：生成记录投影（含未安装 → 重新安装） */}
      {generationController !== undefined && aiRecords.size > 0 && (
        <div data-testid="dsh-skin-ai-records" style={detailStyle}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>My AI Skins（生成记录）</div>
          {[...aiRecords.entries()].map(([skinId, records]) => {
            const sorted = [...records].sort((a, b) => a.startedAt.localeCompare(b.startedAt))
            const latest = sorted[sorted.length - 1]
            const installed = snapshot.skins.some(skin => skin.id === skinId)
            const completed = sorted.some(record => record.status === 'COMPLETED')
            return (
              <div key={skinId} data-testid={'dsh-skin-ai-record-' + skinId} style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                <b style={{ fontSize: 12 }}>{latest.name}</b>
                <code style={{ fontSize: 10, opacity: 0.8 }}>{skinId}</code>
                <span style={{ fontSize: 10, opacity: 0.75 }}>v{latest.packageVersion} · {records.length} 代 · 最近 {latest.status}{latest.failureDomain !== undefined ? '（' + latest.failureDomain + '）' : ''}</span>
                {!installed && completed && (
                  <button
                    data-testid={'dsh-skin-ai-reinstall-' + skinId}
                    style={buttonStyle}
                    onClick={() => { void (async () => {
                      const result = await generationController.reinstall(skinId)
                      const p = result.payload as { ok?: boolean; issues?: string[]; version?: string }
                      setLifecycleResult(result.ok && p.ok === true ? '已重新安装：' + skinId + ' v' + p.version + '（未调用模型）' : '重新安装失败：' + (p.issues ?? ['HTTP ' + result.status]).join('；'))
                      await controller.list()
                    })() }}
                  >重新安装</button>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* 标签筛选条 */}
      {allTags.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {allTags.map(tag => (
            <button
              key={tag}
              data-testid={'dsh-skin-tag-' + tag}
              style={{ ...buttonStyle, marginRight: 0, padding: '1px 8px', ...(tags.includes(tag) ? { background: 'var(--dsw-alias-brand-primary, #4d6bfe)', color: '#fff' } : {}) }}
              onClick={() => { toggleTag(tag) }}
            >{tag}</button>
          ))}
        </div>
      )}

      {/* Gallery */}
      {entries.length === 0 && (
        <div data-testid="dsh-skin-empty" style={{ fontSize: 12, opacity: 0.7 }}>
          {snapshot.skins.length === 0 ? (snapshot.status === 'error' ? '皮肤列表不可用：' + (snapshot.error ?? '未知错误') : '暂无皮肤。') : '没有匹配的皮肤。'}
        </div>
      )}
      <div style={gridStyle}>
        {entries.map(skin => (
          <div
            key={skin.id}
            data-testid={'dsh-skin-card-' + skin.id}
            style={{ ...cardStyle, ...(selectedId === skin.id ? { borderColor: 'var(--dsw-alias-brand-primary, #4d6bfe)' } : {}) }}
            onClick={() => { setSelectedId(skin.id) }}
          >
            {previewUrl(skin.id, skin.preview.light) !== undefined
              ? <img src={previewUrl(skin.id, skin.preview.light)} alt={skin.name} style={{ width: '100%', aspectRatio: '16/9', objectFit: 'cover', borderRadius: 6, background: 'rgba(0,0,0,0.3)' }} />
              : <div style={{ width: '100%', aspectRatio: '16/9', borderRadius: 6, background: 'rgba(128,128,128,0.2)' }} />}
            <div style={{ display: 'flex', gap: 6, alignItems: 'baseline', flexWrap: 'wrap' }}>
              <b style={{ fontSize: 13 }}>{skin.name}</b>
              <code style={{ fontSize: 10, opacity: 0.8 }}>{skin.id}</code>
              <span style={{ fontSize: 10, opacity: 0.7 }}>{skin.source} · {skin.author} · v{skin.version}</span>
            </div>
            <div style={{ fontSize: 11, opacity: 0.85, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{skin.description}</div>
            <div>
              {skin.tags.map(tag => <span key={tag} style={tagStyle}>{tag}</span>)}
              {snapshot.activeId === skin.id && snapshot.tryOnId === null && <span style={{ fontSize: 10, color: 'var(--dsw-alias-state-success-primary, #27ae60)' }}>● active</span>}
              {snapshot.tryOnId === skin.id && <span style={{ fontSize: 10 }}>◐ try-on</span>}
              {skin.state !== 'ok' && <span style={{ fontSize: 10, color: 'var(--dsw-alias-state-error-primary, #c0392b)' }}>⚠ {skin.state}</span>}
              {skin.trust === 'untrusted' && <span data-testid={'dsh-skin-trust-' + skin.id} style={{ fontSize: 10, color: 'var(--dsw-alias-state-warn-primary, #d99a2b)' }}>⚠ untrusted</span>}
            </div>
          </div>
        ))}
      </div>

      {/* Detail */}
      {selected !== null && (
        <div data-testid={'dsh-skin-detail-' + selected.id} style={detailStyle}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
            <b style={{ fontSize: 14 }}>{selected.name}</b>
            <code style={{ fontSize: 11, opacity: 0.8 }}>{selected.id}</code>
            <span style={{ fontSize: 11, opacity: 0.7 }}>{selected.source} · v{selected.version} · {selected.author}</span>
            <span style={{ fontSize: 11, opacity: 0.7 }}>更新 {formatUpdated(selected.updatedAtMs)}</span>
            <span style={{ fontSize: 11, opacity: 0.7 }}>skinApi {selected.skinApiVersion}</span>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
            {(() => {
              const light = previewUrl(selected.id, selected.preview.light)
              const dark = previewUrl(selected.id, selected.preview.dark)
              const src = previewMode === 'dark' && dark !== undefined ? dark : light
              return src !== undefined
                ? <img src={src} alt={selected.name} style={{ width: 320, maxWidth: '100%', aspectRatio: '16/9', objectFit: 'cover', borderRadius: 8, background: 'rgba(0,0,0,0.3)' }} />
                : null
            })()}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1, minWidth: 200 }}>
              <div style={{ fontSize: 12, opacity: 0.9 }}>{selected.description}</div>
              <div>{selected.tags.map(tag => <span key={tag} style={tagStyle}>{tag}</span>)}</div>
              {selected.issues.length > 0 && <div style={{ fontSize: 11, color: 'var(--dsw-alias-state-error-primary, #c0392b)' }}>{selected.issues.join('；')}</div>}
            </div>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center' }}>
            {selected.preview.dark !== undefined && (
              <button style={buttonStyle} onClick={() => { setPreviewMode(mode => mode === 'light' ? 'dark' : 'light') }}>{previewMode === 'light' ? '暗色预览' : '亮色预览'}</button>
            )}
            <button data-testid={'dsh-skin-action-' + selected.id + '-tryon'} style={buttonStyle} disabled={busy || selected.state !== 'ok'} onClick={() => { void runAction('试穿', async () => { await controller.enter(selected.id) }) }}>Try On</button>
            <button data-testid={'dsh-skin-action-' + selected.id + '-apply'} style={buttonStyle} disabled={busy || selected.state !== 'ok'} onClick={() => { void runAction('应用', async () => { await controller.apply(selected.id) }) }}>Apply</button>
            {snapshot.tryOnId !== null && <button data-testid="dsh-skin-action-exit-tryon" style={buttonStyle} onClick={() => { void runAction('退出试穿', async () => { await controller.exit() }) }}>Exit Try-on</button>}
            {snapshot.activeId !== null && <button data-testid="dsh-skin-action-restore-default" style={buttonStyle} disabled={busy} onClick={() => { void runAction('恢复默认', async () => { await controller.restore() }) }}>Restore Default</button>}
            {(selected.source === 'installed' || selected.source === 'generated' || selected.source === 'downloaded') && <button data-testid={'dsh-skin-action-' + selected.id + '-uninstall'} style={buttonStyle} disabled={busy} onClick={() => { void runAction('卸载', async () => { await controller.removeSkin(selected.id) }) }}>卸载</button>}
          </div>
          {/* v1.5 AI Skin 生命周期：设计编辑 / 重新安装 / 生成历史（仅 generated） */}
          {selected.source === 'generated' && generationController !== undefined && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, borderTop: '1px dashed var(--dsw-alias-border-l1, rgba(128,128,128,0.3))', paddingTop: 8 }}>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                {!editDesignOpen && <button data-testid="dsh-skin-edit-design-open" style={buttonStyle} onClick={() => { setEditDesignJson('{\n  "targetRegions": ["global"],\n  "problemAssessment": "…",\n  "specChanges": [{\n    "path": "colorPalette[0].hex",\n    "newValue": "#123456",\n    "reason": "…",\n    "targetRegion": "global",\n    "expectedEffect": "…"\n  }]\n}'); setEditDesignOpen(true) }}>编辑设计</button>}
                <button data-testid={'dsh-skin-action-' + selected.id + '-reinstall'} style={buttonStyle} onClick={() => { void (async () => { if (generationController === undefined) return; const result = await generationController.reinstall(selected.id); const p = result.payload as { ok?: boolean; issues?: string[]; version?: string }; setLifecycleResult(result.ok && p.ok === true ? '已重新安装（v' + p.version + '，未调用模型）' : '重新安装失败：' + (p.issues ?? ['HTTP ' + result.status]).join('；')); await controller.list() })() }}>重新安装</button>
              </div>
              {editDesignOpen && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <textarea
                    data-testid="dsh-skin-edit-design-json"
                    style={{ ...inputStyle, minHeight: 120, fontFamily: 'monospace', width: '100%' }}
                    value={editDesignJson}
                    onChange={event => { setEditDesignJson(event.target.value) }}
                  />
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button data-testid="dsh-skin-edit-design-save" style={buttonStyle} onClick={() => { void (async () => {
                      if (generationController === undefined) return
                      let decision: unknown
                      try { decision = JSON.parse(editDesignJson) } catch { setLifecycleResult('设计编辑失败：决策 JSON 非法'); return }
                      setLifecycleResult('设计编辑生成中…')
                      const result = await generationController.specEdit(selected.id, decision)
                      const p = result.payload as { ok?: boolean; issues?: string[]; skinId?: string; generationId?: string; failureDomain?: string; iterations?: Array<{ index: number; status: string }> }
                      if (result.ok && p.ok === true) {
                        setLifecycleResult('设计已应用并生成新版本（' + p.generationId + '；' + (p.iterations ?? []).map(i => 'iter' + i.index + ':' + i.status).join('；') + '）')
                        await controller.list()
                      } else {
                        setLifecycleResult('设计编辑失败：' + (p.issues ?? ['HTTP ' + result.status]).join('；'))
                      }
                      setEditDesignOpen(false)
                    })() }}>应用并生成新版本</button>
                    <button style={buttonStyle} onClick={() => { setEditDesignOpen(false) }}>取消</button>
                  </div>
                </div>
              )}
              {generations.length > 0 && (
                <div data-testid={'dsh-skin-generations-' + selected.id} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <div style={{ fontSize: 12, fontWeight: 600 }}>生成历史（{generations.length}）</div>
                  {generations.map(generation => (
                    <div key={generation.generationId} data-testid={'dsh-skin-generation-' + generation.generationId} style={{ fontSize: 11, opacity: 0.85 }}>
                      {generation.source} · {generation.generationId} · v{generation.packageVersion} · <b>{generation.status}</b>
                      {generation.failureDomain !== undefined ? ' · ' + generation.failureDomain : ''}
                      {generation.parentGenerationId !== undefined ? ' · parent=' + generation.parentGenerationId : ''}
                      {' · ' + (generation.startedAt !== undefined ? generation.startedAt.slice(0, 19).replace('T', ' ') : '-')}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Generated/本地皮肤生命周期：编辑信息 / 导出 / 重新生成 */}
          {selected.source !== 'builtin' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, borderTop: '1px dashed var(--dsw-alias-border-l1, rgba(128,128,128,0.3))', paddingTop: 8 }}>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                {!editOpen && <button data-testid="dsh-skin-edit-open" style={buttonStyle} onClick={openEdit}>编辑信息</button>}
                <a data-testid={'dsh-skin-action-' + selected.id + '-export'} style={{ ...buttonStyle, textDecoration: 'none', display: 'inline-block' }} href={controller.exportUrl(selected.id)} download>导出</a>
                {selected.source === 'generated' && <button data-testid={'dsh-skin-action-' + selected.id + '-regenerate'} style={buttonStyle} disabled={generating} onClick={() => { void regenerate() }}>重新生成</button>}
                {(selected.source === 'installed' || selected.source === 'generated') && (
                  <>
                    <button data-testid={'dsh-skin-action-' + selected.id + '-publish'} style={buttonStyle} disabled={wsBusy} onClick={() => { void publishLocal(selected.id, 'new') }}>发布</button>
                    <button data-testid={'dsh-skin-action-' + selected.id + '-publish-version'} style={buttonStyle} disabled={wsBusy} onClick={() => { void publishLocal(selected.id, 'version') }}>发布新版本</button>
                  </>
                )}
              </div>
              {editOpen && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <input data-testid="dsh-skin-edit-name" style={inputStyle} placeholder="名称" value={editName} onChange={event => { setEditName(event.target.value) }} />
                  <input data-testid="dsh-skin-edit-author" style={inputStyle} placeholder="作者" value={editAuthor} onChange={event => { setEditAuthor(event.target.value) }} />
                  <input data-testid="dsh-skin-edit-description" style={inputStyle} placeholder="描述" value={editDescription} onChange={event => { setEditDescription(event.target.value) }} />
                  <input data-testid="dsh-skin-edit-tags" style={inputStyle} placeholder="标签，逗号分隔" value={editTags} onChange={event => { setEditTags(event.target.value) }} />
                  <div>
                    <button data-testid="dsh-skin-edit-save" style={buttonStyle} onClick={() => { void saveEdit() }}>保存</button>
                    <button style={buttonStyle} onClick={() => { setEditOpen(false) }}>取消</button>
                  </div>
                </div>
              )}
            </div>
          )}
          {lifecycleResult !== null && <div data-testid="dsh-skin-lifecycle-result" style={{ fontSize: 11, opacity: 0.9 }}>{lifecycleResult}</div>}
        </div>
      )}

      {!snapshot.persisted && <div style={{ fontSize: 11, opacity: 0.7 }}>settings 不可写（非 loopback 页面）：激活状态仅本页有效。</div>}
    </div>
  )
}
