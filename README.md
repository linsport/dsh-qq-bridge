# dsh-qq-bridge

把 QQ 消息接入 DeepSeek Harness（DSH）：QQ 好友/群发来的消息变成 DSH 会话里的用户消息，agent 的回复（含提问、工具审批）发回 QQ。

## 这个仓库是什么

[Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge) 的一个**个人自用分支**。不跟随上游同步，也不接受 PR —— 想要持续维护的版本请去上游。

| 环节 | 来源 | 带过来的东西 |
| --- | --- | --- |
| 上游 | Derpyu520/qq-bridge `v0.2.1-r1` | 基础桥接：SnowLuma 接入、四种模式、控制台、黑话学习、语音 |
| 中间 | NoMindSama/qq-dsh-bridge `7830acd` | 四层记忆、产物索引、发文件、owner / readonly 权限档位 preset |
| 本仓库 | 从中间版继续 | 唤醒逻辑、引用、伪工具调用、黑话学习修复、控制台扩展 |

### 相较原版的改动

**功能、架构、配置字段、上游已知问题，全部以[原作者的 README](https://github.com/Derpyu520/qq-bridge) 为准。** 下面只记本仓库自己动过的部分。

**唤醒与仿真**

- **观望窗口**重定语义：开窗只由收尾触发、**只开不续**；续时只由她**自己发消息**触发（倒计时重置回满，不是累加）；一段对话封顶 30 分钟；私聊不开窗。默认 60 → 180 秒。
  修复前它判断的是一个任何消息进来都会刷新的时间戳，窗口一开就永远命中，每轮收尾还能续上（实测一天触发 47 次、白醒 23 次）。
- 拍一拍在快照里补 `（拍你）` 标记。`（未点名）` 改名 `（没@人）` —— 只陈述「这条没有 at 段」，指向谁交给上下文判断，不再替她下结论。
- 姓名匹配加边界（昵称叫「小鲸鱼」时，不再因为正文出现「鲸鱼」就被叫醒）。
- 问句判定要求 @ 她 / 引用她 / 独立叫名字 / 60 秒内刚说过话，不再「含『你』加问号」就算在问她。
- 潜水按截止时间真正生效（原来只认「无限期」）；静默期间不排唤醒、不发提示词，拍一拍也不行。
- 单会话静音；醒来先过三关（看时间 / 看对象 / 看话头），控制台可编辑，留空即整段不发。
- 一条消息里的换行拆成多条发出（`qq_send_message` 数组的语法糖）。

**引用**

- **引用池**：只能引本轮新到的消息，否则 400 并在报错里列出可引的 seq。快照里每条消息都带 `id=`，`#59` 这种写法也认。
- `quoteEarlier: true` 作为逃生门 —— 真要引旧消息得显式声明。

**伪工具调用**

- 模型偶尔把 `qq_mark_read(...)` 当普通句子打出来（那一轮 `stopReason` 是 `stop`、内容是纯文本）。桥接会把这类文本剥掉，一个字都不会漏到群里。
- **剥完不是就完了**：整轮被伪调用占满时，桥接把提醒换成一份**交接** —— 说明它本来想调什么、还有几条没读（带 seq）、哪条带图（带 `id=`）、水位推到哪。
- **不代为执行**：伪调用里的参数是不可信输入，尤其是发送类和 `qq_set_wake_config`。

**黑话学习**

- 回合超时 600 秒 + 中途可窥（原来 5 分钟超时，长回合必丢结果）
- 作废正则收窄（原来会命中自己的超时文案）；提示词里的工具名改全名
- 模型说「没把握」但给了释义的词条先落盘，标 `pendingVerify`
- 学习会话探活 + 可指定 provider / model / effort
- 默认触发阈值 `[2,4,8]` → `[2]`

**连接与媒体**

- `src/dsh-port-discover.js`：DSH Web 端口漂了自动扫回来（只认返回 401 + `dsh web authentication required` 的，不会认错成别的服务）
- `src/media-items.js`：一项真图都没拿到就判失败（原来回 `ok:true` 加一句说明，模型以为自己看过了）
- ffmpeg 失败时保留现场（最近 5 次），并对 `-5 / EIO` 重试一次

**联网工具**

- `mcp__web-search-safe__meme_lookup`：查 [梗百科](https://cnmeme.wiki) 的公开词条（梗名 → 出处 / 用法）。`auto` 模式下搜到同名 slug 就直接取详情，否则列候选。内容是第三方文本，只作资料读。
- **出口选择**（`src/net-exit.js` + `src/proxy-tunnel.js`）：代理端口绝不写死，`netExit.proxy` 取 `auto`（读 `HTTPS_PROXY` / `ALL_PROXY` / `NO_PROXY`）/ `off` / 显式 URL；`http://` 走 CONNECT、`socks5://` 走 RFC1928，都是手写的，没加依赖。
  - 代理只接受回环地址，写别的直接抛错、不静默降级 —— 否则它就成了内网探测通道。
  - 目标校验仍然先做：代理开着也拦内网/本机地址，CONNECT 打的是已校验的 IP 而不是域名（DNS 交给代理解析的话，那一步校验就白做了）。
  - 出口建连失败对外只说「网络出口暂时不可用」，本机端口只进 `state/meme-wiki.log` —— 工具返回会进模型上下文，群里人格明写禁止透露本机信息。
  - `web_fetch` 也接了出口选择；`safeFetchBuffer`（QQ 图片/表情 CDN）与 Bing 搜索仍走直连，它们国内可达，塞代理反而坏事。

**配置与控制台**

- `socialV2` 的 `wake` / `context` 段补深度合并 —— config.json 里写了这两段但缺新键时，新键原来会静默变成 `undefined`
- 控制台：改模型（原来只能看）、配置快照与回滚、人格改动预览、会话实时视图、黑话注入预览、轮询按页分流、单会话静音

**测试**

- `npm run test:audit` 从 38 条扩到 **57 条**，新增 19 个回归脚本。每条新用例都做过**回退验证** —— 把改动撤回去它必须真的红。

逐版说明见 [Releases](https://github.com/linsport/dsh-qq-bridge/releases) 与 git tag 的附注。

## 前置条件

1. 运行中的 DeepSeek Harness Web（端口不固定：桌面版每次启动由系统分配空闲端口，`dsh --profile web` 才固定回落到 3080。桥接连不上会自动扫描本机回环端口找回来，`config.json` 里的 `dsh.baseUrl` 只是个起点）
2. 运行中的 SnowLuma，且配好 OneBot WebSocket 与 HTTP API（默认 `ws://127.0.0.1:3001` / `http://127.0.0.1:3000`）
3. Node.js ≥ 22.13

## 安装

### 1. 装依赖并复制配置

```bash
npm install
cp config.example.json config.json      # Windows CMD 用：copy config.example.json config.json
```

`npm install` 的 postinstall 会自动修补 `@snowluma/sdk` 的 ESM 打包 bug。

### 2. 装 DSH 端（preset + MCP），然后重启 DSH

```bash
node scripts/setup-dsh.mjs
```

装完**必须重启 DSH** —— preset 与 MCP 只在 DSH 启动时加载。跳过这步桥接不会崩，但群聊会话拿不到 `qq-chat` preset，桥接会**拒绝建会话**（有意的安全设计：绝不回退到带 bash / 文件工具的默认 preset），表现是 QQ 上毫无反应。

### 3. 装 SnowLuma

从 <https://github.com/SnowLuma/SnowLuma/releases/latest> 下载 `SnowLuma-v<版本>-win-x64.zip`（完整版自带 Node 运行时），解压到任意目录，双击 `launcher.bat`。

> 桥接**不启动、不控制** SnowLuma（SnowLuma EULA §5.4 限制自动化部署），只探测它的状态。

### 4. 首次引导 + 填桥接配置

打开启动日志里的 WebUI 地址，用日志中的初始密码登录，按引导同意条款 → 设密码 → 扫码登录 QQ。然后在 WebUI 里开启 **WebSocket 服务端** 和 **HTTP API**，记下端口和 accessToken。

回到 `config.json` 填这几项：

```json
{
  "dsh": { "baseUrl": "http://127.0.0.1:3080" },
  "snowluma": {
    "wsUrl": "ws://127.0.0.1:3001",
    "httpUrl": "http://127.0.0.1:3000",
    "accessToken": "WebUI 里配的 token（没配就留空）",
    "homeDir": "SnowLuma 安装目录（token 自愈要用，建议填）"
  },
  "allow": { "private": [你的QQ号], "groups": [群号] }
}
```

- `dsh.baseUrl` 端口对不上不要紧：桥接启动时会探活，探不到就扫本机回环端口，把活的 DSH 认出来（只认返回 401 + `dsh web authentication required` 的，不会认错成别的服务），然后写回 `config.json`。
- `wsUrl` 是 WebSocket 端口，`httpUrl` 是 HTTP API 端口 —— **不要填成同一个**，否则工具会报 HTTP 426。
- `dsh.authToken` **通常留空**：留空时桥接用 `~/.dsh/.credentials.yaml` 里的签名密钥离线铸造 Cookie。
- 示例模板里白名单是空数组，空白名单 + `allowAllWhenEmpty: false` 时桥接不响应任何消息（刻意的 fail-closed 默认值）。
- 其余字段（模型、媒体上限、搜索后端、控制台端口……）见 `config.example.json`。

### 5. 启动

```bash
npm start          # 前台运行
```

Windows 想要崩溃自动重启就用 `start.bat`（守护模式，窗口别关）。看到 `SnowLuma 已连接` 即成功，然后从 QQ 给机器人账号发条消息测试。

> 首次连接大概率会先失败一次（`code=1006`），随后自愈 WS token 并连上 —— 这条序列是正常的。

### 6. 出事怎么办

- 消息没反应：先双击 `restart.bat`（杀旧实例 → 清锁 → 重启守护）
- 桥接只能跑一个实例（有单实例锁）
- 改了 `config.json` / `roles/` / `state/current-role.json` → 重启桥接；改了 `dsh/agent-presets/` → 先跑 `node scripts/build-agent-preset-patches.mjs`，再重启 DSH

## 其余文档

- **功能细节、配置字段全表、架构、上游已知问题、SnowLuma 排障、权限分级**：见[原作者的 README](https://github.com/Derpyu520/qq-bridge) 与它的 [docs/](https://github.com/Derpyu520/qq-bridge/tree/main/docs)
- **本仓库的权限边界与安全承诺**：[RULES.md](RULES.md)
- **仓库目录与脚本命名约定**：[docs/FOLDER_MAP.md](docs/FOLDER_MAP.md)
- **全部文档索引**：[docs/README.md](docs/README.md)

## 自测（不需要 SnowLuma / QQ）

```bash
npm run test:audit     # 离线回归，用临时目录和模拟服务，不读真实配置、不发 QQ 消息
npm run self-test      # 验证 DSH 侧链路（会建一个独立测试会话，不影响现有会话）
```

## 合规提醒

SnowLuma 是独立第三方项目，与腾讯 / QQ 无隶属关系，仅供学习与技术研究；使用前请阅读其 EULA 与《QQ 用户协议》。
