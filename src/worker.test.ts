// Runs src/worker.ts's activate(orca) with the orca object Orca passes, over a mock host.
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import * as main from './worker'

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

const WORKSPACE = { status: 1, data: { Workspace: { id: '12345678', name: '示例项目' } } }

const realFetch = globalThis.fetch

function stubFetch(answer: (url: string) => { body: unknown; status?: number }): string[] {
  const urls: string[] = []
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input)
    urls.push(url)
    const { body, status } = answer(url)
    return new Response(JSON.stringify(body), { status: status ?? 200 })
  }) as typeof fetch
  return urls
}

test('lists bugs assigned to me, newest change first', async () => {
  const urls = stubFetch((url) =>
    url.includes('/bugs') ? { body: BUGS } : { body: WORKSPACE }
  )
  try {
    const host = mockHost({
      settings: { workspaceId: '12345678', owner: '测试用户', onlyOpen: true, limit: 50 },
      secrets: { token: 'test-token' }
    })
    const worker = await mountWorker(main, { host })
    const result = await worker.request('tapd.list', {})

    assert.equal(result.ok, true)
    assert.equal(result.workspaceName, '示例项目')
    assert.equal(result.items.length, 2)
    assert.equal(result.items[0]?.statusLabel, '已解决')
    assert.equal(result.items[0]?.priorityLabel, '中')
    assert.equal(
      result.items[0]?.modifiedAt,
      Date.parse('2026-11-26T16:24:01+08:00')
    )
    assert.match(result.items[0]?.link ?? '', /^https:\/\/www\.tapd\.cn\/12345678\/bugtrace\/bugs\/view\//)
    assert.deepEqual(result.counts, [
      { status: 'resolved', label: '已解决', count: 1 },
      { status: 'new', label: '新', count: 1 }
    ])

    const bugsUrl = new URL(urls.find((url) => url.includes('/bugs?')) ?? '')
    assert.equal(bugsUrl.searchParams.get('current_owner'), '测试用户')
    assert.equal(bugsUrl.searchParams.get('status'), '!=closed')
    assert.equal(bugsUrl.searchParams.get('limit'), '50')
    assert.deepEqual(worker.refusals, [])
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
  stubFetch(() => ({ body: { status: 401, info: 'token invalid' }, status: 401 }))
  try {
    const worker = await mountWorker(main, {
      host: mockHost({
        settings: { workspaceId: '12345678', owner: '测试用户' },
        secrets: { token: 'bad' }
      })
    })
    const result = await worker.request('tapd.list', {})
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'api_error')
    assert.match(result.message ?? '', /401/)
    await worker.deactivate()
  } finally {
    globalThis.fetch = realFetch
  }
})