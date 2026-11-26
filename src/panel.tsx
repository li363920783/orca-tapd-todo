// No build step: Orca strips the types and compiles the JSX when the panel loads.
import {
  atom,
  Badge,
  Button,
  Callout,
  Collapsible,
  EmptyState,
  Heading,
  IconButton,
  Input,
  List,
  ListItem,
  plugin,
  read,
  Row,
  set,
  Spinner,
  Stack,
  Switch,
  Text,
  host,
  type PanelContext
} from 'orca'
import type { TapdListResult } from './protocol'

type ListState =
  | { phase: 'loading' }
  | { phase: 'ready'; result: TapdListResult }
  | { phase: 'error'; message: string }

const state = atom<ListState>({ phase: 'loading' })
const config = atom({ workspaceId: '', owner: '', onlyOpen: true })
const tokenDraft = atom('')
const busy = atom(false)
const configOpen = atom(false)

async function refresh(): Promise<void> {
  set(state, { phase: 'loading' })
  try {
    const result = await plugin.request('tapd.list', { force: true })
    set(state, { phase: 'ready', result })
    if (result.reason === 'not_configured') set(configOpen, true)
  } catch (error) {
    set(state, { phase: 'error', message: error instanceof Error ? error.message : String(error) })
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
    set(state, { phase: 'error', message: error instanceof Error ? error.message : String(error) })
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
    set(state, { phase: 'error', message: error instanceof Error ? error.message : String(error) })
  } finally {
    set(busy, false)
  }
}

/** Runs once before the first render; what it pushes to `subscriptions` ends with the panel. */
export function setup(ctx: PanelContext): void {
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

export default function Panel() {
  const view = read(state)
  const current = read(config)
  const working = read(busy)
  const result = view.phase === 'ready' ? view.result : null
  const items = result?.items ?? []

  return (
    <Stack gap="md">
      <Row justify="between" align="start">
        <Stack gap="none">
          <Heading level={2}>TAPD 待办</Heading>
          <Text muted size="xs">
            {result?.workspaceName
              ? `${result.workspaceName} · ${result.owner}`
              : '按 TAPD 当前处理人筛选'}
          </Text>
        </Stack>
        <IconButton
          icon="refresh"
          label="刷新"
          variant="ghost"
          disabled={working}
          onPress={() => void refresh()}
        />
      </Row>

      {result && result.counts.length > 0 ? (
        <Row gap="xs" wrap>
          {result.counts.map((count) => (
            <Badge
              key={count.status}
              tone={count.status === 'resolved' || count.status === 'verified' ? 'success' : 'neutral'}
            >
              {`${count.label} ${count.count}`}
            </Badge>
          ))}
        </Row>
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
              在下方「配置」里填 TAPD 项目 ID 和负责人，保存后就会按当前处理人读取缺陷。
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
          title="没有未关闭的缺陷"
          description={`${result.owner} 在项目 ${result.workspaceId} 下没有被指派的缺陷。`}
        />
      ) : null}

      {result?.ok && items.length > 0 ? (
        <List label="TAPD 缺陷">
          {items.map((item) => (
            <ListItem
              key={item.id}
              icon="bug"
              title={item.title}
              description={`${item.statusLabel} · ${item.priorityLabel} · ${item.modified}`}
              onPress={() => void host.call('shell.openExternal', { url: item.link })}
            />
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
  )
}