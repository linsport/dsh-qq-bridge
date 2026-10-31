// 人格卡按仿真模式取用（src/role-card.js）的离线单测。
// 保证：模式标记能被正确识别与剥离、未标记的老卡片行为不变、真实人格卡可用。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { parseRoleSections, roleCharStats, roleSectionReport, selectRoleText } from '../src/role-card.js';

const CARD = [
  '# 角色卡：测试',
  '',
  '## 一、你是谁',
  '- 你是群里的测试角色。',
  '',
  '## 二、分条方式 〔一代〕',
  '- 想分条就用空格分隔；想沉默就输出 [SILENT]。',
  '',
  '## 三、发言方式 〔二代〕',
  '- 用 qq_send_message 的数组分条，潜水走 qq_mark_read。',
  '',
  '## 四、说话风格',
  '- 简短、口语化。',
].join('\n');

test('模式标记能被识别，未标记的小节两种模式都注入', () => {
  const sections = parseRoleSections(CARD);
  const byHeading = Object.fromEntries(sections.filter((s) => s.heading).map((s) => [s.heading, s.mode]));
  assert.equal(byHeading['一、你是谁'], 'all');
  assert.equal(byHeading['二、分条方式'], 'v1');
  assert.equal(byHeading['三、发言方式'], 'v2');
  assert.equal(byHeading['四、说话风格'], 'all');
});

test('按模式筛选：只保留公共小节 + 该模式专属小节', () => {
  const v1 = selectRoleText(CARD, 'v1');
  const v2 = selectRoleText(CARD, 'v2');
  // 公共内容两边都有
  for (const text of [v1, v2]) {
    assert.match(text, /你是群里的测试角色/);
    assert.match(text, /简短、口语化/);
  }
  // 专属内容互不串场
  assert.match(v1, /空格分隔/);
  assert.doesNotMatch(v1, /qq_send_message/);
  assert.match(v2, /qq_send_message/);
  assert.doesNotMatch(v2, /\[SILENT\]/);
});

test('注入文本里不再残留模式标记', () => {
  assert.doesNotMatch(selectRoleText(CARD, 'v1'), /〔一代〕|〔二代〕/);
  assert.doesNotMatch(selectRoleText(CARD, 'v2'), /〔一代〕|〔二代〕/);
  // 标题保留但已清洗
  assert.match(selectRoleText(CARD, 'v2'), /## 三、发言方式\n/);
});

test('多种标记写法都认（[v1] / （reserved2） / 2 代）', () => {
  const card = [
    '## A [v1]', '- a',
    '## B （reserved2）', '- b',
    '## C 〔2 代〕', '- c',
    '## D [一代]', '- d',
  ].join('\n');
  const v1 = selectRoleText(card, 'v1');
  const v2 = selectRoleText(card, 'v2');
  assert.match(v1, /- a/); assert.match(v1, /- d/);
  assert.doesNotMatch(v1, /- b/); assert.doesNotMatch(v1, /- c/);
  assert.match(v2, /- b/); assert.match(v2, /- c/);
  assert.doesNotMatch(v2, /- a/); assert.doesNotMatch(v2, /- d/);
});

test('没有模式标记的老卡片：两种模式都完整注入（向后兼容）', () => {
  const legacy = '# 老卡\n\n- 性格：傲娇\n- 说话风格：简短';
  assert.equal(selectRoleText(legacy, 'v1'), legacy);
  assert.equal(selectRoleText(legacy, 'v2'), legacy);
});

test('标题之外的内容（前言）不受影响', () => {
  const card = '开头一句话\n\n## X 〔一代〕\n- x\n\n## Y\n- y';
  assert.match(selectRoleText(card, 'v2'), /开头一句话/);
  assert.doesNotMatch(selectRoleText(card, 'v2'), /- x/);
  assert.match(selectRoleText(card, 'v2'), /- y/);
});

test('统计与小节报告可用于控制台预览', () => {
  const stats = roleCharStats(CARD);
  assert.ok(stats.v1Only > 0 && stats.v2Only > 0, '应能统计出两代各自专属的字符数');
  assert.ok(stats.v1 < stats.total && stats.v2 < stats.total, '筛选后应短于原文');
  assert.notEqual(stats.v1, stats.v2, '两代内容不同，长度不应相等');
  const report = roleSectionReport(CARD, 'v1');
  const v2Section = report.find((r) => r.heading === '三、发言方式');
  assert.equal(v2Section.injected, false, '二代专属小节在一代下应标为不注入');
  const common = report.find((r) => r.heading === '一、你是谁');
  assert.equal(common.injected, true);
});

test('真实人格卡可用，且筛选不丢公共内容', () => {
  const file = new URL('../roles/小鲸鱼.md', import.meta.url);
  const raw = fs.readFileSync(file, 'utf8');
  const v2 = selectRoleText(raw, 'v2');
  const v1 = selectRoleText(raw, 'v1');
  assert.ok(v2.length > 0 && v1.length > 0);
  // 人设部分两种模式都必须保留
  for (const text of [v1, v2]) {
    assert.match(text, /小鲸鱼/);
    assert.match(text, /AI 味|去 AI 味/);
  }
  // 二代注入的文本里不应再出现一代的分条机制
  assert.doesNotMatch(v2, /空格分隔（例如|\[SILENT\]/);
});

// 2026-10-31 审查发现：parseRoleSections 按 '\n' 切行，CRLF 文件切完每行尾留一个 \r，
// 标题正则 /^(#{1,6})\s+(.*)$/ 没有 m 标志、(.*) 又不吃 \r，于是「# 标题」整行匹配失败。
// 后果是整份卡退化成一节 heading=null —— 模式过滤静默失效，两代专属指令一起注入。
// 表现极隐蔽：不报错、不告警，只有控制台的小节预览看起来"怪怪的"。
test('CRLF 人格卡的分节结果与 LF 完全一致（模式过滤不能静默失效）', () => {
  const crlf = CARD.replace(/\n/g, '\r\n');
  const lfSections = parseRoleSections(CARD).map((s) => `${s.mode}:${s.heading}`);
  const crlfSections = parseRoleSections(crlf).map((s) => `${s.mode}:${s.heading}`);
  assert.deepEqual(crlfSections, lfSections, 'CRLF 与 LF 必须切出同样的小节');

  // 关键：模式过滤在 CRLF 下也要真的生效
  const v2 = selectRoleText(crlf, 'v2');
  assert.match(v2, /qq_send_message/, '二代专属小节要被注入');
  assert.doesNotMatch(v2, /\[SILENT\]/, '一代专属小节不能被注入');
  assert.doesNotMatch(v2, /〔一代〕|〔二代〕/, '注入文本里不能残留模式标记');
});

test('行尾混用（部分 CRLF、部分 LF）也能正确分节', () => {
  const mixed = CARD.split('\n').map((line, i) => (i % 2 === 0 ? `${line}\r\n` : `${line}\n`)).join('');
  const sections = parseRoleSections(mixed).filter((s) => s.heading);
  const modes = sections.map((s) => `${s.heading}:${s.mode}`);
  assert.ok(modes.includes('二、分条方式:v1'), `应认出 v1 小节，实际=${modes.join('|')}`);
  assert.ok(modes.includes('三、发言方式:v2'), `应认出 v2 小节，实际=${modes.join('|')}`);
});

test('真实 CRLF 人格卡（roles/README.md）也能切出多个小节', () => {
  // README.md 是仓库里唯一用 CRLF 的 roles 文件，拿它当真实样本。
  const raw = fs.readFileSync(new URL('../roles/README.md', import.meta.url), 'utf8');
  assert.ok(raw.includes('\r\n'), '这份样本应当确实是 CRLF，否则这条用例失去意义');
  const sections = parseRoleSections(raw);
  assert.ok(sections.length > 3, `CRLF 文件不应退化成一节，实际解析出 ${sections.length} 节`);
  assert.ok(sections.some((s) => s.heading), '至少要有带标题的小节');
});
