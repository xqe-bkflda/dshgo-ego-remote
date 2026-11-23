# dshgo-ego-remote · 把手机里的浏览器页面转发成一张可操作的网页

DSH Go 手机端插件。在 App 的「浏览器远程」面板里一键起服务，电脑/平板浏览器打开地址就能**实时看到手机上 ego 浏览器正在跑的页面，并且能点、能打字、能滚**——不用装别的软件，走同一 WiFi 就行。

底层直连 ego 的 Chrome DevTools Protocol（默认 `127.0.0.1:32773`），自己实现「出画面 + 收操作」。dsh-ego-browser 插件自带的实时视图要 dsh-auth cookie 且 `disableFrameRelay: true`，外部网页拿不到画面，所以单独做了这一套。

## 安装

```bash
cp -r dshgo-ego-remote "$DSH_HOME/dsh-go/plugins/local-ego-remote"
dsh plugin --profile web add "$DSH_HOME/dsh-go/plugins/local-ego-remote"
```

也可以在插件市场里一键装。装完在 App 里能找到「浏览器远程」：对话详情 → 插件页签、全部功能 → 插件分组、输入框上方插件胶囊。

## 面板上用

```bash
cd /root/workspace/ego-remote
点面板「启动/修复」            # 后台跑（端口用上次的，默认 7788）
./start.sh                      # 前台跑，Ctrl-C 停
./start.sh --bg --port 9000     # 换端口
./start.sh --stop               # 只停不启动
```

端口优先级：`--port` > `PORT` 环境变量 > `.port` 文件（上次用的） > `7788`。
端口会被记在 `.port`，下次不带参数启动还是这个端口。没有 root，别用 1024 以下。

启动后日志会打印：

- `http://127.0.0.1:7788/?t=xxxxxxxx` — 本机
- `http://192.168.x.x:7788/?t=xxxxxxxx` — 同一 WiFi 下的手机 / 电脑浏览器

`t=` 后面的 token 存在 `.token`，重启不变（删掉就换一把）。

## 传输：WebSocket 二进制，不是 SSE

```
[0x01][uint32 metaLen][meta JSON][JPEG 原始字节]
```

- 画面走**二进制帧**，JPEG 不再 base64（省 33% 体积）、不再挤 SSE 文本流
- 操作走**同一条连接的文本帧** `{t:'input', type:'mouseMoved', x, y}`
  —— 鼠标移动不再是一次 HTTP POST
- 客户端解码跟不上时只保留最新一帧（服务端按 `bufferedAmount > 400KB` 丢旧帧），
  延迟不累积
- `metaLen === 0` 表示沿用上一帧的 meta，不再每帧重发一遍 JSON

**分辨率跟着客户端的显示尺寸走**：网页把 `stage.clientWidth × devicePixelRatio`
发上去，服务端就按这个宽度重开 screencast。手机上 390 宽的屏幕不会再收到
1280 宽的 JPEG，解码量降到约 1/9。

实测（390×889 视口，页面有动画）：**54 fps / 平均 35 KB 一帧**，改之前 26 fps。

## 网页上能干什么

| 操作 | 效果 |
|---|---|
| 下拉框 | 列出 ego 里所有 page target，选一个点「连接」 |
| 鼠标点击 / 拖动 | `Input.dispatchMouseEvent`，真实点击 |
| 滚轮 | 转发到远程页面滚动 |
| 直接敲键盘 | 可打印字符走 `Input.insertText`，方向键 / 回车走 `dispatchKeyEvent` |
| 「键盘」按钮 | 手机上弹出系统输入法，逐字转发 |
| 手指点按 / 拖动 | 手机上自动走 `Input.dispatchTouchEvent` |
| `←` `→` `↻` | 历史前进后退、刷新 |
| 地址栏 | 输入网址回车，远程页面直接跳 |
| `1:1` | 在「铺满宽度」和「原始像素（可拖动看全图）」间切换 |

打开网页会自动连上第一页，不用手点。右上角 `静止` 表示页面没变化（screencast
本身只在画面变化时出帧，服务端每 1.5 秒补一张确认目标还活着）。

**ego-remote 自己那页不会被列出，也不能被接管** —— 镜像自己会无限递归。

## 手机面板

装好插件后，在对话详情页「插件」页签 / 全部功能 / 聊天页「插件」胶囊里有 **「浏览器远程」** 面板：

- 直接显示本机地址、局域网地址、端口、正在看的人数、转发宽度
- 「复制本机地址」一键复制带 token 的完整 URL
- 「换端口」真的重启服务换到下一个端口，不是只改显示
- 「启动 / 修复」「停止」控制那个进程

## 参数

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `7788` | 监听端口（`--port` 优先） |
| `HOST` | `0.0.0.0` | 改成 `127.0.0.1` 就只给本机用 |
| `QUALITY` | `72` | JPEG 质量，越小越省流量 |
| `MAX_WIDTH` | `1280` | screencast 宽度上限（客户端要更宽也不超过这个） |
| `EGO_STATE` | `/root/.local/state/ego-lite-linux` | ego 状态目录，用于找 `browser.json` |
| `EGO_REMOTE_DIR` | 插件自带 `server/` | 换成自己那套转发服务目录 |
| `TOKEN` | 随机并存盘 | 强制指定访问 token |

## 接口

HTTP 全部要 `?t=<token>`：

- `GET /api/status` → `{ok, port, token, urls, attached, clients, pages, castW}`
- `GET /api/pages` → `{ok, pages:[{id,url,title}], current}`
- `GET /api/attach?id=<targetId>` → 接管这一页，开始出帧
- `POST /api/command` → `{cmd, ...}`，cmd 支持 `reload` `back` `forward`
  `navigate` `scrollBy` `clickText` `eval`
- `GET /api/detach` → 断开

WebSocket `GET /ws?t=<token>`（升级后）：

- 收：二进制帧包（见上）；文本 `{k:'hello'|'attached'|'nav'|'detached'|'result'}`
- 发：`{t:'resize',w,h}`、`{t:'input', ...}`（同原来的 input 类型）、
  `{t:'command',cmd,id}`、`{t:'attach',id}`

## 注意

- ego 浏览器被 dsh 关掉（默认 15 分钟空闲）后，网页会显示「目标已关闭」；
  重新让 dsh 打开浏览器，再刷新网页就行。
- 一次只镜像一个页面，切页面前会先断开上一页。
- 服务本身不做鉴权以外的隔离：拿到 token 的人就能操作这个浏览器。别把
  `0.0.0.0:7788` 暴露到公网。
