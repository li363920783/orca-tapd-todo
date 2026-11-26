// The panel <-> worker contract, declared once: src/panel.tsx and src/worker.ts both read it.

/** One TAPD 缺陷, already normalized for drawing. */
export type TapdItem = {
  id: string
  title: string
  status: string
  statusLabel: string
  priority: string
  priorityLabel: string
  created: string
  modified: string
  /** Epoch ms; 0 when TAPD sent no usable time. */
  modifiedAt: number
  /** TAPD 详情页, opened in the default browser. */
  link: string
}

export type TapdStatusCount = { status: string; label: string; count: number }

export type TapdListResult = {
  ok: boolean
  /** Why `ok` is false: the project or owner is unset, no token is stored yet, TAPD answered
   *  with an error, or the request failed. */
  reason?: 'not_configured' | 'no_token' | 'api_error' | 'network_error'
  message?: string
  workspaceId: string
  workspaceName: string
  owner: string
  onlyOpen: boolean
  hasToken: boolean
  fetchedAt: number
  items: TapdItem[]
  counts: TapdStatusCount[]
}

export {}

declare module 'orca' {
  interface PluginRequests {
    /** Reads the configured TAPD project and answers its bugs, newest change first. */
    'tapd.list': { input: { force?: boolean } | undefined; output: TapdListResult }
  }
  interface PluginPanelEvents {}
}