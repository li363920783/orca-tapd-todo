// Runs src/worker.ts's activate(orca) with the orca object Orca passes, over a mock host.
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import * as main from './worker'

// The status-bar poll would otherwise race these fetch stubs with an initial tick.
main.setPollingEnabled(false)

const STATUS_BUG = {
  status: 1,
  data: { new: '新', in_progress: '处理中', resolved: '已解决', reopened: '重新打开', closed: '已关闭' }
}

const STATUS_STORY = {
  status: 1,
  data: {
    planning: '规划中',
    developing: '开发中',
    resolved: '已实现',
    rejected: '已拒绝',
    status_2: '产品体验',
    closed: '已关闭'
  }
}

const WORKSPACE = { status: 1, data: { Workspace: { id: '12345678', name: '示例项目' } } }

const BUGS = {
  status: 1,
  data: [
    {
      Bug: {
        id: '1112345678001000513',
        title: '示例缺陷：页面一直加载中',
        status: 'resolved',
        priority: 'medium',
        created: '2026-11-26 16:02:59',
        modified: '2026-11-26 16:24:01',
        current_owner: '测试用户'
      }
    },
    {
      Bug: {
        id: '1112345678001000506',
        title: '示例项目查询筛选条件缺失',
        status: 'new',
        priority: 'urgent',
        created: '2026-11-26 08:40:55',
        modified: '2026-11-26 09:26:52',
        current_owner: '测试用户'
      }
    }
  ]
}

const STORIES = {
  status: 1,
  data: [
    {
      Story: {
        id: '1112345678001000847',
        name: '示例需求：商品售出后总量保持不变',
        status: 'rejected',
        priority: '4',
        priority_label: 'High',
        created: '2026-11-19 16:51:42',
        modified: '2026-11-26 17:14:53',
        owner: '测试用户;'
      }
    },
    {
      Story: {
        id: '1112345678001001019',
        name: '示例需求：视频消息增加独立 loading',
        status: 'status_2',
        priority: '3',
        priority_label: 'Middle',
        created: '2026-11-26 10:17:59',
        modified: '2026-11-26 16:17:19',
        owner: '测试用户;'
      }
    }
  ]
}

const BUG_DETAIL = {
  status: 1,
  data: [
    {
      Bug: {
        id: '1112345678001000513',
        title: '示例缺陷：页面一直加载中',
        status: 'resolved',
        priority: 'medium',
        created: '2026-11-26 16:02:59',
        modified: '2026-11-26 16:24:01',
        current_owner: '测试用户',
        creator: '另一位用户',
        description:
          '<h2>问题描述</h2><p>页面一直加载中&nbsp;影响使用</p><ul><li>打开页面</li><li>等待</li></ul>',
        description_type: ''
      }
    }
  ]
}

const COMMENTS = {
  status: 1,
  data: [
    {
      Comment: {
        author: '测试用户',
        created: '2026-11-26 16:24:01',
        description: '<p>收到&amp;处理中</p>'
      }
    }
  ]
}

const realFetch = globalThis.fetch

type StubAnswer = (url: URL) => { body: unknown; status?: number }

function stubFetch(answer: StubAnswer): string[] {
  const urls: string[] = []
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input)
    urls.push(url)
    const { body, status } = answer(new URL(url))
    return new Response(JSON.stringify(body), { status: status ?? 200 })
  }) as typeof fetch
  return urls
}

/** Answers every TAPD endpoint the worker may call for the two item fixtures. */
function tapdAnswer(url: URL): { body: unknown; status?: number } {
  if (url.pathname.endsWith('/workflows/status_map')) {
    return { body: url.searchParams.get('system') === 'bug' ? STATUS_BUG : STATUS_STORY }
  }
  if (url.pathname.endsWith('/workspaces/get_workspace_info')) return { body: WORKSPACE }
  if (url.pathname.endsWith('/bugs')) {
    return { body: url.searchParams.has('id') ? BUG_DETAIL : BUGS }
  }
  if (url.pathname.endsWith('/stories')) return { body: STORIES }
  if (url.pathname.endsWith('/comments')) return { body: COMMENTS }
  return { body: { status: 1, data: [] } }
}

function contextHost() {
  return mockHost({
    settings: {
      workspaceId: '12345678',
      owner: '测试用户',
      onlyOpen: true,
      limit: 50,
      dispatchWorkspace: 'path:/root/projects/demo',
      dispatchAgent: 'claude',
      dispatchModel: 'model-x'
    },
    secrets: { token: 'test-token' }
  })
}

test('updates the status bar and posts tapd.changed on the first poll', async () => {
  stubFetch(tapdAnswer)
  main.setPollingEnabled(true)
  try {
    const host = contextHost()
    const worker = await mountWorker(main, { host })
    for (let attempt = 0; attempt < 1000 && worker.posts.length === 0; attempt += 1) {
      await Promise.resolve()
    }

    const statusCalls = host.callsOf('statusBar.update')
    assert.equal(statusCalls.length, 1)
    assert.deepEqual(statusCalls[0], {
      id: 'tapd-pending',
      text: 'TAPD 4',
      tone: 'warning',
      tooltip: '未关闭 4 条'
    })
    assert.equal(worker.posts.length, 1)
    assert.equal(worker.posts[0]?.event, 'tapd.changed')
    const payload = worker.posts[0]?.payload as { openCount?: number } | undefined
    assert.equal(payload?.openCount, 4)
    await worker.deactivate()
  } finally {
    main.setPollingEnabled(false)
    globalThis.fetch = realFetch
  }
})

test('merges bugs and stories, newest change first, with status_map labels', async () => {
  const urls = stubFetch(tapdAnswer)
  try {
    const host = contextHost()
    const worker = await mountWorker(main, { host })
    const result = await worker.request('tapd.list', {})

    assert.equal(result.ok, true)
    assert.equal(result.workspaceName, '示例项目')
    assert.equal(result.items.length, 4)
    assert.deepEqual(
      result.items.map((item) => item.kind),
      ['story', 'bug', 'story', 'bug']
    )
    assert.equal(result.items[0]?.title, '示例需求：商品售出后总量保持不变')
    assert.equal(result.items[0]?.statusLabel, '已拒绝')
    assert.equal(result.items[0]?.priorityLabel, '高')
    assert.equal(result.items[2]?.statusLabel, '产品体验')
    assert.equal(result.items[1]?.statusLabel, '已解决')
    assert.equal(result.items[3]?.priorityLabel, '紧急')
    assert.match(
      result.items[0]?.link ?? '',
      /^https:\/\/www\.tapd\.cn\/12345678\/prong\/stories\/view\//
    )
    assert.match(
      result.items[1]?.link ?? '',
      /^https:\/\/www\.tapd\.cn\/12345678\/bugtrace\/bugs\/view\//
    )

    const bugUrl = new URL(urls.find((url) => url.includes('/bugs?')) ?? '')
    assert.equal(bugUrl.searchParams.get('current_owner'), '测试用户')
    assert.equal(bugUrl.searchParams.get('status'), '!=closed')
    assert.equal(bugUrl.searchParams.get('limit'), '200')
    const storyUrl = new URL(urls.find((url) => url.includes('/stories?')) ?? '')
    assert.equal(storyUrl.searchParams.get('owner'), '测试用户')
    assert.equal(storyUrl.searchParams.get('limit'), '200')

    assert.deepEqual(result.counts, [
      { kind: 'story', status: 'rejected', label: '已拒绝', count: 1 },
      { kind: 'bug', status: 'resolved', label: '已解决', count: 1 },
      { kind: 'story', status: 'status_2', label: '产品体验', count: 1 },
      { kind: 'bug', status: 'new', label: '新', count: 1 }
    ])
    assert.deepEqual(worker.refusals, [])
    await worker.deactivate()
  } finally {
    globalThis.fetch = realFetch
  }
})

test('caches status_map for the next list read', async () => {
  const urls = stubFetch(tapdAnswer)
  try {
    const worker = await mountWorker(main, { host: contextHost() })
    await worker.request('tapd.list', {})
    await worker.request('tapd.list', {})
    assert.equal(urls.filter((url) => url.includes('/workflows/status_map')).length, 2)
    await worker.deactivate()
  } finally {
    globalThis.fetch = realFetch
  }
})

test('asks for configuration first when project or owner is unset', async () => {
  const urls = stubFetch(() => ({ body: BUGS }))
  try {
    const worker = await mountWorker(main, { host: mockHost({ settings: {}, secrets: {} }) })
    const result = await worker.request('tapd.list', {})
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'not_configured')
    assert.deepEqual(urls, [])
    await worker.deactivate()
  } finally {
    globalThis.fetch = realFetch
  }
})

test('asks for a token instead of calling TAPD', async () => {
  const urls = stubFetch(() => ({ body: BUGS }))
  try {
    const worker = await mountWorker(main, {
      host: mockHost({
        settings: { workspaceId: '12345678', owner: '测试用户' },
        secrets: {}
      })
    })
    const result = await worker.request('tapd.list', {})
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'no_token')
    assert.equal(result.hasToken, false)
    assert.deepEqual(urls, [])
    await worker.deactivate()
  } finally {
    globalThis.fetch = realFetch
  }
})

test('reports an HTTP error without throwing', async () => {
  stubFetch((url) =>
    url.pathname.endsWith('/bugs')
      ? { body: { status: 401, info: 'token invalid' }, status: 401 }
      : tapdAnswer(url)
  )
  try {
    const worker = await mountWorker(main, { host: contextHost() })
    const result = await worker.request('tapd.list', {})
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'api_error')
    assert.match(result.message ?? '', /401/)
    await worker.deactivate()
  } finally {
    globalThis.fetch = realFetch
  }
})

test('loads a detail with flattened description and comments', async () => {
  stubFetch(tapdAnswer)
  try {
    const worker = await mountWorker(main, { host: contextHost() })
    const result = await worker.request('tapd.detail', {
      kind: 'bug',
      id: '1112345678001000513'
    })

    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.title, '示例缺陷：页面一直加载中')
    assert.equal(result.kind, 'bug')
    assert.equal(result.statusLabel, '已解决')
    assert.equal(result.priorityLabel, '中')
    assert.equal(result.owner, '测试用户')
    assert.equal(result.creator, '另一位用户')
    assert.equal(result.description, '问题描述\n页面一直加载中 影响使用\n- 打开页面\n- 等待')
    assert.deepEqual(result.comments, [
      { author: '测试用户', created: '2026-11-26 16:24:01', text: '收到&处理中' }
    ])
    await worker.deactivate()
  } finally {
    globalThis.fetch = realFetch
  }
})

test('dispatches once, then reuses the stored session', async () => {
  stubFetch(tapdAnswer)
  const calls: { file: string; args: readonly string[] }[] = []
  main.setDispatchExec(async (file, args) => {
    calls.push({ file, args })
    return {
      stdout: JSON.stringify({
        ok: true,
        result: { outcome: { kind: 'structured', sessionId: 'session-abcdef-123456' } }
      }),
      stderr: ''
    }
  })
  try {
    const worker = await mountWorker(main, { host: contextHost() })
    const first = await worker.request('tapd.dispatch', {
      kind: 'bug',
      id: '1112345678001000513',
      title: '示例缺陷：页面一直加载中',
      link: 'https://www.tapd.cn/12345678/bugtrace/bugs/view/1112345678001000513'
    })
    assert.equal(first.ok, true)
    assert.equal(first.sessionId, 'session-abcdef-123456')
    assert.equal(calls.length, 1)

    const args = calls[0]?.args ?? []
    assert.deepEqual(args.slice(0, 6), [
      'agent',
      'launch',
      '--agent',
      'claude',
      '--worktree',
      'path:/root/projects/demo'
    ])
    assert.ok(args.includes('--model'))
    assert.ok(args.includes('model-x'))
    assert.equal(args[args.indexOf('--surface') + 1], 'chat')
    assert.ok(args.includes('--json'))
    const prompt = args[args.indexOf('--prompt') + 1] ?? ''
    assert.match(prompt, /单号：1112345678001000513/)
    assert.match(prompt, /类型：缺陷/)
    assert.match(prompt, /状态：已解决/)
    assert.match(prompt, /优先级：中/)
    assert.match(prompt, /描述摘要：问题描述/)
    assert.match(prompt, /先只读排查，给出根因和修复方案；不要直接改生产数据/)

    const second = await worker.request('tapd.dispatch', {
      kind: 'bug',
      id: '1112345678001000513',
      title: '示例缺陷：页面一直加载中',
      link: 'https://www.tapd.cn/12345678/bugtrace/bugs/view/1112345678001000513'
    })
    assert.equal(second.ok, true)
    assert.equal(second.sessionId, 'session-abcdef-123456')
    assert.equal(second.reused, true)
    assert.equal(calls.length, 1)
    await worker.deactivate()
  } finally {
    main.setDispatchExec(undefined)
    globalThis.fetch = realFetch
  }
})

test('returns the CLI stderr when dispatch fails', async () => {
  stubFetch(tapdAnswer)
  main.setDispatchExec(async () => {
    const error = new Error('exit 1') as Error & { stdout?: string; stderr?: string }
    error.stderr = 'worktree path:/root/projects/demo not found'
    throw error
  })
  try {
    const worker = await mountWorker(main, { host: contextHost() })
    const result = await worker.request('tapd.dispatch', {
      kind: 'bug',
      id: '1112345678001000513',
      title: '示例缺陷：页面一直加载中',
      link: 'https://www.tapd.cn/12345678/bugtrace/bugs/view/1112345678001000513'
    })
    assert.equal(result.ok, false)
    assert.match(result.message ?? '', /worktree path:\/root\/projects\/demo not found/)
    await worker.deactivate()
  } finally {
    main.setDispatchExec(undefined)
    globalThis.fetch = realFetch
  }
})

test('does not call the CLI when the item was dispatched before', async () => {
  stubFetch(tapdAnswer)
  let called = 0
  main.setDispatchExec(async () => {
    called += 1
    return { stdout: '{}', stderr: '' }
  })
  try {
    const host = mockHost({
      settings: { workspaceId: '12345678', owner: '测试用户', dispatchWorkspace: 'path:/demo' },
      secrets: { token: 'test-token' },
      storage: { 'dispatched:bug:1112345678001000513': { sessionId: 'old-session', at: 1 } }
    })
    const worker = await mountWorker(main, { host })
    const result = await worker.request('tapd.dispatch', {
      kind: 'bug',
      id: '1112345678001000513',
      title: '示例缺陷：页面一直加载中',
      link: 'https://www.tapd.cn/12345678/bugtrace/bugs/view/1112345678001000513'
    })
    assert.equal(result.ok, true)
    assert.equal(result.sessionId, 'old-session')
    assert.equal(result.reused, true)
    assert.equal(called, 0)
    await worker.deactivate()
  } finally {
    main.setDispatchExec(undefined)
    globalThis.fetch = realFetch
  }
})