// Safe audit suite: fixtures and mocks only, never production QQ/DSH.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
const tests = [
  'test-audit-bridge.mjs', 'test-audit-protocol.mjs', 'test-audit-protocol-helpers.mjs',
  'test-audit-security.mjs', 'test-audit-security-mcp.mjs',
  'test-audit-setup.mjs', 'test-audit-setup-guards.mjs',
  // DSH 会话队列（inbox 投影）解析：0.2.0 把队列从 control baseline 的
  // `value.queues[<id>]` 挪进了 `value.projections[<id>].values.inbox`。
  // 认错形状的后果不是"少清几条"，而是**每一次退役会话都抛错**、旧任务继续跑，
  // 且只留下一行日志 —— 必须有登记期断言钉住（活 DSH 侧的实测见
  // scripts/test-dsh-session-retire.mjs）。
  'test-dsh-inbox-projection.mjs',
  'test-md-to-plain.mjs', 'test-slang-learn.mjs', 'test-mux-reconnect.mjs',
  'test-token-economy.mjs', 'test-qq-model-view.mjs', 'test-qq-preset-contract.mjs',
  'test-reply-wait.mjs', 'test-preset-prompt.mjs', 'test-role-card.mjs',
  // 体检修复回归：无令牌智能体调用面、send-burst 失败回滚、唤醒限频重试、
  // 定时器类暂存唤醒补发、collector 生命周期、ownerQQ 覆盖语义、预设名校验、
  // wake triggers 白名单、memory-update 边界、wait 租约归一化、md/黑话/表情/账本；
  // 本轮新增：/api/send/* 失败路径的作用域错误（R15）、reserved2 落库丢表情识别字段（R16）。
  'test-audit-regressions.mjs',
  // 图片/表情链路（动图/表情包字段、CDN 优先与 emoji_id 兜底）+ 联网搜索
  // （DSH 同一路 DeepSeek 搜索、Bing RSS 兜底、凭据优先级与端点安全；
  //  本轮新增：空结果 note 必须在写缓存之前生成，否则缓存命中丢掉提示）。
  'test-media-search.mjs',
  // 媒体项归类与失败判定：真图片拿不到像素才判失败，QQ 系统小表情只有名字是正常的
  // （2026-10-31 群 100002 #151 的 faceId=264「捂脸」曾被误判成故障）。
  'test-media-items.mjs',
  // 端口自动发现：只在启动时跑一次，出错的表现是「消息进来了但 AI 永远不回」，
  // 所以它的边界（指纹判据、from/to 语义、扫描耗时）必须单独钉住。
  'test-port-discover.mjs',
  // 名字命中的边界：裸 includes(substring) 会让「这个鲸鱼玩偶」这种闲聊也叫醒机器人
  // （2026-10-31 群 100001：@ 的不是它、推荐唤醒词也清空了，照样插了一句）。
  'test-name-mention.mjs',
  // 拍一拍的边界：只算「拍我」。原先只看 triggers.poke，群里谁拍谁都能叫醒她 ——
  // 另一个机器人每次回话前先拍一下群主，就把本桥接连续唤醒十几次，一次话没说。
  'test-poke-wake.mjs',
  // 提问触发的指向性 + 收尾后的观望窗口：群里两个人互相追问不该把她叫醒
  // （2026-10-31 群 100001 一晚上 question 空转 6 次），收尾后也先别急着潜水。
  'test-question-watch.mjs',
  // 【之前】按时间舍去：冷场几小时后被叫醒，旧账不该还躺在上下文里带偏
  // 「你」指谁、这话是不是已经有人答过。0 = 不限（老行为）。
  'test-recent-age.mjs',
  // 单条消息里带换行 → 按换行拆成多条。模型以为「换行=分条」，实际只发出一条，
  // 群里当场被指「真糊成一条了」（2026-10-31 07:49:56 的真实参数）。
  'test-newline-split.mjs',
  // GitHub issue 回归：#22 模式 user 层优先 / #11/#19 回合判忙租约 / #29 机器人身份注入。
  'test-issue-regressions.mjs',
  // 二代「会话初始提示词」：只在首次唤醒注入、管理面隔离、损坏文件只读降级、
  // 以及控制台「立即唤醒」不得顶掉首次 bootstrap（否则初始提示词永远发不出去）。
  'test-v2-initial-prompt.mjs',
  // 令牌账本 / 价目表 与 体检修复回归（纯函数，无外部依赖）
  'test-token-usage.mjs', 'test-hardening.mjs',
  // 语音发送（纯函数 + 端点存在性；真发语音只在 --live 或 CLI 里做）
  'test-voice.mjs',
  // 音量：参数校验 + 真的调用 ffmpeg 调音量 + 自算 RMS 验证增益
  'test-voice-volume.mjs',
  // 边界：并发/异常输入/上传限额/越权（纯函数段 + 可选的 live 段）
  'test-voice-edge.mjs',
  // 语音图形界面（参数解析/鉴权/路径穿越/文件名净化；live 段需普通终端）
  'test-voice-gui.mjs',
  // 控制台静态契约（跑不了 Playwright 的环境下的替代回归）
  'test-console-static.mjs',
  // 语音系统整体结构检查（入口/依赖/端点/开关/文档一致性）
  'test-voice-system.mjs',
  // SnowLuma 账号/token 自发现（换 QQ 账号后 token 会变，写死的工具会 401）
  'test-snowluma-conn.mjs',
  // 启动器与编码（乱码根因：.cmd 里的非 ASCII 会被 cmd 按 ANSI 解码）
  'test-encoding.mjs',
  // 控制台乱码机制（UTF-8 字节被按 GBK 解码）+ chcp 修复
  'test-console-encoding.mjs',
  // 🔴 铁律 L7（仿真会话不得拥有本地执行能力）：注册期断言——
  //    preset 挂了守卫、守卫的 restrict 名单覆盖全部已知本地工具、且执行期一律拒绝。
  //    这是唯一挡住"绕过桥接直连 OneBot HTTP"的东西（见 QSH_PLAN.md §0.1/§5.2），
  //    所以必须在每次回归里跑，而不是一次性验收。
  'test-preset-local-tools.mjs',
  // 守卫本身的回归：restrict 失败不静默、延迟重试补藏、三档 mode 的执行期矩阵
  // （strict / readonly / open）与"未知 mode 按 strict 处理"的 fail-closed 防线。
  'test-tool-restrict-guard.mjs',
  // 三档权限分级（2026-10-26）：owner 优先于白名单、显式白名单才给只读档
  // （allowAllWhenEmpty 不得提权）、deny 前置、新 preset 缺失时 fail-closed、
  // 以及档位变化触发会话重建。纯离线，跑的是真实 bridge.js（VM harness）。
  'test-permission-tiers.mjs',
  // 会话级 preset 档位覆盖（2026-11-02）：给单个会话单独指定用哪个 preset。
  // 钉住的是「可选值只有四个 qq-chat*」—— 一旦允许写 standard（DSH 默认 preset，
  // 带 bash/文件读写），三档分级的 fail-closed 就白做了；另外验覆盖压过档位默认、
  // 只对自己那个 key 生效、删除后回落、变更触发会话重建。
  'test-session-preset.mjs',
  // 会话级 MCP 工具开关（2026-11-02）：socialV2.tools 原本是全局的，这里补调用期粒度。
  // 钉住的是「关掉的工具仍在 schema 里、只是调用 403」这条硬限制不许被误解成可见性开关，
  // 以及覆盖只对自己那个 key 生效、能升能降、未知 flag 写入即拒、AI 改不动它。
  'test-session-tools.mjs',
  // 发文件（qq_send_file）：路径安全层（扩展名白名单 / 敏感路径黑名单 / 体积 / 普通文件）
  // + 真实路由闸门（只有 Owner 档能发出去；群聊 / 白名单 / 陌生会话一律 403 且不碰网关）。
  'test-send-file.mjs',
  // qq-mode-console 的 settings 契约：0.2.0 删除了 ctx.settings.register()，
  // 命名空间改为由 loader entry id + 导出的 Config 推导。断言三点前提都在，
  // 并且那条已删除的 API 不会被照旧注释加回来。
  'test-qq-mode-plugin.mjs',
  // SnowLuma 上游健康（被误诊成「qq-bridge 注入失败」的那个失败形态）：
  //   · good 必须取自心跳 status.good / get_status —— 取自 get_login_info 会**静默失效**
  //     （SDK 不校验 data 载荷，good 会永远停在 null，整条权威信号变成死分支）；
  //   · 静默检测不得冒充 hook 检测（心跳是 SnowLuma 本地定时器无条件发的）；
  //   · 客户端库版本不得低于 bot_status 出现的版本。
  'test-snowluma-upstream-health.mjs',
  // 跨会话共享记忆 + 自我认知（控制台记忆面板的两块）：全局一份不挂会话、按整句去重、
  // 每轮注入 shared、以及「清空本会话全部」不得波及 selfNote 与 shared 这两类。
  'test-shared-notes.mjs',
  // QQ 空间「写空间规则」：只在 owner 私聊注入、没启用/空规则时整段消失、
  // 关闸只认真布尔、条数收敛、字数截断（逐轮注入，长度就是每轮成本）。
  'test-qzone-prompt.mjs',
  'test-snapshots.mjs',
  // 伪工具调用标记清理：模型偶尔把工具调用写成纯文本（<mcp__…> 带 key/token），
  // 出站前必须整段丢弃 —— 否则那堆尖括号连同会话令牌会原样落到群里。
  'test-pseudo-tool-cleanup.mjs',
  // C+ 方案：伪调用冒充收尾时不再补提醒（省掉那一轮白烧）。
  'test-pseudo-finish.mjs',
  // 「醒来先过三关」现在能从控制台改（留空=不注入）。
  'test-wake-check-prompt.mjs',
  // 分场景人格：群聊与私聊各用一份（全局 role + groupRole/privateRole 覆盖）。
  // 断言「改群聊不动私聊」「清除只回落不清全局」「写 mode 不丢覆盖」——这三条最容易写崩。
  'test-scoped-role.mjs',
  // 角色卡超内联门槛时，bootstrap 必须提醒它调用 qq_get_prompt 读一遍。
  // 实测有群 24 次工具调用一次都没调过，人设等于从没进过上下文。
  'test-role-read-hint.mjs',
  // 撞发送频率上限时的报错：必须说出「还能发几条 / 要等几秒」。
  // 只说「请稍后再试」时，模型实测会在 20 秒内连试 4 回，再走不通就退回文本伪调用。
  'test-rate-limit-hint.mjs',
  // 引用池：只能引本轮新到的消息。模型会把上周的 id 抄过来，引出「牛头不对马嘴」的对话，
  // 所以快照重建时重置池子，池子外的本地 seq 一律 400 并列出可引的。
  'test-reply-target.mjs',
  // 合并窗口的按会话覆盖：覆盖值要优先于全局、要落盘、0 要能表达「不覆盖」。
  'test-batch-window.mjs',
  // 梗百科查询的网络出口：代理端口绝不写死、只认回环代理、NO_PROXY 三写法、
  // 显式出口不许被偷偷切走，以及**对外错误文案里不许出现本机地址**（那些字会进
  // 模型上下文，群里人格明写禁止泄露本机信息）。全程离线，不连 cnmeme 也不连代理。
  'test-meme-wiki.mjs',
];
let failed = 0;
for (const test of tests) {
  console.log(`\nRunning ${test}`);
  const result = spawnSync(process.execPath, [path.join(root, 'scripts', test)], {
    cwd: root, stdio: 'inherit', timeout: 60000,
    env: { ...process.env, QQ_BRIDGE_TEST_LIVE: '0' },
  });
  if (result.status !== 0 || result.error) {
    failed++;
    console.error(`FAILED ${test}: ${result.error?.message || `exit ${result.status}`}`);
  }
}
console.log(`\nAudit suite: ${tests.length - failed}/${tests.length} scripts passed.`);
process.exitCode = failed ? 1 : 0;
