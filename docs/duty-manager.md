# 值班台（manager/）—— 为什么在这里、怎么维护

这个目录是给 `dsh-bili-scroll` 配的**独立管理界面**，不属于上游插件本身，也不会被插件的
升级覆盖：它只通过插件已经暴露的 HTTP 路由和本地文件工作。

## 结构

```
manager/
  server.mjs        # 本地 HTTP 服务（127.0.0.1:3099）：静态页 + 插件接口代理 + 报告/判重表/日志
  public/           # 单页界面：index.html / app.js / style.css / favicon.svg
  start.sh          # 起服务（必要时）并打开浏览器；--server-only 只起服务
  README.md         # 使用说明
```

## 数据流

```
浏览器 (127.0.0.1:3099)
   │  同源请求
   ▼
manager/server.mjs ──► Harness Web (127.0.0.1:3080) /api/bili-duty/*
   │                        status / config / run / login/start / login/poll / report ...
   │
   └──► 插件家目录 ~/.dsh/bili-duty/
           out/*.md（日报）、seen.md（判重表）、duty.log（阶段日志）、bili_credential.json
```

- **不重写业务逻辑**：状态、配置、跑一轮、扫码登录全部转给插件的 `handle()`；
  所以值班台和 DSH 设置页改的是同一份配置。
- 日报、判重表、日志走文件读取，**Harness 没启动时也能看**。
- 服务只监听回环地址，并做与插件一致的「本机同源」校验。

## 接口对照

| 值班台路由 | 去向 |
| --- | --- |
| `GET /api/status`、`/api/report` | 代理插件的同名路由（`status` 额外从日志补 `lastEndAt`） |
| `POST /api/config`、`/api/run`、`/api/login/start`、`/api/login/poll` | 代理 |
| `GET /api/reports`、`/api/report-file?day=` | 读 `~/.dsh/bili-duty/out/` |
| `GET /api/seen` | 解析 `~/.dsh/bili-duty/seen.md` |
| `GET /api/log?lines=` | 读 `duty.log` 尾部（界面默认只显示带时间戳的阶段行） |
| `GET /api/me` | 读 `bili_credential.json` 并请求 `api.bilibili.com/x/web-interface/nav` |
| `GET /api/qr` | 返回插件生成的登录二维码 |

## 安装

```bash
cd manager
./start.sh              # 起服务并打开 http://127.0.0.1:3099
./start.sh --server-only  # 只起服务（开机自启用）
```

停机：`kill "$(cat ~/.local/state/bili-duty-manager.pid)"`；日志：`~/.local/state/bili-duty-manager.log`。

## 与上游升级的关系

- 插件升级（`dsh plugin --profile web add ...`）不影响 `manager/`。
- 值班台只用插件的公开 HTTP 路由；若上游改了路由名，改 `server.mjs` 里的 `proxyRoutes` 即可。
- 本分支基于 **v2.0.4**（当前线上跑的版本）。上游 `main` 已到 2.1.0，合并时用
  `git rebase upstream/main` 或重新 cherry-pick 本目录的提交。

## 本机环境备注（aarch64 / ARM64）

v2.0.4 的 `lib/uvfetch.mjs` 在 Linux 上写死了 `uv-x86_64-unknown-linux-gnu.tar.gz`，
在 aarch64 机器上会下到 x86-64 二进制（执行报 ENOENT），导致「装依赖」整条失败。
本分支附带一个最小修复（按 `process.arch` 选资产，回移自上游 2.1.0 的做法）。

即使不修，也可以手动绕过：

```bash
python3 -m venv ~/.dsh/bili-duty/.venv
~/.dsh/bili-duty/.venv/bin/python -m pip install -r \
  <插件目录>/vendor/bilibili-mcp/requirements.txt
# 然后在设置里把 pythonPath 指到 ~/.dsh/bili-duty/.venv/bin/python
```
