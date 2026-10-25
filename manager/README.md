# B站值班台（独立小应用）

给 `dsh-bili-scroll` 套一个**自己的界面**，不再和 DeepSeek Harness 的聊天页混在一起。
它只管这一类事：跑一轮、改关键词/配额/峰谷、看日报、看待过和跳过哪些、看日志。

- 地址：**http://127.0.0.1:3099**
- 只监听本机，只接受同源请求
- 桌面上的「B站值班台」图标可以直接双击打开；登录后服务也会自动起
- 不重写任何业务逻辑：状态、配置、跑一轮、扫码登录都转给插件自己的 `/api/bili-duty/*`；
  日报 / 判重表 / 日志直接读插件家目录

## 目录

```
server.mjs          本地服务：静态页 + 插件接口代理 + 报告/判重表/日志读取
public/index.html   页面结构
public/app.js       交互（状态轮询、设置保存、跑一轮、扫码、日志过滤）
public/style.css    样式
start.sh            起服务（必要时）并打开浏览器；--server-only 只起服务
```

## 常用命令

```bash
# 打开界面（服务没起会顺手起起来）
./start.sh

# 只起服务（开机自启用的就是这条）
./start.sh --server-only

# 停止
kill "$(cat ~/.local/state/bili-duty-manager.pid)"
```

日志：`~/.local/state/bili-duty-manager.log`

## 说明

- 「立即跑一轮」实际调的是插件的 `/run`，和 DSH 设置页里那个按钮是同一条路。
- 峰谷自动刷由**插件自己的定时器**负责，这个界面只是改配置；Harness 没启动时不会自动跑。
- 自动评论默认关；界面上开它会有明显提示，建议保持关闭。
- 登录二维码走插件的 `/login/start` + `/login/poll`，凭证存在 `~/.dsh/bili-duty/bili_credential.json`。
