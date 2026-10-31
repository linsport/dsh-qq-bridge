#!/usr/bin/env node
// 媒体项归类与失败判定（src/media-items.js）。
//
// 这段逻辑被两次真实故障逼出来，用例就照着那两次写：
//  1. 2026-10-30 群 100002：2.72MB 的图压不动，桥接仍回 ok:true + 一条说明文字，
//     工具打绿勾，模型以为自己看过。→ 有真图片却一项像素都没拿到，必须判失败。
//  2. 2026-10-31 同群 #151：faceId=264「捂脸」，服务端给不出 PNG，只有名字。
//     → 全是 QQ 系统小表情时判失败是误报，群里每发一次小表情就红一次。

import assert from 'node:assert/strict';
import { classifyMediaItems, describeMediaItems } from '../src/media-items.js';

let pass = 0;
let fail = 0;
const t = (name, fn) => {
  try { fn(); console.log(`✔ ${name}`); pass += 1; }
  catch (e) { console.log(`✖ ${name}\n    ${e.message}`); fail += 1; }
};

const DATA = 'AAAA';
const bitmap = (index = 1) => ({ index, kind: 'image', mimeType: 'image/jpeg', data: DATA, text: '' });
const faceOnly = (index = 1, text = '[表情:/捂脸]', faceId = '264') => ({ index, kind: 'face', faceId, text });
const faceNoPixel = (index = 1, text = '（获取失败：ffmpeg 退出码 -5）') => ({ index, kind: 'image', text });

// ── 判失败：有真图片、一项像素都没拿到 ─────────────────────────────────
t('图片压不动（只有说明文字）判失败', () => {
  const c = classifyMediaItems([faceNoPixel(1, '不提供：2.72MB 压不到 1024KB 以内')]);
  assert.equal(c.bitmapItems, 1);
  assert.equal(c.bitmapGot, 0);
  assert.equal(c.isFailure, true);
});

t('图片和表情包都失败时判失败', () => {
  const c = classifyMediaItems([
    faceNoPixel(1),
    { index: 2, kind: 'sticker', text: '（获取失败）' }
  ]);
  assert.equal(c.bitmapItems, 2);
  assert.equal(c.isFailure, true);
});

// ── 不判失败：全是 QQ 系统小表情 ───────────────────────────────────────
t('只有 QQ 系统小表情时不判失败', () => {
  const c = classifyMediaItems([faceOnly()]);
  assert.equal(c.bitmapItems, 0);
  assert.equal(c.isFailure, false);
  assert.deepEqual(c.faceNames, ['[表情:/捂脸]']);
  assert.equal(c.images.length, 0);
});

t('多个小表情也都不判失败', () => {
  const c = classifyMediaItems([faceOnly(1, '[表情:/微笑]', '1'), faceOnly(2, '[表情:/流泪]', '5')]);
  assert.equal(c.isFailure, false);
  assert.equal(c.faceNames.length, 2);
});

t('小表情连 faceId 都没有时不拼出空的 [表情#]', () => {
  // 旧实现 `img.text || `[表情#${img.faceId ?? ''}]`` 会产出 '[表情#]' —— 一个空的井号，
  // 看上去像编号丢了，其实是压根没有编号。
  const c = classifyMediaItems([{ index: 1, kind: 'face' }]);
  assert.equal(c.isFailure, false);
  assert.deepEqual(c.faceNames, ['[表情]']);
  assert.ok(!c.textParts.join('').includes('[表情#]'), '不该出现空的井号');
});
t('小表情连名字都没有时也不判失败（回退成 id）', () => {
  const c = classifyMediaItems([{ index: 1, kind: 'face', faceId: '999' }]);
  assert.equal(c.isFailure, false);
  assert.deepEqual(c.faceNames, ['[表情#999]']);
});

// ── 混合：拿到一张真的就算成功 ─────────────────────────────────────────
t('真图片 + 失败的小表情：拿到像素就不判失败', () => {
  const c = classifyMediaItems([bitmap(1), faceOnly(2)]);
  assert.equal(c.bitmapItems, 1);
  assert.equal(c.bitmapGot, 1);
  assert.equal(c.isFailure, false);
  assert.equal(c.images.length, 1);
  assert.equal(c.faceNames.length, 1);
});

t('小表情 + 压不动的图片：仍按图片判失败', () => {
  const c = classifyMediaItems([faceOnly(1), faceNoPixel(2)]);
  assert.equal(c.bitmapItems, 1);
  assert.equal(c.bitmapGot, 0);
  assert.equal(c.isFailure, true);
});

t('拿到像素的小表情不算 bitmapItems（避免全小表情被误判）', () => {
  const c = classifyMediaItems([{ index: 1, kind: 'face', mimeType: 'image/png', data: DATA, text: '[表情:/捂脸]' }]);
  assert.equal(c.bitmapItems, 0);
  assert.equal(c.isFailure, false);
  assert.equal(c.images.length, 1);
});

// ── 文案 ───────────────────────────────────────────────────────────────
t('文案列出项数、每项一行，并给小表情加一句「没有像素」', () => {
  const c = classifyMediaItems([faceOnly(1)]);
  const text = describeMediaItems('1262800596', c, 1);
  assert.match(text, /^消息 1262800596 的媒体内容（1 项）：/);
  assert.match(text, /\[表情1 \[表情:\/捂脸\]\]/);
  assert.match(text, /QQ 系统小表情/);
  assert.match(text, /不用为看不到去重试或换工具找图/);
});

t('没有小表情时不加那句解释（免得每张图都多一段）', () => {
  const c = classifyMediaItems([faceNoPixel(1)]);
  const text = describeMediaItems('1', c, 1);
  assert.doesNotMatch(text, /QQ 系统小表情/);
  assert.match(text, /获取失败/);
});

t('空项时返回空串', () => {
  assert.equal(describeMediaItems('1', classifyMediaItems([]), 0), '');
});

t('入参不是数组时不炸', () => {
  const c = classifyMediaItems(null);
  assert.equal(c.isFailure, false);
  assert.equal(c.textParts.length, 0);
  assert.equal(c.images.length, 0);
});

console.log(fail === 0 ? `\n媒体项归类：${pass} 通过，0 失败` : `\n媒体项归类：${pass} 通过，${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
