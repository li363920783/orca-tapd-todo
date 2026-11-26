# TAPD 待办 · Orca plugin

在 [Orca](https://www.onorca.dev) 右侧栏查看指派给你的 TAPD 缺陷（bug），点一条用默认浏览器打开 TAPD 详情。

- **按当前处理人筛选**：只拉 `current_owner` 是你的缺陷，按 `modified desc` 排序
- **状态统计**：新 / 处理中 / 重新打开 / 已解决 / 已验证 … 一眼看到分布
- **只看未关闭**：可关掉，查看全部历史
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

## 配置

1. 在 TAPD「个人设置 → 安全设置 → 个人访问令牌」创建令牌。
2. 打开右栏「TAPD 待办」，首次会提示先配置：填 TAPD 项目 ID（TAPD 地址里的数字，如 `12345678`）和负责人姓名，保存。
3. 粘贴令牌 → 「保存并读取」。令牌写进插件 secrets。
4. 也可以在 Orca `Settings → Plugins → TAPD 待办` 里改项目、负责人、是否只看未关闭、条数上限（1–200）。

## 权限说明

| 权限 | 用途 |
|---|---|
| `storage:own` | 插件自己的存储 |
| `secrets:own` | 加密保存 TAPD 个人访问令牌 |
| `settings:own` | 读写项目 ID、负责人等设置 |

Worker 是独立 Node 进程，以你的用户身份运行；除了 `api.tapd.cn` 不发任何请求。

## 开发

```bash
tsc -p .             # 类型检查（需全局 TypeScript）
orca plugin test .   # 面板 + worker 单测
orca plugin check .  # 无头渲染面板，打印元素树
orca plugin validate .
orca plugin types .  # 生成 .orca/types（dev load 也会做）
```

不要在本目录 `npm install`：`node_modules/.bin` 里的符号链接会让插件内容校验失败。

## License

MIT