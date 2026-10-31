// 跨会话共享记忆（sharedNotes）回归：一条事实写一次，所有会话都看得到。
//
// 钉住的边界（每条都对应一个具体的失败形态）：
//   1. 全局一份，不挂在任何会话 state 上 —— 否则「共享」就成了「各写各的」；
//   2. 去重按整句：同一个群把同一句话说第二遍，不该存两条、也不该占两份注入预算；
//   3. 注入不串台也不偏科：任何会话都能看到全部内容，只是标出「来自哪」；
//   4. 持久化：重启后还在（它不在 conversations 里，独立于会话生命周期）；
//   5. 清空语义：清空本会话全部**不碰**共享记忆；只有明确 shared 才动它。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { bridgeHarness } from './audit-bridge-harness.mjs';

let failures = 0;
async function test(name, run) {
  try { await run(); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, '—', error?.stack ?? error); }
}

const ADMIN = { 'x-console-token': 'fixture-console-token' };

function call(port, pathname, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: '127.0.0.1', port, path: pathname, method, headers: { 'content-type': 'application/json', ...headers } },
      (response) => {
        let data = '';
        response.on('data', (chunk) => { data += chunk; });
        response.on('end', () => {
          let json = null;
          try { json = JSON.parse(data); } catch {}
          resolve({ status: response.statusCode, body: data, json });
        });
      }
    );
    request.on('error', reject);
    request.setTimeout(5000, () => request.destroy(new Error('request hung')));
    request.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

async function withServer(h, run) {
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  try { await run(server.address().port); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

// ── 1. 全局一份 ───────────────────────────────────────────────────────────────
await test('写一次，所有会话都能看到', async () => {
  const h = await bridgeHarness();
  try {
    h.appendSharedNoteV2('主人养了一只叫「年糕」的猫', 'group:111');
    const fromA = h.formatSharedNotesV2('group:111');
    const fromB = h.formatSharedNotesV2('group:222');
    assert.ok(fromA.includes('年糕'), '写入的会话自己要看得到');
    assert.ok(fromB.includes('年糕'), '另一个会话也必须看得到 —— 这就是共享的意义');
    assert.ok(fromB.includes('（来自 group:111）'), '别的会话写入的要标出来源');
    assert.ok(!fromA.includes('（来自 group:111）'), '自己写的东西不用标自己的来源');
  } finally { await h.close(); }
});

// ── 2. 去重按整句 ─────────────────────────────────────────────────────────────
await test('同一句话写两遍只存一条，只刷新最近碰过的时间', async () => {
  const h = await bridgeHarness();
  try {
    const first = h.appendSharedNoteV2('他讨厌被叫「老板」', 'group:111');
    const t1 = first.createdAt;
    await new Promise((r) => setTimeout(r, 5));
    const second = h.appendSharedNoteV2('他讨厌被叫「老板」', 'group:222');
    assert.equal(second.createdAt, t1, '重复写入不该新建条目');
    assert.equal(second.from, 'group:222', '来源更新为最近写入的那个会话');
    assert.equal(h.socialV2.sharedNotes.length, 1, '库里只能有一条');
  } finally { await h.close(); }
});

// ── 3. 空的时候整段不出现 ─────────────────────────────────────────────────────
await test('没有共享记忆时注入段整段消失（空段落会误导模型）', async () => {
  const h = await bridgeHarness();
  try {
    assert.equal(h.formatSharedNotesV2('group:111'), '', '空的时候必须返回空串，不是带标题的空段');
    h.appendSharedNoteV2('   ', 'group:111');
    assert.equal(h.socialV2.sharedNotes.length, 0, '全空白的写入不落盘');
  } finally { await h.close(); }
});

// ── 4. 持久化 ────────────────────────────────────────────────────────────────
await test('重启后共享记忆还在（独立于会话生命周期）', async () => {
  const h = await bridgeHarness();
  let persisted = '';
  try {
    h.appendSharedNoteV2('答应过周六发一条空间', 'private:123');
    h.saveSocialV2State();
    const file = path.join(h.temp, 'state', 'social-v2.json');
    assert.ok(fs.existsSync(file), '必须写入 state/social-v2.json');
    persisted = fs.readFileSync(file, 'utf8');
    const onDisk = JSON.parse(persisted);
    assert.ok(Array.isArray(onDisk.sharedNotes), 'sharedNotes 要落在状态文件顶层，不在某个会话里');
    assert.equal(onDisk.sharedNotes[0].text, '答应过周六发一条空间');
    assert.equal(onDisk.sharedNotes[0].from, 'private:123');
  } finally { await h.close(); }

  const h2 = await bridgeHarness({ files: { 'state/social-v2.json': persisted } });
  try {
    assert.ok(h2.formatSharedNotesV2('group:999').includes('答应过周六发一条空间'), '重启后任何会话都还看得到');
  } finally { await h2.close(); }
});

// ── 5. 删除与清空语义 ────────────────────────────────────────────────────────
await test('删除按整句命中；清空本会话全部不碰共享记忆', async () => {
  const h = await bridgeHarness();
  try {
    h.appendSharedNoteV2('这条要删掉', 'group:111');
    h.appendSharedNoteV2('这条要留着', 'group:111');
    assert.equal(h.removeSharedNoteV2('不存在的句子'), false, '没命中要返回 false');
    assert.equal(h.removeSharedNoteV2('这条要删掉'), true, '命中要返回 true');
    assert.equal(h.socialV2.sharedNotes.length, 1);

    await withServer(h, async (port) => {
      // 清空本会话全部（不传 category）：共享记忆必须无损
      const cleared = await call(port, '/api/socialV2/memory-clear', {
        method: 'POST', headers: ADMIN, body: { key: 'group:111', category: '' }
      });
      assert.equal(cleared.status, 200);
      assert.equal(h.socialV2.sharedNotes.length, 1, '清空本会话不得波及全局共享记忆');

      // 明确 shared 才清
      const clearedShared = await call(port, '/api/socialV2/memory-clear', {
        method: 'POST', headers: ADMIN, body: { key: 'group:111', category: 'shared' }
      });
      assert.equal(clearedShared.status, 200);
      assert.equal(h.socialV2.sharedNotes.length, 0, '明确指定 shared 才清空');
    });
  } finally { await h.close(); }
});

// ── 6. HTTP 三件套：append / query / remove ──────────────────────────────────
await test('HTTP 接口能写、能按 shared 单独查、能按原文删', async () => {
  const h = await bridgeHarness();
  try {
    h.setMode('reserved2');
    await withServer(h, async (port) => {
      const added = await call(port, '/api/socialV2/memory-append', {
        method: 'POST', headers: ADMIN, body: { key: 'group:111', category: 'shared', content: '他的生日是三月十七' }
      });
      assert.equal(added.status, 200, 'shared 是合法类别');
      assert.ok(added.json.memory.includes('他的生日是三月十七'), '写入后回显要带这段');

      const queried = await call(port, '/api/socialV2/memory?key=group%3A111&category=shared', { headers: ADMIN });
      assert.equal(queried.status, 200);
      assert.equal(queried.json.raw.sharedNotes.length, 1);
      assert.equal(queried.json.raw.activeTopics.length, 0, 'category=shared 时只回共享记忆');
      assert.ok(queried.json.formatted.includes('【跨会话共享记忆】'));

      const otherKey = await call(port, '/api/socialV2/memory?key=group%3A222&category=shared', { headers: ADMIN });
      assert.equal(otherKey.json.raw.sharedNotes.length, 1, '换个会话查同一份');

      const removed = await call(port, '/api/socialV2/memory-remove', {
        method: 'POST', headers: ADMIN, body: { key: 'group:111', category: 'shared', content: '他的生日是三月十七' }
      });
      assert.equal(removed.status, 200);
      assert.equal(h.socialV2.sharedNotes.length, 0);

      const missing = await call(port, '/api/socialV2/memory-remove', {
        method: 'POST', headers: ADMIN, body: { key: 'group:111', category: 'shared', content: '从来没写过的话' }
      });
      assert.equal(missing.status, 404, '删不存在的要 404，不能假装成功');
    });
  } finally { await h.close(); }
});

// ── 7. 上限与淘汰 ────────────────────────────────────────────────────────────
await test('超过上限按「最久没碰」淘汰，反复提到的事留下', async () => {
  const h = await bridgeHarness();
  try {
    h.appendSharedNoteV2('我一直被提起', 'group:111');
    for (let i = 0; i < 80; i++) h.appendSharedNoteV2(`一次性事实 ${i}`, 'group:111');
    assert.ok(h.socialV2.sharedNotes.length <= 60, `上限之内，实际 ${h.socialV2.sharedNotes.length}`);
    // 淘汰规则是「最久没碰」：一直没人再提的自然沉底。所以再提一次就该留下。
    h.appendSharedNoteV2('我一直被提起', 'group:111');
    for (let i = 80; i < 90; i++) h.appendSharedNoteV2(`又一批 ${i}`, 'group:111');
    const stillThere = h.socialV2.sharedNotes.some((n) => n.text === '我一直被提起');
    assert.equal(stillThere, true, '刚被碰过的那条不该被后来的写入挤掉');
    assert.equal(h.socialV2.sharedNotes.length, 60, '超上限后稳定在 60 条');
  } finally { await h.close(); }
});

// ── 8. 唤醒提示词每轮都带 ────────────────────────────────────────────────────
await test('唤醒提示词每轮都带共享记忆（不像 selfNote 只在 bootstrap）', async () => {
  const h = await bridgeHarness();
  try {
    h.appendSharedNoteV2('他的猫叫年糕', 'group:111');
    for (const reason of ['bootstrap', 'question', 'timeout', 'replyCheck', 'proactiveCheck', 'poke']) {
      const prompt = h.buildWakePromptV2('group:111', reason);
      assert.ok(prompt.includes('他的猫叫年糕'), `${reason} 唤醒也要带共享记忆`);
    }
  } finally { await h.close(); }
});

// ── 8. 自我认知（selfNote）的读取与清空 ──────────────────────────────────────
// 控制台把它和共享记忆并排展示，两条路径必须都能走通：
//   · GET /api/socialV2/memory 要回 selfNotes（控制台那一块靠它渲染）；
//   · memory-clear 传 selfNote 要能清，但「清空本会话全部」不能顺手抹掉它 ——
//     那是它自己一路写下来的日记，和话题/印象的性质不一样。
await test('selfNote 能查；明确点名才清空，清空全部不波及', async () => {
  const h = await bridgeHarness();
  try {
    h.setMode('reserved2');
    await withServer(h, async (port) => {
      const added = await call(port, '/api/socialV2/memory-append', {
        method: 'POST', headers: ADMIN, body: { key: 'group:111', category: 'selfNote', content: '我最近好像越来越爱用省略号了' }
      });
      assert.equal(added.status, 200, 'selfNote 是合法类别');

      const queried = await call(port, '/api/socialV2/memory?key=group%3A111', { headers: ADMIN });
      assert.equal(queried.status, 200);
      assert.equal(queried.json.raw.selfNotes.length, 1, '控制台要靠 raw.selfNotes 渲染这一块');
      assert.equal(queried.json.raw.selfNotes[0].text, '我最近好像越来越爱用省略号了');

      const clearedAll = await call(port, '/api/socialV2/memory-clear', {
        method: 'POST', headers: ADMIN, body: { key: 'group:111', category: '' }
      });
      assert.equal(clearedAll.status, 200);
      assert.equal(h.getSocialV2State('group:111').selfNotes.length, 1, '清空本会话全部不得抹掉自我认知');

      const clearedSelf = await call(port, '/api/socialV2/memory-clear', {
        method: 'POST', headers: ADMIN, body: { key: 'group:111', category: 'selfNote' }
      });
      assert.equal(clearedSelf.status, 200, '明确指定 selfNote 要能清');
      assert.equal(h.getSocialV2State('group:111').selfNotes.length, 0);
    });
  } finally { await h.close(); }
});

console.log(failures === 0 ? '\n🎉 跨会话共享记忆测试通过' : `\n❌ ${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
