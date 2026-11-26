// The plugin's own worker. Orca starts it on the panel's first plugin.request and transpiles
// this file when it loads: no build step. The TAPD token lives in the plugin's encrypted secrets;
// the project and owner are declared settings the person edits in Settings -> Plugins.
import type { OrcaWorkerApi } from 'orca/worker'
import type { TapdItem, TapdListResult, TapdStatusCount } from './protocol'

const TAPD_BASE = 'https://api.tapd.cn'
const TOKEN_KEY = 'token'
const DEFAULT_LIMIT = 100

const STATUS_LABELS: Record<string, string> = {
  new: '新',
  in_progress: '处理中',
  reopened: '重新打开',
  resolved: '已解决',
  verified: '已验证',
  closed: '已关闭',
  rejected: '已拒绝',
  postponed: '已延期'
}

const PRIORITY_LABELS: Record<string, string> = {
  urgent: '紧急',
  high: '高',
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

  if (!response.ok) throw new TapdError('api_error', `TAPD 返回 HTTP ${response.status}`)
  if (typeof body !== 'object' || body === null) throw new TapdError('api_error', 'TAPD 返回了空响应')
  const record = body as Record<string, unknown>
  if (record['status'] !== 1) {
    throw new TapdError('api_error', text(record['info'], `TAPD 返回错误状态 ${String(record['status'])}`))
  }
  return record['data'] as T
}

function normalize(row: Record<string, unknown>, workspaceId: string): TapdItem {
  const id = text(row['id'], '')
  const status = text(row['status'], '')
  const priority = text(row['priority'], '')
  return {
    id,
    title: text(row['title'], '(无标题)'),
    status,
    statusLabel: STATUS_LABELS[status] ?? status,
    priority,
    priorityLabel: PRIORITY_LABELS[priority] ?? (priority || '-'),
    created: text(row['created'], ''),
    modified: text(row['modified'], ''),
    modifiedAt: toMs(row['modified']),
    link: `https://www.tapd.cn/${workspaceId}/bugtrace/bugs/view/${id}`
  }
}

export default function activate(orca: OrcaWorkerApi): void {
  orca.panels.handle('tapd.list', async (_input, context): Promise<TapdListResult> => {
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

    const base: TapdListResult = {
      ok: false,
      workspaceId,
      workspaceName: '',
      owner,
      onlyOpen,
      hasToken: token.length > 0,
      fetchedAt: Date.now(),
      items: [],
      counts: []
    }
    if (!workspaceId || !owner) return { ...base, reason: 'not_configured' }
    if (!token) return { ...base, reason: 'no_token' }

    const params: Record<string, string> = {
      workspace_id: workspaceId,
      current_owner: owner,
      fields: 'id,title,status,priority,created,modified,current_owner',
      order: 'modified desc',
      limit: String(limit)
    }
    if (onlyOpen) params['status'] = '!=closed'

    try {
      const [bugs, info] = await Promise.all([
        tapdGet<{ Bug: Record<string, unknown> }[]>('bugs', params, token, context.signal),
        tapdGet<{ Workspace?: Record<string, unknown> }>(
          'workspaces/get_workspace_info',
          { workspace_id: workspaceId },
          token,
          context.signal
        ).catch(() => null)
      ])

      const items = (Array.isArray(bugs) ? bugs : [])
        .map((entry) => normalize(entry?.Bug ?? {}, workspaceId))
        .filter((item) => item.id !== '')

      const counts = new Map<string, TapdStatusCount>()
      for (const item of items) {
        const seen = counts.get(item.status)
        if (seen) seen.count += 1
        else counts.set(item.status, { status: item.status, label: item.statusLabel, count: 1 })
      }

      const workspaceName =
        info?.Workspace && typeof info.Workspace['name'] === 'string'
          ? info.Workspace['name'].trim()
          : ''

      return {
        ...base,
        ok: true,
        workspaceName,
        fetchedAt: Date.now(),
        items,
        counts: [...counts.values()]
      }
    } catch (error) {
      return {
        ...base,
        reason: error instanceof TapdError ? error.reason : 'network_error',
        message: error instanceof Error ? error.message : String(error)
      }
    }
  })
}