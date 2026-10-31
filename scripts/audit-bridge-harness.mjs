// Execute the real bridge initialization/functions against temporary files and fake peers.
// No production config, QQ connection, DSH process, or persistent home is accessed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as markdown from '../src/md-to-plain.js';
import * as sensitive from '../src/sensitive.js';
import * as wait from '../src/v2-wait.js';
import * as safeFetch from '../src/safe-fetch.js';
import * as mediaNormalize from '../src/media-normalize.js';
import * as forward from '../src/forward.js';
import * as slang from '../src/slang-learner.js';
import * as sticker from '../src/sticker-lib.js';
import * as modelPrices from '../src/model-prices.js';
import * as tokenLedger from '../src/token-ledger.js';
import * as voiceLib from '../src/send-voice-lib.js';
import * as presetPrompt from '../src/preset-prompt.js';
import * as sendFileLib from '../src/send-file-lib.js';
import * as stateAcl from '../src/state-acl.mjs';
// 人格卡解析：bridge.js 顶部 import 了这几个，VM 里必须注入同名绑定，
// 否则 currentRoleHint / roleRawContent 一被调用就 ReferenceError（实际踩到过）。
import * as roleCard from '../src/role-card.js';
import { unwrap, createTurnCollector } from '../src/dsh-client.js';

const root = fileURLToPath(new URL('..', import.meta.url));
export async function bridgeHarness({ config = {}, savedState, files = {}, globals = {} } = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-audit-bridge-'));
  fs.mkdirSync(path.join(temp, 'src'));
  fs.mkdirSync(path.join(temp, 'state'));
  fs.writeFileSync(path.join(temp, 'config.json'), JSON.stringify({
    dsh: { authToken: 'fixture-only' }, ownerQQ: 123,
    allow: { private: ['123'], groups: ['456'] }, consolePort: 0,
    consoleToken: 'fixture-console-token', slang: { enabled: false }, ...config,
  }));
  if (savedState) fs.writeFileSync(path.join(temp, 'state/sessions.json'), JSON.stringify(savedState));
  // 额外状态文件（用于测试"启动时读到损坏/旧版文件"这类路径）。
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(temp, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, typeof content === 'string' ? content : JSON.stringify(content));
  }
  const calls = { created: [], archived: [], sent: [], prompts: [], follows: [], cancelled: [], images: [], faces: [], http: [], onebotRequests: [] };
  // 语音发送在桥接里是**直接 fetch 网关**（与文本/表情共用 sendChain，但要自己带 record 段），
  // 所以这里给 VM 注入一个记录型 fetch：既不让测试真的发 QQ 消息，又能断言发出的段内容。
  const fakeFetch = async (url, init = {}) => {
    const body = (() => { try { return JSON.parse(init.body ?? '{}'); } catch { return init.body; } })();
    calls.http.push({ url: String(url), body });
    const action = String(url).split('/').pop();
    // fetch_custom_face_detail：同步收藏表情的 HTTP 兜底路径要拿到**数组**（WS 失败时用）。
    if (action === 'fetch_custom_face_detail') {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          status: 'ok',
          retcode: 0,
          data: [{ emoji_id: 'http-fixture-sticker', resId: 'http-fixture-sticker', url: 'https://public.invalid/http-sticker', md5: 'AABBCCDDEEFF00112233445566778899', desc: 'HTTP 兜底表情' }]
        })
      };
    }
    if (action === 'fetch_ptt_text') {
      return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { text: 'fixture-transcript' } }) };
    }
    // get_msg：语音落地校验用 —— 回一个带 record 段的消息，模拟真实网关
    if (action === 'get_msg') {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          status: 'ok',
          retcode: 0,
          data: { message_id: 9001, message: [{ type: 'record', data: { file: 'fixture-record.amr', duration: 3 } }] }
        })
      };
    }
    return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 9001 } }) };
  };
  const success = (value) => ({ result: { ok: true, value } });
  const api = {
    events: { follow: (id) => calls.follows.push(id) },
    // settings.describe 的默认桩：没有 qq-mode 命名空间 ⇒ refreshMode() 回退到本地 mode.json。
    // 测试可覆盖它来验证「DSH 设置里的空 ownerQQ 不得覆盖 config.json」等契约。
    settings: {
      describe: async () => success({ namespaces: [] }),
      update: async () => success({ updated: true })
    },
    workspace: {
      create: async () => success({ created: false, workspace: { workspaceId: 'fixture-workspace' } }),
      archiveSession: async ({ sessionId }) => { calls.archived.push(sessionId); return success({}); },
    },
    sessions: {
      create: async (params) => { calls.created.push(params); return success({ sessionId: `fixture-${calls.created.length}` }); },
      selectModel: async () => success({ selected: { provider: 'fixture', model: 'fixture' } }),
      prompt: async (params) => { calls.prompts.push(params); return success({}); },
    },
    respond: async () => success({}),
    stopSessionWork: async (sessionId) => { calls.cancelled.push(sessionId); return { removed: 0 }; },
    callUnary: async (method, params) => { calls.cancelled.push({ method, params }); return success({ accepted: true }); },
  };
  class FakeBot {
    async sendPrivateMessage(id, text) { calls.sent.push({ kind: 'private', id, text }); }
    async sendGroupMessage(id, text) { calls.sent.push({ kind: 'group', id, text }); }
    async getImage({ file }) {
      calls.images.push(file);
      // Valid 1 × 1 PNG, supplied entirely in memory by the fixture gateway.
      return { base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+k3ioAAAAASUVORK5CYII=' };
    }
    async fetchFaceEntity(id) { calls.faces.push(id); return null; }
    async request(action, params = {}) {
      // 记录所有 OneBot 动作：发文件（upload_private_file / upload_group_file）这类
      // "真的把东西送出去"的调用必须在测试里可断言，不能只靠返回值。
      calls.onebotRequests.push({ action, params });
      // 群成员列表：v2 读工具 qq_get_group_members 会用到（含 WS 不可用时的 HTTP 兜底路径）。
      if (action === 'get_group_member_list') {
        return {
          status: 'ok', retcode: 0,
          data: [
            { user_id: 111, nickname: '小明', card: '小明', role: 'member' },
            { user_id: 222, nickname: '路人', card: '' },
            { user_id: 123, nickname: '管理员', card: '群主', role: 'owner' }
          ]
        };
      }
      return { status: 'ok', retcode: 0, data: [{ emoji_id: 'fixture-sticker', url: 'https://public.invalid/sticker' }] };
    }
  }
  let source = fs.readFileSync(path.join(root, 'src/bridge.js'), 'utf8');
  // 去掉顶层 import（VM 里靠 context 注入提供这些绑定）。
  // 必须按行处理：这些 import 有**多行**写法，用单行正则（/^import[\s\S]*?;/gm）会在
  // 第一个分号处停下，把紧跟其后的正常代码一起删掉（曾把 `cfg.socialV2.voice = {…}`
  // 整段吞掉，导致语音相关断言在虚拟环境里悄悄失真）。
  source = source.split(/\r?\n/).reduce((acc, line) => {
    if (acc.droppingImport) {
      if (/;\s*$/.test(line)) acc.droppingImport = false;
      return acc;
    }
    if (/^import[\s{*]/.test(line) || /^import\s+['"]/.test(line)) {
      if (!/;\s*$/.test(line)) acc.droppingImport = true;
      return acc;
    }
    acc.out.push(line);
    return acc;
  }, { out: [], droppingImport: false }).out.join('\n');
  source = source.replaceAll('import.meta.url', JSON.stringify(pathToFileURL(path.join(temp, 'src/bridge.js')).href));
  // 切在 SIGINT 处理之前，是为了不把进程信号挂进 VM 上下文。
  // 但 slice(0, -1) 是「切掉最后一个字符」不是「切掉全部」—— 这句话哪天被改写、
  // 换引号或挪位置，indexOf 就返回 -1，整份 bridge.js 会照常执行少一个字符，
  // 测试仍"通过"，只是跑的是一份残句。宁可在这里直接炸。
  const sigintAt = source.indexOf("process.on('SIGINT'");
  if (sigintAt < 0) {
    throw new Error('audit-bridge-harness: src/bridge.js 里找不到 process.on(\'SIGINT\' —— 切分锚点失效，拒绝在一份没被正确裁剪的源码上跑测试');
  }
  source = source.slice(0, sigintAt);
  source = source.replace('  bot.onPrivateMessage(async (event) => {', `
  return {
    ensureSession, ensureSlangLearnerSession, resolvePresetName, deliverPrompt, drainPromptQueue,
    sendToQQ, sendStickerV2, handleIncoming, startConsoleServer, cfg, state, api, promptQueues,
    getSocialV2State, appendSocialV2Message, recordSentMessagesV2,
    // 限流提示：撞上限时得说出「还能发几条、要等几秒」，否则模型只会原地重试。
    rateLimitHintV2, computeGapsV2,
    buildWakePromptV2, buildWakeSnapshotV2, renderWakeSnapshotV2, sendWakePromptV2, socialV2,
    // 「醒来先过三关」的正文现在来自配置（留空=不注入），要能单独断言"清空就真的一条不发"。
    wakeCheckLineV2,
    // QQ 空间：写空间规则是操作者在控制台写的文本，要能单独断言"什么情况才注入"，
    // 以及 /api/config 那条归一化（关闸只认真布尔、条数收敛、字数截断）。
    buildQzonePromptV2, normalizeQzoneConfig, QZONE_PROMPT_MAX_CHARS,
    syncStickerLibrary, listStickersForV2, getStickerImageData,
    refreshMode, modeAllowed, trackTurnEvent, replayPendingWakeReasonsV2,
    // 三档权限分级：档位判定与「该用哪个 preset」都暴露出来，方便直接断言（不必真建会话）。
    sessionTier, wantedPresetName, isAllowListed, TIER_PRESETS, modePreset,
    collectors, setupSleepTimerV2,
    getInitialPrompt, setInitialPrompt, loadInitialPrompts, formatInitialPromptV2,
    initialPrompts, initialPromptMaxChars,
    // 跨会话共享记忆：全局一份，不挂会话 state，所以要单独暴露出来断言。
    appendSharedNoteV2, removeSharedNoteV2, formatSharedNotesV2, formatMemoryV2,
    saveSocialV2State, loadSocialV2State,
    extractMediaFromSegments, segmentsToText, collectAtTargets, fetchOneBotImage, fetchMediaData, resolveMediaList,
    // 引用目标解析：必须能断言「模型抄快照里的 #59 也能引对」——
    // 它手上根本没有纯文字消息的 messageId（快照只给序号），只认裸 id 就会引错人。
    resolveReplyTargetV2, findMessageMedia,
    // 唤醒判据：名字命中要能单独断言（裸子串会误唤醒）。
    evaluateWakeTriggerV2, hasNameMention,
    // 提问触发必须带指向性：群里两个人互相追问「你还没有回复我的话」不该把她叫醒。
    questionTargetsMe,
    // 收尾后的观望窗口：收尾不等于马上潜水，相关的话还要能把她叫回来。
    armWatchWindowV2, inWatchWindowV2, postReplyWatchMs,
    // 拍一拍：必须能断言「只算拍我」—— 谁拍谁都叫醒等于给每个群友一个免费唤醒器。
    handlePokeNotice,
    // 引用池：默认只准引本轮新到的消息。这是「一路沿用上一次引的那条」的解药，要能单独断言。
    resetReplyPoolV2, extendReplyPoolV2, replyPoolRejectV2,
    // 合并窗口：控制台按会话覆盖优先于私聊默认值和会话自己的 wakeConfig，
    // 要能不排定时器就断言优先级。
    effectiveBatchWindowMsV2,
    emojiCdnCandidates, getImageDimensions, acceptImageBuffer, MAX_MEDIA_BYTES, bot,
    isConversationBusyV2, v2TurnStartAt, turnLeaseNoted, TURN_BUSY_LEASE_MS,
    // 伪工具调用清理：要在审计/发送之前剥掉 <mcp__*> 标记，逻辑本身要能单独断言。
    // mdToPlain 一起暴露，是为了钉住「清理必须先于它」—— 它的加粗规则会吃掉 mcp__ 的双下划线。
    stripPseudoToolCalls, mdToPlain,
    // C+ 方案：伪调用冒充收尾时不再补提醒。要能单独断言「哪些名字算收尾」——
    // 名字可能带前缀（mcp__snowluma__qq_mark_read / mcp_snowluma_qq_mark_read / qq_mark_read），
    // 漏一种就等于那一种继续白烧一轮。
    pseudoToolNames, pseudoFinishIntent,
    // 配置快照：创建/列出/回滚/删除。删除要能单独断言，尤其是 id 校验挡住路径穿越。
    createSnapshot, listSnapshots, restoreSnapshot, deleteSnapshot, snapshotTargets,
    // 分场景人格：私聊/群聊各一份默认 + 会话级覆盖，选人格要能断言「改群聊不动私聊」
    // 以及「会话覆盖压过默认」。
    readRoleState, writeRoleState, effectiveRoleName, roleSourceForKey, CLEAR_SESSION_ROLE,
    currentRoleHint, currentRoleHintV2, roleRawContent,
    // 内联门槛（role.inlineMaxChars）：小卡每轮全文内联、大卡只发名字。
    // 门槛现在是可配的，所以要能单独断言「改配置就换了分档」与「值被收敛到合法区间」。
    buildRoleLineV2, applyRoleInlineLimit, applyRoleInjectLimit,
    getRoleInlineMaxChars() { return roleInlineMaxChars; },
    setRoleInlineMaxChars(value) { roleInlineMaxChars = value; },
    settingFromDshNamespace, selfIdentityTextV2, buildWakeReminderPromptV2,
    getMode() { return currentMode; },
    setSelfIdentity(display, id) {
      selfDisplayName = String(display ?? '');
      selfUserId = String(id ?? '');
      selfNickname = selfDisplayName.toLowerCase() || 'deepseek';
    },
    flushQueue, retireSession,
    voiceCfg, voiceLibrary, resolveVoicePathForV2, resolveVoicePathForOperator,
    voiceBudgetCheck, sendVoiceV2, sendVoiceForV2, assertOutboundAuditOk,
    setMode(value) { currentMode = value; },
    setReady(value) { dshReady = value; },
    setPresets(value) { dshPresetIds = value; dshDefaultPreset = 'standard'; },
    resetEpoch() { sessionEpoch++; },
  };
  bot.onPrivateMessage(async (event) => {`);
  const timers = new Set();
  const context = vm.createContext({
    fs, os, path, http, crypto, fileURLToPath, URL, Buffer, AbortSignal, console: { log() {}, error() {} },
    fetch: fakeFetch,
    // 锁文件探测用（bridge.js 顶层的 consolePortInUse）；
    // 固定桩掉：测试不应该真去 netstat 宿主机。
    execFileSync: () => '',
    // process 桩要带 env：voice-core / bridge 会读 process.env.FFMPEG_PATH、FFPROBE_PATH 等。
    // 之前只给 pid/platform/kill/exit，导致 `process.env.FFMPEG_PATH` 直接抛 TypeError。
    process: { pid: process.pid, platform: process.platform, kill: process.kill, env: {}, exit: (code) => { throw new Error('unexpected exit ' + code); } },
    setTimeout: (fn, ms) => { const timer = setTimeout(fn, ms); timers.add(timer); return timer; },
    clearTimeout, setInterval: () => ({ unref() {} }), clearInterval: () => {},
    NodeApiClient: class { constructor() { return api; } },
    SnowLumaWebSocketClient: FakeBot, text: (s) => s,
    discoverDshLaunchToken: () => '', unwrap, createTurnCollector,
    // 端口自动发现：VM 里没有真网络，也不该真扫宿主机端口。
    // probeDsh 桩成「活着」，让启动路径不进入扫描分支；scanDshPorts 桩成空数组，
    // 万一有测试显式要走扫描分支，得到的是确定的「没找到」而不是超时。
    probeDsh: async () => true,
    scanDshPorts: async () => [],
    ...markdown, ...sensitive, ...wait, ...safeFetch, ...forward, ...slang, ...sticker,
    ...modelPrices, ...tokenLedger, ...voiceLib, ...stateAcl, ...presetPrompt, ...sendFileLib,
    ...roleCard,
    // 桥接的出图出口会调归一化（体积/动图抽帧）：VM 里必须能拿到这几个函数。
    normalizeImageForModel: mediaNormalize.normalizeImageForModel,
    sniffImage: mediaNormalize.sniffImage,
    planNormalization: mediaNormalize.planNormalization,
    planAnimation: mediaNormalize.planAnimation,
    // ACL 收紧会 spawn icacls 去改**真实**文件系统；测试不该做这件事（同理见下面的
    // cleanupTemp / processAudioVolume 桩）。桩成成功，让 hardenStateDirAcl 走正常分支。
    hardenDir: () => ({ ok: true, detail: 'stub' }),
    // 音量靠 ffmpeg；测试环境不该真跑 ffmpeg（也不该在沙箱里 spawn）。
    // 默认桩成"按倍数记账但不转码"，调用方可用 globals 覆盖来断言真实行为。
    processAudioVolume: async (file, { volume = 1, normalize = false, loudness = 'normal' } = {}) => {
      const v = Number(volume);
      const changed = normalize === true || Math.abs(v - 1) > 1e-9;
      return {
        path: changed ? `${file}.vol` : file,
        converted: changed,
        applied: changed,
        volume: normalize ? 1 : v,
        loudness: normalize ? -16 : null,
        mode: normalize ? 'loudnorm' : (changed ? 'volume' : 'original'),
        detail: normalize ? `智能音量（响度归一 ${loudness === 'loud' ? -13 : loudness === 'quiet' ? -20 : -16} LUFS）`
          : (changed ? `音量 ${Math.round(v * 100)}%` : '原始音量')
      };
    },
    cleanupTemp: () => {},
    ...globals,
  });
  // Execute the pure model view in the bridge realm. Its plain-object checks
  // should see the same prototypes as real bridge messages, just as in Node.
  const modelViewSource = fs.readFileSync(path.join(root, 'src/qq-model-view.js'), 'utf8').replace(/^export /gm, '');
  vm.runInContext(`Object.assign(globalThis, (() => { ${modelViewSource}\nreturn { compactModelMessage, compactModelData, serializeModelData, describeAge }; })());`, context);
  vm.runInContext(source + '\nglobalThis.auditReady = main();', context);
  const bridge = await context.auditReady;
  // preset 清单要与真实安装一致（含三档分级的两个 preset）：缺了 qq-chat-owner /
  // qq-chat-readonly，owner 私聊会走 fail-closed 直接建不出会话——那是**正确**行为，
  // 但会让所有涉及 owner 私聊的既有测试变成在测失败路径。
  bridge.setPresets(['standard', 'qq-chat', 'qq-chat-v2', 'qq-chat-owner', 'qq-chat-readonly']);
  bridge.setReady(true);
  return { ...bridge, calls, temp, async close() {
    for (const timer of timers) clearTimeout(timer);
    fs.rmSync(temp, { recursive: true, force: true });
  } };
}
