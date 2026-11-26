// `orca plugin test .` runs this in Node with the same runtime and checks Orca uses.
import { assert, mockHost, mount, test, type MockHost } from 'orca/testing'
import type { TapdListResult } from './protocol'
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
      id: '1112345678001000513',
      title: '示例缺陷：页面一直加载中',
      status: 'resolved',
      statusLabel: '已解决',
      priority: 'medium',
      priorityLabel: '中',
      created: '2026-11-26 16:02:59',
      modified: '2026-11-26 16:24:01',
      modifiedAt: Date.parse('2026-11-26T16:24:01+08:00'),
      link: 'https://www.tapd.cn/12345678/bugtrace/bugs/view/1112345678001000513'
    },
    {
      id: '1112345678001000506',
      title: '示例项目查询筛选条件缺失',
      status: 'new',
      statusLabel: '新',
      priority: 'urgent',
      priorityLabel: '紧急',
      created: '2026-11-26 08:40:55',
      modified: '2026-11-26 09:26:52',
      modifiedAt: Date.parse('2026-11-26T09:26:52+08:00'),
      link: 'https://www.tapd.cn/12345678/bugtrace/bugs/view/1112345678001000506'
    }
  ],
  counts: [
    { status: 'resolved', label: '已解决', count: 1 },
    { status: 'new', label: '新', count: 1 }
  ]
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

test('lists the bugs the worker returns and opens one on a row action', async () => {
  const host = mockHost({
    requests: { 'tapd.list': () => READY },
    settings: { workspaceId: '12345678', owner: '测试用户', onlyOpen: true }
  })
  const view = await mount(panel, { host })

  assert.equal(view.findAll({ type: 'ListItem' }).length, 2)
  assert.match(view.find({ type: 'Heading' })?.text ?? '', /TAPD 待办/)
  assert.ok(view.find({ text: /示例项目 · 测试用户/ }))

  await view.press({ text: /示例缺陷：页面/ })
  const openCall = host.calls.find((call) => call.method === 'shell.openExternal')
  assert.ok(openCall)
  const params = openCall.params
  assert.ok(params && typeof params === 'object' && 'url' in params)
  assert.equal(params.url, READY.items[0]?.link)

  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('asks for a token, stores it in secrets, then reads the list', async () => {
  let host: MockHost
  host = mockHost({
    requests: {
      'tapd.list': () => (host.data().secrets['token'] ? READY : NO_TOKEN)
    },
    settings: { workspaceId: '12345678', owner: '测试用户', onlyOpen: true }
  })
  const view = await mount(panel, { host })

  assert.match(view.find({ type: 'Callout' })?.text ?? '', /还没有配置 TAPD 令牌/)
  assert.deepEqual(view.findAll({ type: 'ListItem' }), [])

  await view.type({ label: '访问令牌' }, 'tapd-personal-token')
  await view.press({ text: '保存并读取' })

  assert.equal(host.data().secrets['token'], 'tapd-personal-token')
  assert.equal(view.findAll({ type: 'ListItem' }).length, 2)
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})