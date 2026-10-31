// 撞上发送频率上限时，报错必须告诉模型「还能发几条 / 要等多少秒」。
//
// 为什么值得单独测：原来四个发送端点一律回「发送频率超限，请稍后再试」，MCP 侧还
// 无条件追加「等几秒再试，别连发」。模型拿不到任何可执行信息，实测 2026-10-30 一天
// 撞了 13 次，其中一次 18:51 连试 4 回（22 / 25 / 31 / 41 秒），每回都白烧一整轮
// 上下文；再走不通它就退回把调用写成文本，触发伪工具调用那一串问题。
import test from 'node:test';
import assert from 'node:assert/strict';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const h = await bridgeHarness();
test.after(async () => { await h.close(); });

const SEND = { maxSendPerMinute: 10, maxSendPerHour: 100 };
const NOW = 1_800_000_000_000;

// 造一个「刚才发过 n 条」的会话状态，每条间隔 1 秒。
function stateWith(sent, { spacingMs = 1000 } = {}) {
  const sendTimes = [];
  for (let i = 0; i < sent; i++) sendTimes.push(NOW - (sent - i) * spacingMs);
  return { sendTimes };
}

test('额度还够时不喊限流，会说现在能发几条', () => {
  const msg = h.rateLimitHintV2(stateWith(9), SEND, 3, NOW);
  assert.match(msg, /每分钟最多 10 条/);
  assert.match(msg, /这一分钟已经发了 9 条/);
  assert.match(msg, /这一批想发 3 条/);
  // 只剩 1 条额度 —— 必须给出「压成 1 条」这个能立刻执行的动作。
  assert.match(msg, /现在还能发 1 条/);
  assert.match(msg, /压成 1 条/);
  // 并且要算出等多久才能发满 3 条。
  assert.match(msg, /等约 \d+ 秒再发/);
});

test('额度已满时给出等待秒数，且不少于 1 秒', () => {
  const msg = h.rateLimitHintV2(stateWith(10), SEND, 1, NOW);
  assert.match(msg, /现在还能发 0 条/);
  assert.match(msg, /这一分钟先别发了/);
  const m = msg.match(/等约 (\d+) 秒再发/);
  assert.ok(m, `应该给出等待秒数，实际：${msg}`);
  const secs = Number(m[1]);
  assert.ok(secs >= 1 && secs <= 60, `等待秒数应在 1~60 之间，实际 ${secs}`);
});

test('最早那条快滑出窗口时，等待时间应该很短', () => {
  // 10 条里最早的一条是 59 秒前，再等 1 秒就腾出额度。
  const sendTimes = [];
  for (let i = 0; i < 9; i++) sendTimes.push(NOW - (9 - i) * 1000);
  sendTimes.unshift(NOW - 59_000);
  const msg = h.rateLimitHintV2({ sendTimes }, SEND, 1, NOW);
  const secs = Number(msg.match(/等约 (\d+) 秒再发/)[1]);
  assert.ok(secs <= 3, `最早一条即将过期时不该让人等太久，实际 ${secs} 秒`);
});

test('只受每小时上限约束时，等的是小时窗口', () => {
  // 一分钟内只有 2 条（没撞分钟线），但这一小时已经发了 100 条。
  const sendTimes = [NOW - 30_000, NOW - 20_000];
  for (let i = 1; i <= 98; i++) sendTimes.push(NOW - 600_000 - i * 20_000);
  const msg = h.rateLimitHintV2({ sendTimes }, SEND, 1, NOW);
  assert.match(msg, /每小时最多 100 条，这一小时已经发了 100 条/);
  const secs = Number(msg.match(/等约 (\d+) 秒再发/)[1]);
  assert.ok(secs > 60, `撞小时线时等待应以分钟计，实际 ${secs} 秒`);
});

test('明确劝退「立刻重试」和「写成文本」', () => {
  const msg = h.rateLimitHintV2(stateWith(10), SEND, 2, NOW);
  assert.match(msg, /不要立刻重试/);
  assert.match(msg, /不要.*写成文本/);
});

test('上限配成 0（关闭限流）时不产生除零或 Infinity 文案', () => {
  const msg = h.rateLimitHintV2(stateWith(5), { maxSendPerMinute: 0, maxSendPerHour: 0 }, 1, NOW);
  assert.ok(!/Infinity|NaN|undefined/.test(msg), `不该出现 Infinity/NaN，实际：${msg}`);
});

test('空会话状态（还没发过任何消息）不崩', () => {
  const msg = h.rateLimitHintV2({}, SEND, 1, NOW);
  assert.match(msg, /发送频率超限/);
  assert.ok(!/NaN|undefined/.test(msg));
});

// computeGapsV2 是相邻两条之间的间隔，末条后面不排队。限流提示里说的「压成 N 条」
// 要真的能发，所以间隔数组长度必须是 N-1，否则发的时候会多等一轮。
test('computeGapsV2 生成的间隔数量恒为 n-1', () => {
  const cfg = { burstIntervalMinMs: 1000, burstIntervalMaxMs: 3000, maxGapMs: 10000 };
  assert.equal(h.computeGapsV2(['a'], 'auto', undefined, undefined, cfg).length, 0);
  assert.equal(h.computeGapsV2(['a', 'b'], 'auto', undefined, undefined, cfg).length, 1);
  assert.equal(h.computeGapsV2(['a', 'b', 'c'], 'auto', undefined, undefined, cfg).length, 2);
});
