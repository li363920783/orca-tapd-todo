// No build step: Orca strips the types and compiles the JSX when the panel loads.
import {
  atom,
  Badge,
  Button,
  Callout,
  Card,
  Collapsible,
  EmptyState,
  Grid,
  Heading,
  IconButton,
  Input,
  KeyValue,
  List,
  ListItem,
  Markdown,
  plugin,
  read,
  Row,
  Select,
  set,
  Spinner,
  Stack,
  Switch,
  Text,
  host,
  type PanelContext,
  type Tone
} from 'orca'
import type {
  TapdDetailResult,
  TapdItem,
  TapdKind,
  TapdListResult,
  TapdWorkspaceOption
} from './protocol'
import type { OrcaNode } from 'orca'

type ListState =
  | { phase: 'loading' }
  | { phase: 'ready'; result: TapdListResult }
  | { phase: 'error'; message: string }

type DetailState =
  | { phase: 'loading'; item: TapdItem }
  | { phase: 'ready'; item: TapdItem; result: TapdDetailResult }
  | { phase: 'error'; item: TapdItem; message: string }

type DispatchState =
  | { phase: 'idle' }
  | { phase: 'sending' }
  | { phase: 'done'; sessionId: string; reused: boolean; workspaceLabel?: string }
  | { phase: 'error'; message: string }

type WorkspaceState =
  | { phase: 'loading' }
  | { phase: 'ready'; options: TapdWorkspaceOption[]; target: string }
  | { phase: 'error'; message: string }

type Filters = { kind: 'all' | TapdKind; status: string; priority: string; keyword: string }

const state = atom<ListState>({ phase: 'loading' })
const config = atom({ workspaceId: '', owner: '', onlyOpen: true })
const tokenDraft = atom('')
const busy = atom(false)
const configOpen = atom(false)
const filters = atom<Filters>({ kind: 'all', status: 'all', priority: 'all', keyword: '' })
const detail = atom<DetailState | null>(null)
const dispatch = atom<DispatchState>({ phase: 'idle' })
const workspaceState = atom<WorkspaceState>({ phase: 'loading' })
const selectedWorkspace = atom('')
const live = atom<{ fetchedAt: number; openCount: number } | null>(null)

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function refresh(silent = false): Promise<void> {
  if (!silent) set(state, { phase: 'loading' })
  try {
    const result = await plugin.request('tapd.list', { force: true })
    set(state, { phase: 'ready', result })
    if (result.fetchedAt) {
      set(live, { fetchedAt: result.fetchedAt, openCount: result.openCount })
    }
    if (result.reason === 'not_configured') set(configOpen, true)
  } catch (error) {
    if (!silent) set(state, { phase: 'error', message: messageOf(error) })
  }
}

async function saveToken(): Promise<void> {
  const value = read(tokenDraft).trim()
  if (!value) return
  set(busy, true)
  try {
    await host.call('secrets.set', { key: 'token', value })
    set(tokenDraft, '')
    await refresh()
  } catch (error) {
    set(state, { phase: 'error', message: messageOf(error) })
  } finally {
    set(busy, false)
  }
}

async function saveConfig(): Promise<void> {
  const current = read(config)
  set(busy, true)
  try {
    await host.call('settings.set', { key: 'workspaceId', value: current.workspaceId.trim() })
    await host.call('settings.set', { key: 'owner', value: current.owner.trim() })
    await host.call('settings.set', { key: 'onlyOpen', value: current.onlyOpen })
    await refresh()
  } catch (error) {
    set(state, { phase: 'error', message: messageOf(error) })
  } finally {
    set(busy, false)
  }
}

/** True while the person is still looking at this item (they may have gone back or opened another). */
function stillShowing(item: TapdItem): boolean {
  const current = read(detail)
  return current !== null && current.item.kind === item.kind && current.item.id === item.id
}

async function rememberDispatch(item: TapdItem): Promise<void> {
  try {
    const { value } = await host.call('storage.get', {
      key: `dispatched:${item.kind}:${item.id}`
    })
    if (!stillShowing(item)) return
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const sessionId = (value as Record<string, unknown>)['sessionId']
      if (typeof sessionId === 'string' && sessionId) {
        set(dispatch, { phase: 'done', sessionId, reused: true })
      }
    }
  } catch {
    // A missing dispatch record only means the button offers a fresh dispatch.
  }
}

async function loadWorkspaces(item: TapdItem): Promise<void> {
  set(workspaceState, { phase: 'loading' })
  try {
    const result = await plugin.request('tapd.workspaces', {})
    if (!stillShowing(item)) return
    set(workspaceState, {
      phase: 'ready',
      options: result.workspaces,
      target: result.target
    })
    const known = result.workspaces.some((option) => option.selector === result.target)
    set(selectedWorkspace, known ? result.target : '')
  } catch (error) {
    if (!stillShowing(item)) return
    set(workspaceState, { phase: 'error', message: messageOf(error) })
    set(selectedWorkspace, '')
  }
}

async function openDetail(item: TapdItem): Promise<void> {
  set(detail, { phase: 'loading', item })
  set(dispatch, { phase: 'idle' })
  set(workspaceState, { phase: 'loading' })
  set(selectedWorkspace, '')
  void loadWorkspaces(item)
  void rememberDispatch(item)
  try {
    const result = await plugin.request('tapd.detail', { kind: item.kind, id: item.id })
    if (stillShowing(item)) set(detail, { phase: 'ready', item, result })
  } catch (error) {
    if (stillShowing(item)) set(detail, { phase: 'error', item, message: messageOf(error) })
  }
}

function closeDetail(): void {
  set(detail, null)
  set(dispatch, { phase: 'idle' })
}

async function dispatchItem(item: TapdItem): Promise<void> {
  const workspace = read(selectedWorkspace)
  if (!workspace) {
    set(dispatch, { phase: 'error', message: '先在详情页选择派单工作区' })
    return
  }
  const state = read(workspaceState)
  const label =
    state.phase === 'ready'
      ? state.options.find((option) => option.selector === workspace)?.label ?? workspace
      : workspace
  set(dispatch, { phase: 'sending' })
  try {
    const result = await plugin.request(
      'tapd.dispatch',
      {
        kind: item.kind,
        id: item.id,
        title: item.title,
        link: item.link,
        workspace
      },
      { timeoutMs: 120_000 }
    )
    if (result.ok && result.sessionId) {
      set(dispatch, {
        phase: 'done',
        sessionId: result.sessionId,
        reused: result.reused === true,
        workspaceLabel: label
      })
    } else {
      set(dispatch, { phase: 'error', message: result.message ?? '派单失败' })
    }
  } catch (error) {
    set(dispatch, { phase: 'error', message: messageOf(error) })
  }
}

/** Runs once before the first render; what it pushes to `subscriptions` ends with the panel. */
export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(
    plugin.on('tapd.changed', (payload) => {
      set(live, payload)
      // Keep a detail view undisturbed: only the open count above it changes.
      if (read(detail) === null) void refresh(true)
    })
  )
  void (async () => {
    try {
      const { settings } = await host.call('settings.get')
      set(config, {
        workspaceId: String(settings['workspaceId'] ?? ''),
        owner: String(settings['owner'] ?? ''),
        onlyOpen: settings['onlyOpen'] !== false
      })
    } catch {
      // Settings are only used by the form below; the list request reads them in the worker.
    }
    if (!ctx.signal.aborted) await refresh()
  })()
}

function kindLabel(kind: TapdKind): string {
  return kind === 'bug' ? '缺陷' : '需求'
}

function kindTone(kind: TapdKind): Tone {
  return kind === 'bug' ? 'danger' : 'accent'
}

function statusTone(status: string): Tone {
  if (status === 'new' || status === 'reopened') return 'danger'
  if (status === 'in_progress' || status === 'developing' || status === 'testing') return 'warning'
  if (status === 'resolved' || status === 'verified' || status === 'done') return 'success'
  return 'neutral'
}

const PRIORITY_FILTERS = [
  { value: 'all', label: '全部' },
  { value: '紧急', label: '紧急' },
  { value: '高', label: '高' },
  { value: '中', label: '中' },
  { value: '低', label: '低' }
]

function visibleItems(result: TapdListResult): TapdItem[] {
  const current = read(filters)
  const keyword = current.keyword.trim().toLowerCase()
  return result.items.filter((item) => {
    if (current.kind !== 'all' && item.kind !== current.kind) return false
    if (current.status !== 'all' && item.statusLabel !== current.status) return false
    if (current.priority !== 'all' && item.priorityLabel !== current.priority) return false
    if (keyword && !item.title.toLowerCase().includes(keyword)) return false
    return true
  })
}

function DetailView(): OrcaNode {
  const current = read(detail)
  if (current === null) return null
  const dispatchState = read(dispatch)
  const state = read(workspaceState)
  const selected = read(selectedWorkspace)
  const options = state.phase === 'ready' ? state.options : []
  const noWorkspace =
    state.phase === 'error' || (state.phase === 'ready' && options.length === 0)
  const dispatchedLabel =
    dispatchState.phase === 'done'
      ? dispatchState.workspaceLabel ||
        options.find((option) => option.selector === selected)?.label ||
        selected
      : ''
  const result = current.phase === 'ready' ? current.result : null
  const sending = dispatchState.phase === 'sending'
  const done = dispatchState.phase === 'done'

  return (
    <Stack gap="md">
      <Button variant="ghost" onPress={closeDetail}>
        ← 返回列表
      </Button>

      {current.phase === 'loading' ? <Spinner label="正在读取详情…" /> : null}

      {current.phase === 'error' ? (
        <Callout tone="danger" title="读取详情失败">
          {current.message}
        </Callout>
      ) : null}

      {result && !result.ok ? (
        <Callout tone="danger" title="读取详情失败">
          {result.message}
        </Callout>
      ) : null}

      {result?.ok ? (
        <Stack gap="md">
          <Heading level={3}>{result.title}</Heading>
          <Row gap="xs" wrap align="center">
            <Badge tone={kindTone(result.kind)}>{kindLabel(result.kind)}</Badge>
            <Badge tone={statusTone(result.status)}>{result.statusLabel}</Badge>
            <Badge tone="neutral">{result.priorityLabel}</Badge>
          </Row>
          <KeyValue
            items={[
              { label: '处理人', value: result.owner || '-' },
              { label: '创建人', value: result.creator || '-' },
              { label: '创建时间', value: result.created || '-' },
              { label: '更新时间', value: result.modified || '-' }
            ]}
          />
          <Markdown content={result.description || '（无描述）'} />

          {result.comments.length > 0 ? (
            <Stack gap="sm">
              <Text weight="semibold">{`评论 ${result.comments.length}`}</Text>
              {result.comments.map((comment, index) => (
                <Card
                  key={`${comment.created}:${index}`}
                  title={comment.author}
                  description={comment.created}
                >
                  <Text size="sm">{comment.text}</Text>
                </Card>
              ))}
            </Stack>
          ) : null}

          {options.length > 0 ? (
            <Select
              label="派单到工作区"
              value={selected}
              options={options.map((option) => ({
                value: option.selector,
                label: `${option.label} — ${option.detail}`
              }))}
              onChange={(value) => set(selectedWorkspace, value)}
            />
          ) : null}

          {noWorkspace ? (
            <Callout tone="warning" title="没有可选的 Orca 工作区">
              {state.phase === 'error'
                ? state.message
                : '先在 Orca 中打开一个工作区，再重新打开这张单的详情'}
            </Callout>
          ) : null}

          <Row gap="sm" wrap align="center">
            <Button
              variant="outline"
              onPress={() => void host.call('shell.openExternal', { url: result.link })}
            >
              在 TAPD 打开
            </Button>
            <Button
              disabled={sending || done || selected === ''}
              onPress={() => void dispatchItem(current.item)}
            >
              {done ? '已派单' : '一键派单'}
            </Button>
            {sending ? <Spinner label="正在派单…" /> : null}
          </Row>

          {dispatchState.phase === 'done' ? (
            <Callout tone="success" title={dispatchState.reused ? '已派单（此前创建）' : '已派单'}>
              {dispatchedLabel
                ? `派到 ${dispatchedLabel} · 会话 ${dispatchState.sessionId.slice(0, 8)}`
                : `会话 ${dispatchState.sessionId.slice(0, 8)} · 在 Orca 侧栏查看进度`}
            </Callout>
          ) : null}
          {dispatchState.phase === 'error' ? (
            <Callout tone="danger" title="派单失败">
              {dispatchState.message}
            </Callout>
          ) : null}
        </Stack>
      ) : null}
    </Stack>
  )
}

export default function Panel() {
  const view = read(state)
  const current = read(config)
  const working = read(busy)
  const currentFilters = read(filters)
  const liveState = read(live)
  const result = view.phase === 'ready' ? view.result : null
  const items = result?.items ?? []
  const shown = result ? visibleItems(result) : []
  const statusLabels = [...new Set(items.map((item) => item.statusLabel))]

  return (
    <Stack gap="md">
      <Row justify="between" align="start">
        <Stack gap="none">
          <Heading level={2}>TAPD 待办</Heading>
          <Text muted size="xs">
            {result?.workspaceName
              ? `${result.workspaceName} · ${result.owner}`
              : '按 TAPD 当前处理人筛选（缺陷和需求）'}
          </Text>
          {liveState ? <Text muted size="xs">{`未关闭 ${liveState.openCount} 条`}</Text> : null}
        </Stack>
        <IconButton
          icon="refresh"
          label="刷新"
          variant="ghost"
          disabled={view.phase === 'loading'}
          onPress={() => void refresh()}
        />
      </Row>

      {read(detail) !== null ? (
        <DetailView />
      ) : (
        <Stack gap="md">
          {result && result.counts.length > 0 ? (
            <Row gap="xs" wrap>
              <Button
                size="xs"
                variant={
                  currentFilters.status === 'all' && currentFilters.kind === 'all'
                    ? 'solid'
                    : 'ghost'
                }
                tone="neutral"
                onPress={() =>
                  set(filters, { ...read(filters), status: 'all', kind: 'all' })
                }
              >
                全部
              </Button>
              {result.counts.map((count) => {
                const selected =
                  currentFilters.status === count.label && currentFilters.kind === count.kind
                return (
                  <Button
                    key={`${count.kind}:${count.status}`}
                    size="xs"
                    variant={selected ? 'solid' : 'ghost'}
                    tone={statusTone(count.status)}
                    onPress={() => {
                      const current = read(filters)
                      const isSame = current.status === count.label && current.kind === count.kind
                      set(filters, {
                        ...current,
                        status: isSame ? 'all' : count.label,
                        kind: isSame ? current.kind : count.kind
                      })
                    }}
                  >
                    {`${count.label} ${count.count}`}
                  </Button>
                )
              })}
            </Row>
          ) : null}

          {result?.ok && items.length > 0 ? (
            <Stack gap="sm">
              <Grid columns={2}>
                <Select
                  label="类型"
                  value={currentFilters.kind}
                  options={[
                    { value: 'all', label: '全部' },
                    { value: 'bug', label: '缺陷' },
                    { value: 'story', label: '需求' }
                  ]}
                  onChange={(value) =>
                    set(filters, { ...read(filters), kind: value as Filters['kind'] })
                  }
                />
                <Select
                  label="状态"
                  value={currentFilters.status}
                  options={[
                    { value: 'all', label: '全部' },
                    ...statusLabels.map((label) => ({ value: label, label }))
                  ]}
                  onChange={(value) => set(filters, { ...read(filters), status: value })}
                />
                <Select
                  label="优先级"
                  value={currentFilters.priority}
                  options={PRIORITY_FILTERS}
                  onChange={(value) => set(filters, { ...read(filters), priority: value })}
                />
              </Grid>
              <Input
                label="关键字"
                placeholder="标题包含…"
                type="search"
                value={currentFilters.keyword}
                onChange={(value) => set(filters, { ...read(filters), keyword: value })}
              />
            </Stack>
          ) : null}

          {view.phase === 'loading' ? <Spinner label="正在读取 TAPD…" /> : null}

          {view.phase === 'error' ? (
            <Callout tone="danger" title="读取失败">
              {view.message}
            </Callout>
          ) : null}

          {result?.reason === 'not_configured' ? (
            <Callout tone="warning" title="先配置 TAPD 项目">
              <Stack gap="sm">
                <Text size="xs" muted>
                  在下方「配置」里填 TAPD 项目 ID 和负责人，保存后就会按当前处理人读取缺陷和需求。
                </Text>
                <Button variant="outline" onPress={() => set(configOpen, true)}>
                  去配置
                </Button>
              </Stack>
            </Callout>
          ) : null}

          {result && !result.hasToken && result.reason !== 'not_configured' ? (
            <Callout tone="warning" title="还没有配置 TAPD 令牌">
              <Stack gap="sm">
                <Text size="xs" muted>
                  在 TAPD「个人设置 → 安全设置 → 个人访问令牌」创建令牌后粘贴到这里；令牌只存在插件的加密
                  secrets 里。
                </Text>
                <Input
                  label="访问令牌"
                  labelHidden
                  type="password"
                  placeholder="粘贴个人访问令牌"
                  value={read(tokenDraft)}
                  onChange={(value) => set(tokenDraft, value)}
                />
                <Button
                  disabled={working || read(tokenDraft).trim() === ''}
                  onPress={() => void saveToken()}
                >
                  保存并读取
                </Button>
              </Stack>
            </Callout>
          ) : null}

          {result && result.hasToken && !result.ok && result.reason !== 'no_token' ? (
            <Callout tone="danger" title="TAPD 返回错误">
              {result.message ?? result.reason ?? '未知错误'}
            </Callout>
          ) : null}

          {result?.ok && items.length === 0 ? (
            <EmptyState
              icon="check"
              title="没有待办"
              description={`${result.owner} 在项目 ${result.workspaceId} 下没有被指派的缺陷或需求。`}
            />
          ) : null}

          {result?.ok && items.length > 0 && shown.length === 0 ? (
            <EmptyState
              icon="filter"
              title="没有匹配的待办"
              description="调整类型、状态、优先级或关键字筛选。"
            />
          ) : null}

          {result?.ok && shown.length > 0 ? (
            <List label="TAPD 待办">
              {shown.map((item) => (
                <ListItem
                  key={`${item.kind}:${item.id}`}
                  icon={item.kind === 'bug' ? 'bug' : 'flag'}
                  title={item.title}
                  onPress={() => void openDetail(item)}
                >
                  <Row gap="xs" wrap align="center">
                    <Badge tone={kindTone(item.kind)}>{kindLabel(item.kind)}</Badge>
                    <Badge tone={statusTone(item.status)}>{item.statusLabel}</Badge>
                    <Text muted size="xs">{`${item.priorityLabel} · ${item.modified}`}</Text>
                  </Row>
                </ListItem>
              ))}
            </List>
          ) : null}

          {result?.fetchedAt ? (
            <Text muted size="xs">
              {`最近读取 ${new Date(result.fetchedAt).toLocaleTimeString()}`}
            </Text>
          ) : null}

          <Collapsible
            title="配置"
            description="项目 ID 与负责人保存在 Orca 设置里"
            open={read(configOpen)}
            onChange={(open) => set(configOpen, open)}
          >
            <Stack gap="sm">
              <Input
                label="TAPD 项目 ID"
                value={current.workspaceId}
                placeholder="12345678"
                onChange={(value) => set(config, { ...read(config), workspaceId: value })}
              />
              <Input
                label="负责人"
                value={current.owner}
                placeholder="测试用户"
                onChange={(value) => set(config, { ...read(config), owner: value })}
              />
              <Row justify="between" align="center">
                <Text size="xs">只显示未关闭</Text>
                <Switch
                  label="只显示未关闭"
                  checked={current.onlyOpen}
                  onChange={(checked) => set(config, { ...read(config), onlyOpen: checked })}
                />
              </Row>
              <Button variant="outline" disabled={working} onPress={() => void saveConfig()}>
                保存配置并刷新
              </Button>
            </Stack>
          </Collapsible>
        </Stack>
      )}
    </Stack>
  )
}