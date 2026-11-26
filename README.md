# TAPD 待办 · Orca plugin

在 [Orca](https://www.onorca.dev) 右侧栏查看指派给你的 TAPD 缺陷（bug）和需求（story），
筛选后可直接读详情，并把单子一键派给 Orca agent。

- **缺陷 + 需求**：并行读取两类工作项，按 `modified desc` 合并排序；缺陷红色、需求蓝色区分
- **多条件筛选**：类型 / 状态 / 优先级 / 标题关键字，全部叠加
- **插件内详情**：状态、优先级、处理人、创建人、时间、Markdown 描述和评论；保留「在 TAPD 打开」
- **状态栏常驻**：`TAPD N`（N = 未关闭待办数），worker 按设置的间隔轮询更新
- **一键派单**：把单号、标题、链接、状态、优先级和描述摘要组成 prompt，用 Orca CLI 在**已存在的**
  目标工作区启动 agent（不建 worktree，不等待结果），返回 `sessionId`
- **令牌安全**：TAPD 个人访问令牌只存在本机 Orca 插件的加密 secrets，不进设置、不进仓库
- **唯一外联**：`https://api.tapd.cn`

## 安装

市场收录页：`https://www.onorca.dev/plugins/li363920783/orca-tapd-todo`

或直接：

```bash
orca plugin install li363920783/orca-tapd-todo
```

它按 `trusted-worker` 运行：Orca 会先列出它要的权限（发起网络请求、插件自己的
storage/secrets/settings），确认指纹后加 `--approve <fingerprint>` 再执行一次。

本地开发/文件夹安装：

```bash
git clone https://github.com/li363920783/orca-tapd-todo.git
cd orca-tapd-todo
orca plugin dev load .
```

状态栏条目与 `>=1.4.248` 的 Orca 桌面版配合；旧版 Orca 只会加载面板。

## 配置

1. 在 TAPD「个人设置 → 安全设置 → 个人访问令牌」创建令牌。
2. 打开右栏「TAPD 待办」，首次会提示先配置：填 TAPD 项目 ID（TAPD 地址里的数字，如 `12345678`）
   和负责人姓名，保存。
3. 粘贴令牌 → 「保存并读取」。令牌写进插件 secrets。
4. 也可以在 Orca `Settings → Plugins → TAPD 待办` 里改这些设置。

| 设置 | 默认 | 说明 |
|---|---|---|
| `workspaceId` | 空 | TAPD 项目 ID；负责人按「当前处理人」精确匹配，多人用分号分隔 |
| `owner` | 空 | 负责人姓名；缺陷查 `current_owner`，需求查 `owner` |
| `onlyOpen` | `true` | 拉取用 `status != closed`，再按类型终态过滤：缺陷排除 `closed`/`rejected`，需求排除 `resolved`/`rejected`/`closed`/`done` |
| `limit` | `100` | 合并后的最多显示条数（1–200）；每类最多从 TAPD 拉 200 条 |
| `pollMinutes` | `5` | 状态栏轮询间隔（1–60 分钟） |
| `dispatchWorkspace` | 空 | 派单目标工作区选择器，如 `path:/root/projects/your-repo` |
| `dispatchAgent` | `claude` | 已安装的 Orca agent 名称 |
| `dispatchModel` | 空 | 可选，传给 `orca agent launch --model` |

## 状态栏

插件启用后 worker 常驻：立即算一次未关闭数，然后按 `pollMinutes` 轮询。状态栏显示 `TAPD N`（N 按上述终态集合排除），
有未关闭时用 warning 色；未配置项目/负责人/令牌时显示 `TAPD –`。轮询失败只写插件日志
（`orca plugin logs`），不会让 worker 退出，下一轮继续。

每次成功轮询还会向打开的 panel 发 `tapd.changed`：列表页静默刷新；正在读详情时只更新顶部
未关闭计数，不打断阅读。关闭面板不影响状态栏轮询。

## 一键派单

前置条件：

- 目标工作区**必须已经在 Orca 中存在**（不会自动新建 worktree）；
- `dispatchWorkspace` 填的是 `orca agent launch --worktree` 接受的选择器：
  `path:/...`、`name:<显示名>`、`branch:<分支>`、`active` 等；
- 目标 agent 已在这台 Orca 上安装，并支持以 chat 方式启动。

派单会读取该单详情，生成固定格式的中文 prompt（单号 / 类型 / 标题 / 链接 / 状态 / 优先级 /
描述摘要，并注明「先只读排查，给出根因和修复方案；不要直接改生产数据」），然后执行：

```bash
orca agent launch --agent <agent> --worktree <workspace> --prompt <prompt> --surface chat --json
# 配置了 dispatchModel 时追加：--model <model>
```

CLI 二进制取 `ORCA_CLI_COMMAND` 环境变量，未设置时用 `orca`。成功时把
`result.outcome.sessionId` 返回给面板，并在插件 storage 里记下
`dispatched:<kind>:<id>`；同一单重复点击不会再次启动 agent，详情页按钮显示「已派单」。
失败时把 CLI 的 stderr/stdout 原文显示在 panel 里。

## 权限说明

| 权限 | 用途 |
|---|---|
| `storage:own` | 状态标签缓存、已派单记录 |
| `secrets:own` | 加密保存 TAPD 个人访问令牌 |
| `settings:own` | 读写项目 ID、负责人、轮询和派单设置 |

Worker 是独立 Node 进程，以你的用户身份运行；除了 `api.tapd.cn` 和本机 `orca` CLI 不发任何请求。

## 令牌安全

- 令牌只写进 Orca 插件的加密 secrets（`secrets:own`），不写设置、不写 storage、不进 git。
- 请求统一放 `Authorization: Bearer <token>` 头；TAPD 拒绝把令牌拼在 URL 上。
- 怀疑泄漏时在 TAPD「个人设置 → 安全设置 → 个人访问令牌」吊销重建，再在面板里重新保存。
- 报告问题时不要粘贴令牌；本仓库的测试夹具只用 `12345678` / `测试用户` 这类假数据。

## 已知限制

- `status_map` 结构按实测的扁平 `{ status: 中文名 }` 解析；若 TAPD 改结构或自定义状态缺失，
  面板原样显示 status 值。
- 评论只取第一页 50 条，未做分页。
- 描述里的附件只保留链接文字，不下载/预览附件。
- 状态颜色按固定状态名映射；TAPD 自定义状态（如 `status_2`）显示为 neutral。
- `--surface chat` 被 Orca 拒绝并回退到终端时没有 `sessionId`，派单会返回失败并显示 CLI 原文。

## 开发

```bash
tsc -p .             # 类型检查（需全局 TypeScript）
orca plugin test .   # 面板 + worker 单测
orca plugin check .  # 无头渲染面板，打印元素树
orca plugin validate .
orca plugin types .  # 生成 .orca/types（dev load 也会做）
```

不要在本目录 `npm install`：`node_modules/.bin` 里的符号链接会让插件内容校验失败。

## English

View TAPD bugs and stories assigned to you in Orca's right sidebar. The plugin merges both kinds
newest-change-first, filters by type/status/priority/keyword, shows full details with comments in
the panel, keeps a `TAPD N` status-bar item updated by polling, and can dispatch one item to an
existing Orca workspace with `orca agent launch --surface chat` (no new worktree, returns the
session id). The TAPD personal access token is stored only in the plugin's encrypted secrets.

## License

MIT