// `orca plugin test .` runs this in Node with the same runtime and checks Orca uses.
import { assert, mockHost, mount, test, type MockHost } from 'orca/testing'
import type { TapdDetailResult, TapdListResult } from './protocol'
import * as panel from './panel'

const READY: TapdListResult = {
  ok: true,
  workspaceId: '12345678',
  workspaceName: '示例项目',
  owner: '测试用户',
  onlyOpen: true,
  hasToken: true,
  fetchedAt: Date.parse('2026-11-26T16:30:00+08:00'),
  items: [
    {
      kind: 'bug',
      id: '1112345678001000513',
      title: '示例缺陷：页面一直加载中',
      status: 'resolved',
      statusLabel: '已解决',
      priority: 'medium',
      priorityLabel: '中',
      created: '2026-11-26 16:02:59',
      modified: '2026-11-26 16:24:01',
      modifiedAt: Date.parse('2026-11-26T16:24:01+08:00'),
      link: 'https://www.tapd.cn/12345678/bugtrace/bugs/view/1112345678001000513',
      owner: '测试用户'
    },
    {
      kind: 'story',
      id: '1112345678001001019',
      title: '示例需求：视频消息增加独立 loading',
      status: 'status_2',
      statusLabel: '产品体验',
      priority: '3',
      priorityLabel: '中',
      created: '2026-11-26 10:17:59',
      modified: '2026-11-26 16:17:19',
      modifiedAt: Date.parse('2026-11-26T16:17:19+08:00'),
      link: 'https://www.tapd.cn/12345678/prong/stories/view/1112345678001001019',
      owner: '测试用户'
    },
    {
      kind: 'bug',
      id: '1112345678001000506',
      title: '示例缺陷：按钮无响应',
      status: 'new',
      statusLabel: '新',
      priority: 'urgent',
      priorityLabel: '紧急',
      created: '2026-11-26 08:40:55',
      modified: '2026-11-26 09:26:52',
      modifiedAt: Date.parse('2026-11-26T09:26:52+08:00'),
      link: 'https://www.tapd.cn/12345678/bugtrace/bugs/view/1112345678001000506',
      owner: '测试用户'
    },
    {
      kind: 'story',
      id: '1112345678001000847',
      title: '示例需求：导出失败',
      status: 'planning',
      statusLabel: '规划中',
      priority: '4',
      priorityLabel: '高',
      created: '2026-11-19 16:51:42',
      modified: '2026-11-26 07:14:53',
      modifiedAt: Date.parse('2026-11-26T07:14:53+08:00'),
      link: 'https://www.tapd.cn/12345678/prong/stories/view/1112345678001000847',
      owner: '测试用户'
    }
  ],
  counts: [
    { kind: 'bug', status: 'resolved', label: '已解决', count: 1 },
    { kind: 'story', status: 'status_2', label: '产品体验', count: 1 },
    { kind: 'bug', status: 'new', label: '新', count: 1 },
    { kind: 'story', status: 'planning', label: '规划中', count: 1 }
  ],
  openCount: 4
}

const NO_TOKEN: TapdListResult = {
  ...READY,
  ok: false,
  reason: 'no_token',
  hasToken: false,
  items: [],
  counts: [],
  workspaceName: '',
  fetchedAt: 0
}

const BUG_DETAIL: TapdDetailResult = {
  ok: true,
  title: '示例缺陷：页面一直加载中',
  kind: 'bug',
  status: 'resolved',
  statusLabel: '已解决',
  priority: 'medium',
  priorityLabel: '中',
  owner: '测试用户',
  creator: '另一位用户',
  created: '2026-11-26 16:02:59',
  modified: '2026-11-26 16:24:01',
  link: 'https://www.tapd.cn/12345678/bugtrace/bugs/view/1112345678001000513',
  description: '问题描述\n页面一直加载中 影响使用',
  comments: [{ author: '测试用户', created: '2026-11-26 16:24:01', text: '收到&处理中' }]
}

const STORY_DETAIL: TapdDetailResult = {
  ...BUG_DETAIL,
  title: '示例需求：视频消息增加独立 loading',
  kind: 'story',
  status: 'status_2',
  statusLabel: '产品体验',
  priority: '3',
  link: 'https://www.tapd.cn/12345678/prong/stories/view/1112345678001001019',
  description: '需求说明\n视频加载完再允许打开'
}

function detailFor(input: unknown): TapdDetailResult {
  const kind = (input as { kind?: string } | undefined)?.kind
  return kind === 'story' ? STORY_DETAIL : BUG_DETAIL
}

function readyHost(settings: Record<string, unknown> = {}): MockHost {
  return mockHost({
    requests: {
      'tapd.list': () => READY,
      'tapd.detail': detailFor
    },
    settings: {
      workspaceId: '12345678',
      owner: '测试用户',
      onlyOpen: true,
      dispatchWorkspace: 'path:/Users/you/projects/your-repo',
      ...settings
    }
  })
}

test('lists bugs and stories with type and status badges', async () => {
  const view = await mount(panel, { host: readyHost() })

  assert.equal(view.findAll({ type: 'ListItem' }).length, 4)
  assert.match(view.find({ type: 'Heading' })?.text ?? '', /TAPD 待办/)
  assert.ok(view.find({ text: /示例项目 · 测试用户/ }))
  assert.ok(view.find({ text: /未关闭 4 条/ }))

  const badges = view.findAll({ type: 'Badge' }).map((badge) => badge.text)
  assert.ok(badges.includes('缺陷'))
  assert.ok(badges.includes('需求'))
  assert.ok(badges.includes('已解决'))
  assert.ok(badges.includes('产品体验'))

  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('stacks type, status, priority and keyword filters', async () => {
  const view = await mount(panel, { host: readyHost() })

  await view.select({ label: '类型' }, 'bug')
  assert.equal(view.findAll({ type: 'ListItem' }).length, 2)
  await view.select({ label: '状态' }, '新')
  assert.equal(view.findAll({ type: 'ListItem' }).length, 1)
  await view.select({ label: '优先级' }, '紧急')
  assert.equal(view.findAll({ type: 'ListItem' }).length, 1)

  await view.type({ label: '关键字' }, '按钮')
  assert.equal(view.findAll({ type: 'ListItem' }).length, 1)
  assert.ok(view.find({ text: /示例缺陷：按钮无响应/ }))

  await view.type({ label: '关键字' }, '不存在的标题', { replace: true })
  assert.equal(view.findAll({ type: 'ListItem' }).length, 0)
  assert.ok(view.find({ text: /没有匹配的待办/ }))

  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('status chips filter by kind and status, toggle off, and clear with 全部', async () => {
  const view = await mount(panel, { host: readyHost() })

  await view.press({ text: '已解决 1' })
  assert.equal(view.findAll({ type: 'ListItem' }).length, 1)
  assert.ok(view.find({ text: /示例缺陷：页面一直加载中/ }))
  assert.equal(view.valueOf({ label: '类型' }), 'bug')
  assert.equal(view.valueOf({ label: '状态' }), '已解决')
  assert.equal(view.find({ text: '已解决 1', type: 'Button' })?.props['variant'], 'solid')
  assert.equal(view.find({ text: '全部', type: 'Button' })?.props['variant'], 'ghost')

  // Clicking the same chip clears only the status; the kind stays on bug.
  await view.press({ text: '已解决 1' })
  assert.equal(view.findAll({ type: 'ListItem' }).length, 2)
  assert.equal(view.valueOf({ label: '状态' }), 'all')
  assert.equal(view.valueOf({ label: '类型' }), 'bug')
  assert.equal(view.find({ text: '已解决 1', type: 'Button' })?.props['variant'], 'ghost')

  await view.press({ text: '全部', type: 'Button' })
  assert.equal(view.findAll({ type: 'ListItem' }).length, 4)
  assert.equal(view.valueOf({ label: '类型' }), 'all')
  assert.equal(view.valueOf({ label: '状态' }), 'all')
  assert.equal(view.find({ text: '全部', type: 'Button' })?.props['variant'], 'solid')

  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('opens a work item in-panel, then returns to the list', async () => {
  const host = readyHost()
  const view = await mount(panel, { host })

  await view.press({ text: /示例缺陷：页面一直加载中/ })
  assert.equal(view.findAll({ type: 'ListItem' }).length, 0)
  assert.equal(view.find({ type: 'Markdown' })?.props['content'], '问题描述\n页面一直加载中 影响使用')
  assert.ok(view.find({ text: /另一位用户/ }))
  assert.ok(view.find({ text: /收到&处理中/ }))

  await view.press({ text: '在 TAPD 打开' })
  const openCall = host.calls.find((call) => call.method === 'shell.openExternal')
  assert.ok(openCall)
  const params = openCall.params
  assert.ok(params && typeof params === 'object' && 'url' in params)
  assert.equal(params.url, BUG_DETAIL.link)

  await view.press({ text: /返回列表/ })
  assert.equal(view.findAll({ type: 'ListItem' }).length, 4)

  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('dispatches from the detail view and shows the session', async () => {
  let dispatchedWith: unknown = null
  const host = mockHost({
    requests: {
      'tapd.list': () => READY,
      'tapd.detail': detailFor,
      'tapd.dispatch': (input) => {
        dispatchedWith = input
        return { ok: true, sessionId: 'abcdef12-3456-7890' }
      }
    },
    settings: {
      workspaceId: '12345678',
      owner: '测试用户',
      onlyOpen: true,
      dispatchWorkspace: 'path:/Users/you/projects/your-repo'
    }
  })
  const view = await mount(panel, { host })

  await view.press({ text: /示例需求：视频消息增加独立 loading/ })
  await view.settled()
  const idleButton = view.find({ text: '一键派单', type: 'Button' })
  assert.ok(idleButton)
  assert.equal(idleButton.disabled, false)
  await view.press({ text: '一键派单' })

  assert.deepEqual(dispatchedWith, {
    kind: 'story',
    id: '1112345678001001019',
    title: '示例需求：视频消息增加独立 loading',
    link: 'https://www.tapd.cn/12345678/prong/stories/view/1112345678001001019'
  })
  assert.ok(view.find({ text: /已派单/ }))
  assert.ok(view.find({ text: /abcdef12/ }))
  const button = view.find({ text: '已派单', type: 'Button' })
  assert.ok(button)
  assert.equal(button.disabled, true)

  const dispatchCall = host.calls.find(
    (call) => call.method === 'plugin.request' && (call.params as { name?: string }).name === 'tapd.dispatch'
  )
  assert.ok(dispatchCall)
  assert.equal((dispatchCall.params as { timeoutMs?: number }).timeoutMs, 120_000)

  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('warns and disables dispatch when no target workspace is configured', async () => {
  const view = await mount(panel, { host: readyHost({ dispatchWorkspace: '' }) })

  await view.press({ text: /示例缺陷：页面一直加载中/ })
  await view.settled()

  assert.ok(view.find({ text: /未配置派单目标工作区/ }))
  assert.ok(
    view.find({ text: /Settings → Plugins → TAPD 待办 → 派单目标工作区/ })
  )
  assert.equal(view.find({ type: 'Callout' })?.props['tone'], 'warning')
  const button = view.find({ text: '一键派单', type: 'Button' })
  assert.ok(button)
  assert.equal(button.disabled, true)

  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('shows the worker CLI error verbatim when dispatch fails', async () => {
  const host = mockHost({
    requests: {
      'tapd.list': () => READY,
      'tapd.detail': detailFor,
      'tapd.dispatch': () => ({
        ok: false,
        message:
          '派单失败：selector_not_found: selector_not_found；selector: path:/nonexistent；validSelectorForms: path:<absolute-path>; name:<display-name>'
      })
    },
    settings: {
      workspaceId: '12345678',
      owner: '测试用户',
      onlyOpen: true,
      dispatchWorkspace: 'path:/nonexistent'
    }
  })
  const view = await mount(panel, { host })

  await view.press({ text: /示例缺陷：页面一直加载中/ })
  await view.settled()
  await view.press({ text: '一键派单' })

  assert.ok(view.find({ text: /selector_not_found/ }))
  assert.ok(view.find({ text: /validSelectorForms/ }))
  assert.ok(view.find({ text: /path:\/nonexistent/ }))
  assert.equal(view.find({ text: '已派单' }), null)

  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('shows 已派单 when the item was dispatched in an earlier run', async () => {
  const host = mockHost({
    requests: { 'tapd.list': () => READY, 'tapd.detail': detailFor },
    settings: {
      workspaceId: '12345678',
      owner: '测试用户',
      onlyOpen: true,
      dispatchWorkspace: 'path:/Users/you/projects/your-repo'
    },
    storage: {
      'dispatched:bug:1112345678001000513': { sessionId: 'old-session-1', at: 1 }
    }
  })
  const view = await mount(panel, { host })

  await view.press({ text: /示例缺陷：页面一直加载中/ })
  await view.settled()
  const button = view.find({ text: '已派单', type: 'Button' })
  assert.ok(button)
  assert.equal(button.disabled, true)
  assert.ok(view.find({ text: /old-sess/ }))

  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('refreshes on tapd.changed unless a detail is open', async () => {
  let lists = 0
  const host = mockHost({
    requests: {
      'tapd.list': () => {
        lists += 1
        return READY
      },
      'tapd.detail': detailFor
    },
    settings: { workspaceId: '12345678', owner: '测试用户', onlyOpen: true }
  })
  const view = await mount(panel, { host })
  assert.equal(lists, 1)

  await view.post('tapd.changed', { fetchedAt: Date.now(), openCount: 7 })
  assert.equal(lists, 2)
  // The refresh wins: the header shows the counts the worker just answered with.
  assert.ok(view.find({ text: /未关闭 4 条/ }))

  await view.press({ text: /示例缺陷：页面一直加载中/ })
  const before = lists
  await view.post('tapd.changed', { fetchedAt: Date.now(), openCount: 9 })
  assert.equal(lists, before)
  assert.ok(view.find({ text: /未关闭 9 条/ }))

  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('asks for a token, stores it in secrets, then reads the list', async () => {
  let host: MockHost
  host = mockHost({
    requests: {
      'tapd.list': () => (host.data().secrets['token'] ? READY : NO_TOKEN),
      'tapd.detail': detailFor
    },
    settings: { workspaceId: '12345678', owner: '测试用户', onlyOpen: true }
  })
  const view = await mount(panel, { host })

  assert.match(view.find({ type: 'Callout' })?.text ?? '', /还没有配置 TAPD 令牌/)
  assert.deepEqual(view.findAll({ type: 'ListItem' }), [])

  await view.type({ label: '访问令牌' }, 'tapd-personal-token')
  await view.press({ text: '保存并读取' })

  assert.equal(host.data().secrets['token'], 'tapd-personal-token')
  assert.equal(view.findAll({ type: 'ListItem' }).length, 4)
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})