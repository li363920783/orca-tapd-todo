// The plugin's own worker. Orca starts it on the panel's first plugin.request and transpiles
// this file when it loads: no build step. The TAPD token lives in the plugin's encrypted secrets;
// the project and owner are declared settings the person edits in Settings -> Plugins.
//
// It also polls while the plugin is enabled so the status bar item ("TAPD 3") stays current, and
// it launches an Orca agent for one work item ("一键派单").
import type { OrcaWorkerApi } from 'orca/worker'
import { execFile } from 'node:child_process'
import type {
  TapdComment,
  TapdDetailResult,
  TapdDispatchResult,
  TapdItem,
  TapdKind,
  TapdListResult,
  TapdStatusCount
} from './protocol'

const TAPD_BASE = 'https://api.tapd.cn'
const TOKEN_KEY = 'token'
const STATUS_BAR_ID = 'tapd-pending'
const DEFAULT_LIMIT = 100
/** Per-kind page size: TAPD accepts 200; the merged list is then capped by the `limit` setting. */
const FETCH_LIMIT = 200
const STATUS_MAP_TTL_MS = 60 * 60 * 1000
const DEFAULT_POLL_MINUTES = 5

const BUG_PRIORITY_LABELS: Record<string, string> = {
  urgent: '紧急',
  high: '高',
  medium: '中',
  low: '低'
}

/** Story priorities are numeric (1–4) with an English `priority_label`; custom values stay raw. */
const STORY_PRIORITY_LABELS: Record<string, string> = {
  '1': '紧急',
  '2': '低',
  '3': '中',
  '4': '高',
  highest: '紧急',
  urgent: '紧急',
  high: '高',
  middle: '中',
  medium: '中',
  low: '低'
}

class TapdError extends Error {
  constructor(
    readonly reason: 'api_error' | 'network_error',
    message: string
  ) {
    super(message)
  }
}

function text(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

/** TAPD writes Beijing time without a zone; parse it as UTC+8 so ordering is stable anywhere. */
function toMs(value: unknown): number {
  if (typeof value !== 'string' || !value) return 0
  const parsed = Date.parse(value.replace(' ', 'T') + '+08:00')
  return Number.isNaN(parsed) ? 0 : parsed
}

const ENTITIES: Record<string, string> = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'"
}

function decodeEntities(value: string): string {
  return value.replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, name: string) => {
    if (name.startsWith('#')) {
      const hex = name[1] === 'x' || name[1] === 'X'
      const code = Number.parseInt(name.slice(hex ? 2 : 1), hex ? 16 : 10)
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : match
    }
    return ENTITIES[name.toLowerCase()] ?? match
  })
}

/** TAPD descriptions and comments are HTML unless `description_type` says markdown. */
function htmlToText(value: string): string {
  if (!value) return ''
  const withoutMarkup = value
    .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\s*\/\s*(p|div|li|h[1-6]|tr|blockquote)\s*>/gi, '\n')
    .replace(/<\s*li[^>]*>/gi, '- ')
    .replace(/<\s*(td|th)[^>]*>/gi, '\t')
    .replace(/<[^>]+>/g, '')
  return decodeEntities(withoutMarkup)
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function plainDescription(row: Record<string, unknown>): string {
  const raw = text(row['description'], '')
  if (!raw) return ''
  return text(row['description_type'], '').toLowerCase() === 'markdown' ? raw : htmlToText(raw)
}

async function tapdGet<T>(
  path: string,
  params: Record<string, string>,
  token: string,
  signal?: AbortSignal
): Promise<T> {
  const query = new URLSearchParams(params)
  let response: Response
  try {
    response = await fetch(`${TAPD_BASE}/${path}?${query}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal
    })
  } catch (error) {
    throw new TapdError(
      'network_error',
      `连接 TAPD 失败：${error instanceof Error ? error.message : String(error)}`
    )
  }

  let body: unknown = null
  try {
    body = await response.json()
  } catch {
    // Fall through: a non-JSON body is reported by the checks below.
  }

  if (!response.ok) {
    const info =
      typeof body === 'object' && body !== null
        ? text((body as Record<string, unknown>)['info'], '')
        : ''
    throw new TapdError(
      'api_error',
      `TAPD 返回 HTTP ${response.status}${info ? `：${info}` : ''}`
    )
  }
  if (typeof body !== 'object' || body === null) throw new TapdError('api_error', 'TAPD 返回了空响应')
  const record = body as Record<string, unknown>
  if (record['status'] !== 1) {
    throw new TapdError('api_error', text(record['info'], `TAPD 返回错误状态 ${String(record['status'])}`))
  }
  return record['data'] as T
}

function priorityLabel(kind: TapdKind, row: Record<string, unknown>): string {
  const raw = text(row['priority'], '')
  const rawLabel = text(row['priority_label'], '')
  const key = (kind === 'story' ? rawLabel || raw : raw || rawLabel).toLowerCase()
  const mapped =
    kind === 'story'
      ? STORY_PRIORITY_LABELS[key]
      : BUG_PRIORITY_LABELS[key]
  return mapped ?? (raw || '-')
}

function itemLink(kind: TapdKind, workspaceId: string, id: string): string {
  return kind === 'bug'
    ? `https://www.tapd.cn/${workspaceId}/bugtrace/bugs/view/${id}`
    : `https://www.tapd.cn/${workspaceId}/prong/stories/view/${id}`
}

function normalizeItem(
  kind: TapdKind,
  row: Record<string, unknown>,
  workspaceId: string,
  statusMap: Record<string, string> | null
): TapdItem {
  const id = text(row['id'], '')
  const status = text(row['status'], '')
  return {
    kind,
    id,
    title: kind === 'bug' ? text(row['title'], '(无标题)') : text(row['name'], '(无标题)'),
    status,
    statusLabel: status ? statusMap?.[status] ?? status : '-',
    priority: text(row['priority'], ''),
    priorityLabel: priorityLabel(kind, row),
    created: text(row['created'], ''),
    modified: text(row['modified'], ''),
    modifiedAt: toMs(row['modified']),
    link: itemLink(kind, workspaceId, id),
    owner: text(kind === 'bug' ? row['current_owner'] : row['owner'], '').replace(/[;\s]+$/, '')
  }
}

type StatusMapCache = { at: number; map: Record<string, string> }

/**
 * TAPD's status_map is a flat `{ status: label }` object (verified against api.tapd.cn). Cached
 * per workspace + kind for an hour; any failure or odd shape falls back to raw status names.
 */
async function getStatusMap(
  orca: OrcaWorkerApi,
  kind: TapdKind,
  workspaceId: string,
  token: string,
  signal: AbortSignal | undefined,
  force: boolean
): Promise<Record<string, string> | null> {
  const key = `statusMap:${workspaceId}:${kind}`
  if (!force) {
    const cached = await orca.storage.get(key).catch(() => null)
    if (cached && typeof cached === 'object' && !Array.isArray(cached)) {
      const entry = cached as Partial<StatusMapCache>
      if (
        typeof entry.at === 'number' &&
        Date.now() - entry.at < STATUS_MAP_TTL_MS &&
        entry.map &&
        typeof entry.map === 'object'
      ) {
        return entry.map as Record<string, string>
      }
    }
  }

  const data = await tapdGet<Record<string, unknown>>(
    'workflows/status_map',
    { workspace_id: workspaceId, system: kind },
    token,
    signal
  )
  const source =
    data && typeof data === 'object' && typeof data['status_map'] === 'object'
      ? (data['status_map'] as Record<string, unknown>)
      : data
  if (!source || typeof source !== 'object' || Array.isArray(source)) return null
  const map: Record<string, string> = {}
  for (const [status, label] of Object.entries(source)) {
    if (typeof label === 'string' && label.trim()) map[status] = label.trim()
  }
  await orca.storage.set(key, { at: Date.now(), map }).catch(() => undefined)
  return map
}

type ListOptions = { signal?: AbortSignal; force?: boolean }

type FetchOutcome = TapdListResult & { openCount: number }

/**
 * One TAPD read used by both `tapd.list` and the status-bar poll: bugs and stories in parallel,
 * merged newest-change-first, with status_map labels cached in the plugin's storage.
 */
async function loadList(orca: OrcaWorkerApi, options: ListOptions = {}): Promise<FetchOutcome> {
  const settings = await orca.settings.get()
  const workspaceId = text(settings['workspaceId'], '')
  const owner = text(settings['owner'], '')
  const onlyOpen = settings['onlyOpen'] !== false
  const rawLimit = settings['limit']
  const limit = Math.min(
    200,
    Math.max(
      1,
      typeof rawLimit === 'number' && Number.isFinite(rawLimit)
        ? Math.round(rawLimit)
        : DEFAULT_LIMIT
    )
  )
  const token = text(await orca.secrets.get(TOKEN_KEY), '')

  const base: FetchOutcome = {
    ok: false,
    workspaceId,
    workspaceName: '',
    owner,
    onlyOpen,
    hasToken: token.length > 0,
    fetchedAt: Date.now(),
    items: [],
    counts: [],
    openCount: 0
  }
  if (!workspaceId || !owner) return { ...base, reason: 'not_configured' }
  if (!token) return { ...base, reason: 'no_token' }

  const bugParams: Record<string, string> = {
    workspace_id: workspaceId,
    current_owner: owner,
    fields: 'id,title,status,priority,created,modified,current_owner',
    order: 'modified desc',
    limit: String(FETCH_LIMIT)
  }
  // Stories name the assignee field `owner`; `current_owner` is ignored there.
  const storyParams: Record<string, string> = {
    workspace_id: workspaceId,
    owner,
    fields: 'id,name,status,priority,created,modified,owner,creator',
    order: 'modified desc',
    limit: String(FETCH_LIMIT)
  }
  if (onlyOpen) {
    bugParams['status'] = '!=closed'
    storyParams['status'] = '!=closed'
  }

  try {
    const [bugs, stories, info, bugMap, storyMap] = await Promise.all([
      tapdGet<{ Bug: Record<string, unknown> }[]>('bugs', bugParams, token, options.signal),
      tapdGet<{ Story: Record<string, unknown> }[]>('stories', storyParams, token, options.signal),
      tapdGet<{ Workspace?: Record<string, unknown> }>(
        'workspaces/get_workspace_info',
        { workspace_id: workspaceId },
        token,
        options.signal
      ).catch(() => null),
      getStatusMap(orca, 'bug', workspaceId, token, options.signal, options.force === true).catch(
        () => null
      ),
      getStatusMap(orca, 'story', workspaceId, token, options.signal, options.force === true).catch(
        () => null
      )
    ])

    const merged = [
      ...(Array.isArray(bugs) ? bugs : []).map((entry) =>
        normalizeItem('bug', entry?.Bug ?? {}, workspaceId, bugMap)
      ),
      ...(Array.isArray(stories) ? stories : []).map((entry) =>
        normalizeItem('story', entry?.Story ?? {}, workspaceId, storyMap)
      )
    ].filter((item) => item.id !== '')

    merged.sort((left, right) => right.modifiedAt - left.modifiedAt)

    // Counts describe everything TAPD returned (both kinds, before the display cap), so the
    // status bar does not undercount when the cap is small.
    const counts = new Map<string, TapdStatusCount>()
    for (const item of merged) {
      const key = `${item.kind}:${item.status}`
      const seen = counts.get(key)
      if (seen) seen.count += 1
      else
        counts.set(key, {
          kind: item.kind,
          status: item.status,
          label: item.statusLabel,
          count: 1
        })
    }
    const openCount = merged.filter((item) => item.status !== 'closed').length

    const workspaceName =
      info?.Workspace && typeof info.Workspace['name'] === 'string'
        ? info.Workspace['name'].trim()
        : ''

    return {
      ...base,
      ok: true,
      workspaceName,
      fetchedAt: Date.now(),
      items: merged.slice(0, limit),
      counts: [...counts.values()],
      openCount
    }
  } catch (error) {
    return {
      ...base,
      reason: error instanceof TapdError ? error.reason : 'network_error',
      message: error instanceof Error ? error.message : String(error)
    }
  }
}

async function loadDetail(
  orca: OrcaWorkerApi,
  kind: TapdKind,
  id: string,
  signal?: AbortSignal
): Promise<TapdDetailResult> {
  try {
    const settings = await orca.settings.get()
    const workspaceId = text(settings['workspaceId'], '')
    const token = text(await orca.secrets.get(TOKEN_KEY), '')
    if (!workspaceId) return { ok: false, message: '还没有配置 TAPD 项目 ID' }
    if (!token) return { ok: false, message: '还没有配置 TAPD 访问令牌' }

    const path = kind === 'bug' ? 'bugs' : 'stories'
    const [rows, statusMap, commentRows] = await Promise.all([
      tapdGet<Record<string, Record<string, unknown>>>(
        path,
        { workspace_id: workspaceId, id },
        token,
        signal
      ),
      getStatusMap(orca, kind, workspaceId, token, signal, false).catch(() => null),
      tapdGet<{ Comment?: Record<string, unknown> }[]>(
        'comments',
        { workspace_id: workspaceId, entry_id: id, entry_type: kind, limit: '50' },
        token,
        signal
      ).catch(() => null)
    ])

    const container = Array.isArray(rows) ? rows[0] : undefined
    const row = kind === 'bug' ? container?.['Bug'] : container?.['Story']
    if (!row) return { ok: false, message: 'TAPD 没有返回这条工作项' }

    const status = text(row['status'], '')
    const comments: TapdComment[] = (Array.isArray(commentRows) ? commentRows : [])
      .map((entry) => entry?.Comment ?? {})
      .map((comment) => ({
        author: text(comment['author'], '-'),
        created: text(comment['created'], ''),
        text: htmlToText(text(comment['description'], ''))
      }))
      .filter((comment) => comment.text !== '')

    return {
      ok: true,
      title: kind === 'bug' ? text(row['title'], '(无标题)') : text(row['name'], '(无标题)'),
      kind,
      status,
      statusLabel: status ? statusMap?.[status] ?? status : '-',
      priority: text(row['priority'], ''),
      priorityLabel: priorityLabel(kind, row),
      owner: text(kind === 'bug' ? row['current_owner'] : row['owner'], '').replace(/[;\s]+$/, ''),
      creator: text(row['creator'], ''),
      created: text(row['created'], ''),
      modified: text(row['modified'], ''),
      link: itemLink(kind, workspaceId, id),
      description: plainDescription(row),
      comments
    }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error)
    }
  }
}

export type DispatchExec = (
  file: string,
  args: readonly string[]
) => Promise<{ stdout: string; stderr: string }>

const defaultDispatchExec: DispatchExec = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { timeout: 60_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          const failure = error as Error & { stdout?: string; stderr?: string }
          failure.stdout = stdout
          failure.stderr = stderr
          reject(failure)
        } else {
          resolve({ stdout, stderr })
        }
      }
    )
  })

let dispatchExec: DispatchExec = defaultDispatchExec

/** Test hook: replaces the CLI runner; call with no argument to restore the real execFile. */
export function setDispatchExec(runner?: DispatchExec): void {
  dispatchExec = runner ?? defaultDispatchExec
}

function summarize(description: string, max = 300): string {
  const flat = description.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

function buildPrompt(
  input: { kind: TapdKind; id: string; title: string; link: string },
  detail: TapdDetailResult | null
): string {
  const kindLabel = input.kind === 'bug' ? '缺陷' : '需求'
  const base = detail?.ok === true ? detail : null
  const title = base?.title || input.title
  const status = base?.statusLabel || '-'
  const priority = base?.priorityLabel || '-'
  const summary = base ? summarize(base.description) : ''
  return [
    'TAPD 待办派单',
    '',
    `单号：${input.id}`,
    `类型：${kindLabel}`,
    `标题：${title}`,
    `链接：${base?.link || input.link}`,
    `状态：${status}`,
    `优先级：${priority}`,
    `描述摘要：${summary || '（无描述）'}`,
    '',
    '请先只读排查，给出根因和修复方案；不要直接改生产数据。'
  ].join('\n')
}

function readSessionId(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ''
  const root = value as Record<string, unknown>
  const result = root['result']
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    const outcome = (result as Record<string, unknown>)['outcome']
    if (outcome && typeof outcome === 'object' && !Array.isArray(outcome)) {
      const sessionId = (outcome as Record<string, unknown>)['sessionId']
      if (typeof sessionId === 'string' && sessionId) return sessionId
    }
  }
  const fallback = root['sessionId']
  return typeof fallback === 'string' ? fallback : ''
}

function readCliError(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ''
  const error = (value as Record<string, unknown>)['error']
  if (error && typeof error === 'object' && !Array.isArray(error)) {
    return text((error as Record<string, unknown>)['message'], '')
  }
  return ''
}

async function dispatchItem(
  orca: OrcaWorkerApi,
  input: { kind: TapdKind; id: string; title: string; link: string },
  signal?: AbortSignal
): Promise<TapdDispatchResult> {
  const settings = await orca.settings.get()
  const workspace = text(settings['dispatchWorkspace'], '')
  const agent = text(settings['dispatchAgent'], 'claude')
  const model = text(settings['dispatchModel'], '')
  if (!workspace) {
    return {
      ok: false,
      message: '先在设置里填写「派单目标工作区」（如 path:/root/projects/your-repo），并确认它已在 Orca 中打开'
    }
  }

  const key = `dispatched:${input.kind}:${input.id}`
  const previous = await orca.storage.get(key).catch(() => null)
  if (previous && typeof previous === 'object' && !Array.isArray(previous)) {
    const sessionId = (previous as Record<string, unknown>)['sessionId']
    if (typeof sessionId === 'string' && sessionId) return { ok: true, sessionId, reused: true }
  }

  const detail = await loadDetail(orca, input.kind, input.id, signal)
  const prompt = buildPrompt(input, detail)
  const args = [
    'agent',
    'launch',
    '--agent',
    agent,
    '--worktree',
    workspace,
    '--prompt',
    prompt,
    '--surface',
    'chat',
    '--json'
  ]
  if (model) args.push('--model', model)
  const file = process.env['ORCA_CLI_COMMAND'] || 'orca'

  let stdout = ''
  let stderr = ''
  try {
    const result = await dispatchExec(file, args)
    stdout = text(result.stdout, '')
    stderr = text(result.stderr, '')
  } catch (error) {
    const failure = error as { stdout?: unknown; stderr?: unknown }
    const stderrText = text(failure.stderr, '')
    const stdoutText = text(failure.stdout, '')
    const message =
      [stderrText, stdoutText].filter(Boolean).join('\n') ||
      (error instanceof Error ? error.message : String(error))
    return { ok: false, message: `派单失败：${message}` }
  }

  let parsed: unknown = null
  try {
    parsed = JSON.parse(stdout)
  } catch {
    // Reported below with the raw output.
  }
  const sessionId = readSessionId(parsed)
  if (!sessionId) {
    const reason = readCliError(parsed)
    const raw = [reason, stderr, stdout].filter(Boolean).join('\n')
    return {
      ok: false,
      message: `Orca CLI 没有返回会话 ID${raw ? `：${raw}` : '（无输出）'}`
    }
  }

  await orca.storage.set(key, { sessionId, at: Date.now() }).catch(() => undefined)
  return { ok: true, sessionId }
}

function clampPollMinutes(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_POLL_MINUTES
  return Math.min(60, Math.max(1, Math.round(value)))
}

type TimerHandle = number

let stopped = false
let pollingEnabled = true
let polling = false
let timer: TimerHandle | undefined
let settingsSub: { dispose(): void } | undefined

/** Test hook: keeps worker tests deterministic by not starting the poll timer. */
export function setPollingEnabled(enabled: boolean): void {
  pollingEnabled = enabled
}

async function updateStatusBar(
  orca: OrcaWorkerApi,
  textValue: string,
  tone: 'neutral' | 'warning',
  tooltip: string
): Promise<void> {
  await orca.host.call('statusBar.update', {
    id: STATUS_BAR_ID,
    text: textValue,
    tone,
    tooltip
  })
}

async function pollOnce(orca: OrcaWorkerApi): Promise<void> {
  if (stopped || polling) return
  polling = true
  try {
    const result = await loadList(orca, { signal: AbortSignal.timeout(20_000) })
    if (!result.ok) {
      if (result.reason === 'not_configured' || result.reason === 'no_token') {
        await updateStatusBar(orca, 'TAPD –', 'neutral', 'TAPD 待办：先配置项目、负责人和访问令牌')
      } else {
        orca.log(`TAPD 轮询失败（${result.reason ?? 'unknown'}）：${result.message ?? ''}`)
      }
      return
    }
    const openCount = result.openCount
    await updateStatusBar(
      orca,
      `TAPD ${openCount}`,
      openCount > 0 ? 'warning' : 'neutral',
      `未关闭 ${openCount} 条`
    )
    orca.panels.post('tapd.changed', { fetchedAt: result.fetchedAt, openCount })
  } catch (error) {
    orca.log(`TAPD 轮询异常：${error instanceof Error ? error.message : String(error)}`)
  } finally {
    polling = false
  }
}

function startPolling(orca: OrcaWorkerApi): void {
  if (!pollingEnabled || stopped) return
  void pollOnce(orca)
  void orca.settings
    .get()
    .then((settings) => {
      if (stopped) return
      if (timer !== undefined) clearInterval(timer)
      const minutes = clampPollMinutes(settings['pollMinutes'])
      timer = setInterval(() => {
        void pollOnce(orca)
      }, minutes * 60_000)
    })
    .catch((error: unknown) => {
      orca.log(`TAPD 轮询配置读取失败：${error instanceof Error ? error.message : String(error)}`)
    })
}

export default function activate(orca: OrcaWorkerApi): void {
  stopped = false
  orca.panels.handle('tapd.list', async (input, context) =>
    loadList(orca, { signal: context.signal, force: input?.force === true })
  )
  orca.panels.handle('tapd.detail', async (input, context) =>
    loadDetail(orca, input.kind, input.id, context.signal)
  )
  orca.panels.handle('tapd.dispatch', async (input, context) =>
    dispatchItem(orca, input, context.signal)
  )

  if (!pollingEnabled) return
  startPolling(orca)
  settingsSub = orca.settings.onDidChange(() => startPolling(orca))
}

export function deactivate(): void {
  stopped = true
  if (timer !== undefined) {
    clearInterval(timer)
    timer = undefined
  }
  settingsSub?.dispose()
  settingsSub = undefined
}