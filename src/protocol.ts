// The panel <-> worker contract, declared once: src/panel.tsx and src/worker.ts both read it.

/** TAPD 的工作项类型：缺陷或需求。 */
export type TapdKind = 'bug' | 'story'

/** One TAPD work item (bug or story), already normalized for drawing. */
export type TapdItem = {
  kind: TapdKind
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
  /** 当前处理人；需求可能有多人，以分号分隔。 */
  owner: string
}

/** 按类型 + 状态聚合的条数，面板直接显示。 */
export type TapdStatusCount = { kind: TapdKind; status: string; label: string; count: number }

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
  /** Work items not in their kind's terminal status (bugs: closed/rejected; stories:
   *  resolved/rejected/closed/done); the status bar shows this number. */
  openCount: number
}

export type TapdComment = { author: string; created: string; text: string }

/** One Orca workspace the person can dispatch to. */
export type TapdWorkspaceOption = {
  /** What `orca agent launch --worktree` takes: `path:<absolute-path>`. */
  selector: string
  /** Workspace name, else the path's last segment. */
  label: string
  /** Full path, shown after the label so same-named workspaces stay distinguishable. */
  detail: string
  kind: string
  hostId: string
}

export type TapdWorkspaceError = { code: string; message: string }

export type TapdWorkspacesResult = {
  workspaces: TapdWorkspaceOption[]
  /** Remembered dispatch selector: storage for this TAPD project, then the default setting. */
  target: string
  /** Set when Orca's workspace.list failed; workspaces is then empty. */
  error?: TapdWorkspaceError
}

export type TapdDetail = {
  title: string
  kind: TapdKind
  status: string
  statusLabel: string
  priority: string
  priorityLabel: string
  owner: string
  creator: string
  created: string
  modified: string
  link: string
  /** Markdown/plain text; TAPD's HTML descriptions are flattened first. */
  description: string
  comments: TapdComment[]
}

export type TapdDetailResult = ({ ok: true } & TapdDetail) | { ok: false; message: string }

export type TapdDispatchResult = {
  ok: boolean
  message?: string
  /** The Orca agent session the work item was dispatched to. */
  sessionId?: string
  /** True when an earlier dispatch was remembered and the CLI was not called again. */
  reused?: boolean
}

export {}

declare module 'orca' {
  interface PluginRequests {
    /** Reads the configured TAPD project and answers its bugs and stories, newest change first. */
    'tapd.list': { input: { force?: boolean } | undefined; output: TapdListResult }
    /** Full fields, flattened description and comments for one work item. */
    'tapd.detail': { input: { kind: TapdKind; id: string }; output: TapdDetailResult }
    /** Orca workspaces this person can dispatch to, plus the remembered selector. */
    'tapd.workspaces': { input: { force?: boolean } | undefined; output: TapdWorkspacesResult }
    /** Launches an Orca agent for one work item in the chosen workspace. */
    'tapd.dispatch': {
      input: {
        kind: TapdKind
        id: string
        title: string
        link: string
        /** Chosen in the detail view; falls back to the project's remembered selector. */
        workspace?: string
      }
      output: TapdDispatchResult
    }
  }
  interface PluginPanelEvents {
    /** Sent after every successful poll; open panels refresh unless the person is reading details. */
    'tapd.changed': { fetchedAt: number; openCount: number }
  }
}