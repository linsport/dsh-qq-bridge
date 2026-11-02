// qq-tool-restrict 守卫的回归（2026-10-18 新增）。
//
// 背景：一份重启后**新建**的 QQ 会话，请求头里 `dev_*` 仍然是 18 个
// （docs/audits/AUDIT_2026-10-18_MEDIA_AND_WATERMARK.md §3 P3）。
// 名单本身是对的、加载的副本也含这些名字，所以失败在 `ctx.tools.restrict()` 调用期，
// 被 per-name try/catch 静默吞掉 —— 现网完全不可观测（DSH 的 stderr 不落文件）。
//
// 本文件用桩 ctx 验证守卫现在的行为：
//   1. restrict 抛错时**不静默**：写诊断文件、并 3 秒后对失败项重试一次；
//   2. 时序问题（后注册的工具）能被重试补上；
//   3. 执行期 guard 白名单照旧：mcp__* 放行、dev_* 拒绝。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN = path.join(ROOT, 'plugins', 'qq-agent-presets', 'qq-tool-restrict.mjs');

let failures = 0;
let tests = 0;
async function test(name, run) {
  tests++;
  try { await run(); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, '—', error?.stack ?? error); }
}

// 每次都重新 import 一份干净模块（诊断文件路径来自 env，必须在 import 前设好）
async function loadPlugin(diagFile) {
  process.env.QQ_TOOL_RESTRICT_LOG = diagFile;
  const url = pathToFileURL(PLUGIN).href + `?t=${Math.random().toString(36).slice(2)}`;
  const mod = await import(url);
  delete process.env.QQ_TOOL_RESTRICT_LOG;
  return mod;
}

/**
 * 造一个**语义上忠实于 DSH** 的 ctx.tools 桩。
 *
 * 2026-11-02 重写：以前的桩对任何名字都照单全收（除非 restrictImpl 硬造 Error），
 * 于是「82 个名字逐个 deny」看起来全都成功。真实 DSH 的行为是：
 *   · 只认全局层里**确实注册过**的名字；
 *   · 名字不在其中 ⇒ 整批抛错，报错尾巴附完整 `known global tools:` 清单；
 *   · deny 掉的名字从 `visible` 消失（= 不再进模型 schema）；
 *   · 白名单（allow）写法必须名字也都存在，作用一样。
 * 不模拟这一条，就测不出「77 个名字在空转」这类问题。
 * @param {{known?: string[], knownAfterRounds?: number}} options
 */
function makeCtx({ known = [], knownAfterRounds = Infinity, reportKnown = true } = {}) {
  const calls = { restrict: [], guard: null, hidden: new Set(), rounds: 0 };
  // `known` 是「这个 composition 最终会注册的名字」；`knownAfterRounds` 之前它们还**没**进全局层，
  // 用来模拟注入器晚注册。默认 Infinity ⇒ 一开始就全在。
  const registered = new Set(knownAfterRounds === Infinity ? known : []);
  const ctx = {
    tools: {
      restrict(filter) {
        calls.rounds += 1;
        if (calls.rounds > knownAfterRounds) for (const name of known) registered.add(name);
        const names = [...(filter?.allow ?? []), ...(filter?.deny ?? [])];
        calls.restrict.push(...names);
        const unknown = names.filter((name) => !registered.has(name));
        if (unknown.length > 0) {
          // reportKnown=false 模拟「未来 DSH 不再在报错里附清单」——探测失效，须退回逐个 deny
          const suffix = reportKnown ? `; known global tools: ${[...registered].sort().join(', ') || '(none)'}` : ';';
          throw new Error(
            `tools.restrict() names unknown global tool${unknown.length > 1 ? 's' : ''} ` +
            `${unknown.map((name) => `"${name}"`).join(', ')}${suffix}`
          );
        }
        for (const name of filter?.deny ?? []) calls.hidden.add(name);
        return () => {};
      },
      guard(fn) { calls.guard = fn; }
    }
  };
  return { ctx, calls };
}

/** 本机实测的一份全局层清单（2026-11-02，`state/tool-restrict.log` 里 DSH 自己报的）。 */
const REAL_GLOBAL_TOOLS = [
  'advanced_search', 'cache_search', 'domain_search', 'free_search_test',
  'list_mcp_resource_templates', 'list_mcp_resources', 'load_workspace_dependencies',
  'acp_cache', 'acp_status', 'compress', 'decompress', 'search_context',
  'bsk_assist', 'bsk_page', 'mnemon_recall', 'mnemon_remember',
  'mcp__snowluma__qq_send_message', 'mcp__web-search-safe__web_search',
];

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-tool-restrict-'));

await test('探测不到全局清单时退回逐个 deny：不静默，写诊断 + 3 秒后重试', async () => {
  const diag = path.join(tmpDir, 'diag-always-fail.log');
  const mod = await loadPlugin(diag);
  // reportKnown=false：模拟未来 DSH 不再在报错里附清单 ⇒ 探测拿不到真实表，走旧路径
  const { ctx, calls } = makeCtx({ known: [], reportKnown: false });
  mod.apply(ctx);
  assert.ok(calls.restrict.length > 0, '必须真的调用 restrict');
  const first = fs.readFileSync(diag, 'utf8');
  // 诊断行的字段名是 skipped（实现里把「该版本未注册的名字」叫跳过，不是失败）。
  assert.match(first, /restrict ok=0 skipped=\d+/, `诊断文件应记录跳过计数：${first}`);
  assert.match(first, new RegExp(`skipped=${mod.RESTRICTED_TOOL_NAMES.length}\\b`),
    '分母应当是去重后的名单长度（重复项会虚高计数）');
  assert.match(first, /unknown global tool/, '诊断文件必须带 DSH 的原始报错');
  // 等延迟重试落地
  await new Promise((resolve) => setTimeout(resolve, 3400));
  const after = fs.readFileSync(diag, 'utf8');
  assert.match(after, /延迟重试 ok=0/, `重试结果也要落盘：${after}`);
});

await test('时序问题能被 3 秒后的重试补藏（工具晚注册）', async () => {
  const diag = path.join(tmpDir, 'diag-late.log');
  const mod = await loadPlugin(diag);
  const total = mod.RESTRICTED_TOOL_NAMES.length;
  // 轮次账：探测占 1 轮 + 逐个 deny 占 total 轮 = total+1 轮；之后再注册即为「晚到」，
  // 由 3 秒后的重试补藏。
  const { ctx, calls } = makeCtx({ known: mod.RESTRICTED_TOOL_NAMES, knownAfterRounds: total + 1, reportKnown: false });
  mod.apply(ctx);
  assert.equal(calls.hidden.size, 0, '第一轮应当一个都没藏掉');
  await new Promise((resolve) => setTimeout(resolve, 3400));
  assert.equal(calls.hidden.size, total, `重试后应全部藏掉，实际 ${calls.hidden.size}/${total}`);
  const log = fs.readFileSync(diag, 'utf8');
  assert.match(log, new RegExp(`延迟重试 ok=${total}`), `重试结果应写入诊断：${log}`);
});

// ── 新路径：从 DSH 报错里抠出真实全局表，改按 allow 收敛（2026-11-02） ──────
//
// 这是本轮的核心修复。以前的实现拿 82 个名字逐个 deny，在本机实测只有 4 个存在，
// 剩下 78 个全抛 unknown 跳过 —— 而真正在全局层里的 acp_* / bsk_* / mnemon_* /
// advanced_search 一个都没挡，它们在会话 schema 里照样可见、模型反复试、反复被拒。
await test('按真实全局表收敛：只留白名单，其余全部从 schema 隐藏', async () => {
  const diag = path.join(tmpDir, 'diag-allow.log');
  const mod = await loadPlugin(diag);
  const { ctx, calls } = makeCtx({ known: REAL_GLOBAL_TOOLS });
  mod.apply(ctx);
  // 白名单里的必须活着
  for (const name of ['mcp__snowluma__qq_send_message', 'mcp__web-search-safe__web_search']) {
    assert.ok(!calls.hidden.has(name), `${name} 必须保留（属于放行命名空间）`);
  }
  // 其余全部藏掉 —— 包括以前名单里根本没有的那些
  for (const name of ['acp_cache', 'bsk_assist', 'mnemon_recall', 'advanced_search', 'compress', 'search_context']) {
    assert.ok(calls.hidden.has(name), `${name} 必须从 schema 隐藏`);
  }
  const log = fs.readFileSync(diag, 'utf8');
  assert.match(log, /restrict 全局层实测 \d+ 个：隐藏 \d+ 个、保留 2 个/, `诊断应记录实测收敛结果：${log}`);
  // 收敛后不该再有「逐个试 82 个」的跳过噪声
  assert.doesNotMatch(log, /skipped=\d+/, '探测成功时不应再走逐个 deny 的旧路径');
});

await test('全局层里出现名单外的危险名：被 allow 收敛藏掉，并在 console 提示更新名单', async () => {
  const diag = path.join(tmpDir, 'diag-unknown-danger.log');
  const mod = await loadPlugin(diag);
  const { ctx, calls } = makeCtx({ known: [...REAL_GLOBAL_TOOLS, 'brand_new_private_tool'] });
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => { errors.push(args.join(' ')); };
  try { mod.apply(ctx); } finally { console.error = originalError; }
  assert.ok(calls.hidden.has('brand_new_private_tool'), '名单外的名字也必须被藏掉（allow 收敛兜底）');
  assert.ok(errors.some((line) => /不在已知名单里/.test(line)), `应提示更新名单：${errors.join(' | ')}`);
});

await test('parseKnownGlobalTools / probeKnownGlobalTools 的边界', async () => {
  const mod = await loadPlugin(path.join(tmpDir, 'diag-parse.log'));
  // (none) 当空集，不是当一个名字
  assert.deepEqual(mod.parseKnownGlobalTools('x; known global tools: (none)'), []);
  assert.deepEqual(mod.parseKnownGlobalTools('x; known global tools:'), []);
  assert.deepEqual(mod.parseKnownGlobalTools('x; known global tools: a, b, c'), ['a', 'b', 'c']);
  // 没有清单尾巴 → undefined（调用方退回旧行为）
  assert.equal(mod.parseKnownGlobalTools('unknown global tool "a";'), undefined);
  // 探测：restrict 不抛错（未来放宽）时返回 undefined
  assert.equal(mod.probeKnownGlobalTools(() => undefined), undefined);
});

await test('restrict 一次成功时不写诊断文件（不制造噪声）', async () => {
  const diag = path.join(tmpDir, 'diag-ok.log');
  const mod = await loadPlugin(diag);
  // 全局层只有白名单工具 ⇒ 无需隐藏，也就不该打诊断
  const { ctx, calls } = makeCtx({ known: ['mcp__snowluma__qq_send_message', 'ask_user_question'] });
  mod.apply(ctx);
  assert.equal(calls.hidden.size, 0, '全是白名单时应一个都不藏');
  assert.equal(fs.existsSync(diag), false, '无事可做时不该产生诊断文件');
});

await test('执行期 guard 照旧：QQ MCP 放行、dev_* 与本地工具拒绝', async () => {
  const diag = path.join(tmpDir, 'diag-guard.log');
  const mod = await loadPlugin(diag);
  const { ctx, calls } = makeCtx({ known: REAL_GLOBAL_TOOLS });
  mod.apply(ctx);
  assert.equal(typeof calls.guard, 'function', '必须注册执行期 guard');
  const guard = calls.guard;
  for (const name of ['mcp__snowluma__qq_send_message', 'mcp__snowluma-host__snowluma_status', 'mcp__web-search-safe__web_search', 'ask_user_question', 'todo_write']) {
    assert.equal(guard({ name }), undefined, `${name} 应放行`);
  }
  for (const name of ['dev_inject_plugin', 'dev_plugin_status', 'pwsh', 'read', 'write', 'dsh_snapshot', 'skill']) {
    assert.match(String(guard({ name })), /不在 QQ 桥接白名单内/, `${name} 必须拒绝`);
  }
  assert.match(String(guard({ name: '' })), /工具名无效/);
  assert.match(String(guard({})), /工具名无效/);
});

// ── 三档权限分级的执行期判定（2026-10-26） ──────────────────────────────────
//
// 同一份守卫被三个 preset 共用，靠行级 config.mode 区分档位。这里钉住"哪个 mode 放行
// 什么"——尤其是两条最容易写错的边界：
//   · open（owner）**不是**"什么都不拦"：宿主/开发/装载权类工具永不授予；
//   · readonly 只多放 read / read_image / glob / grep，write / edit / pwsh 必须拒绝。
await test('normalizeRestrictMode：缺省/空串=strict，未知值按 strict 处理（不静默通过）', async () => {
  const diag = path.join(tmpDir, 'diag-mode-normalize.log');
  const mod = await loadPlugin(diag);
  assert.equal(mod.normalizeRestrictMode(undefined), 'strict');
  assert.equal(mod.normalizeRestrictMode(''), 'strict');
  assert.equal(mod.normalizeRestrictMode('  '), 'strict');
  assert.equal(mod.normalizeRestrictMode('OPEN'), 'open', '大小写不敏感');
  assert.equal(mod.normalizeRestrictMode(' readonly '), 'readonly');
  // 拼错的值必须落到 strict（fail-closed），而不是抛错、也不是悄悄放行。
  for (const bad of ['opne', 'read-only', 'open2', 'true', 'admin', 1, {}]) {
    assert.equal(mod.normalizeRestrictMode(bad), 'strict', `${JSON.stringify(bad)} 必须按 strict 处理`);
  }
});

await test('toolGuardReason：三档矩阵（strict / readonly / open）', async () => {
  const diag = path.join(tmpDir, 'diag-mode-matrix.log');
  const mod = await loadPlugin(diag);
  const { toolGuardReason, MODES } = mod;
  const allows = (mode, name) => toolGuardReason(mode, { name }) === undefined;
  const denies = (mode, name) => typeof toolGuardReason(mode, { name }) === 'string';

  const mcp = ['mcp__snowluma__qq_send_message', 'mcp__snowluma-host__snowluma_status', 'mcp__web-search-safe__web_fetch'];
  const readonlyTools = ['read', 'read_image', 'glob', 'grep'];
  // 只有 qq-chat-owner **实际挂载**的能力才在 open 档放行：写文件来自 dsh-tool-fs，
  // 执行来自 dsh-tool-pwsh。`str_replace_editor`（另一个包）owner preset 并没有挂，
  // 所以它属于"不可授予"——见下面单独断言。
  const writeTools = ['write', 'edit'];
  const execTools = ['pwsh', 'bash'];
  const neverGranted = ['dev_inject_plugin', 'plugin_manager', 'session_search', 'subagent', 'job_list', 'schedule_create', 'read_mcp_resource', 'working_directory', 'load_workspace_dependencies', 'str_replace_editor'];

  for (const mode of Object.values(MODES)) {
    for (const name of [...mcp, 'ask_user_question', 'todo_write']) {
      assert.ok(allows(mode, name), `${mode}: ${name} 应放行`);
    }
    for (const name of neverGranted) {
      assert.ok(denies(mode, name), `${mode}: ${name} 永不授予（含 owner 档）`);
    }
  }
  assert.ok(allows(MODES.STRICT, 'read') === false, 'strict：连只读工具都没有');
  assert.ok(denies(MODES.STRICT, 'read'));
  for (const name of readonlyTools) {
    assert.ok(allows(MODES.READONLY, name), `readonly: ${name} 应放行`);
    assert.ok(allows(MODES.OPEN, name), `open: ${name} 应放行`);
  }
  for (const name of [...writeTools, ...execTools]) {
    assert.ok(denies(MODES.READONLY, name), `readonly: ${name} 必须拒绝（白名单档只能看）`);
    assert.ok(allows(MODES.OPEN, name), `open: ${name} 应放行（owner 要能改能跑）`);
  }
  assert.match(String(toolGuardReason(MODES.READONLY, { name: 'write' })), /只读白名单/);
});

await test('apply 真的按行级 config.mode 建 guard（open / readonly / 未知值）', async () => {
  const diag = path.join(tmpDir, 'diag-mode-apply.log');
  const mod = await loadPlugin(diag);
  const build = (config) => {
    const { ctx, calls } = makeCtx({ known: REAL_GLOBAL_TOOLS });
    mod.apply(ctx, config);
    return calls;
  };
  // open：本地能力放行，宿主/装载权类仍然拒绝
  const open = build({ mode: 'open' });
  assert.equal(open.guard({ name: 'pwsh' }), undefined, 'open 档必须能执行命令');
  assert.equal(open.guard({ name: 'write' }), undefined, 'open 档必须能写文件');
  assert.ok(open.guard({ name: 'dev_inject_plugin' }), 'open 档也不授予开发注入器');
  assert.ok(open.guard({ name: 'plugin_manager' }), 'open 档也不授予插件装载权');
  // readonly：能读不能写/执行
  const readonly = build({ mode: 'readonly' });
  assert.equal(readonly.guard({ name: 'read' }), undefined, 'readonly 档必须能看文件');
  assert.ok(readonly.guard({ name: 'write' }), 'readonly 档不能写文件');
  assert.ok(readonly.guard({ name: 'pwsh' }), 'readonly 档不能执行命令');
  // 无 config / 未知 mode：等同 strict（现状不变）
  for (const config of [undefined, {}, { mode: 'opne' }]) {
    const strict = build(config);
    assert.ok(strict.guard({ name: 'read' }), `${JSON.stringify(config)} 必须按 strict 处理`);
    assert.equal(strict.guard({ name: 'mcp__snowluma__qq_send_message' }), undefined);
  }
  // 三档共用同一份收敛结果：open 也要把非白名单工具从 schema 里藏掉
  // （2026-11-02：判据从「藏满 82 个名单」改成「全局层里非白名单的一个不剩」，
  //  因为旧的 82 个里绝大多数在本机根本不存在，数它们只会掩盖真正没挡住的名字。）
  const nonWhitelisted = REAL_GLOBAL_TOOLS.filter(
    (name) => !name.startsWith('mcp__') && name !== 'ask_user_question' && name !== 'todo_write'
  );
  for (const name of nonWhitelisted) {
    assert.ok(open.hidden.has(name), `open 档也要藏掉 ${name}`);
  }
});

fs.rmSync(tmpDir, { recursive: true, force: true });
console.log(`\n${failures ? 'FAILED' : 'ALL PASS'}  tests=${tests} failures=${failures}`);
if (failures) process.exit(1);
