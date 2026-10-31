// 黑话学习模块新增功能自检：sources 字段、深度研究 prompt、解析。
import assert from 'node:assert/strict';
import {
  normalizeSlangEntry,
  createSlangEntry,
  parseResearchJson,
  buildResearchPrompt,
  buildSlangContext,
  sanitizeSlangOutputText,
  SLANG_STATUS,
} from '../src/slang-learner.js';

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`✅ ${name}`);
}

// 1. normalize 保留合法 sources，过滤空串并限长
{
  const e = normalizeSlangEntry({
    content: 'yyds',
    sources: ['https://example.com/a', '', ' https://example.com/b '],
  });
  assert.deepEqual(e.sources, ['https://example.com/a', 'https://example.com/b']);
  ok('normalizeSlangEntry 保留/清洗 sources');
}

// 2. createSlangEntry 支持 sources
{
  const e = createSlangEntry({ content: 'xswl', sources: ['https://example.com'] });
  assert.deepEqual(e.sources, ['https://example.com']);
  ok('createSlangEntry 支持 sources');
}

// 3. parseResearchJson 解析 sources
{
  const out = parseResearchJson('[{"content":"yyds","meaning":"永远的神","sources":["https://a",""]}]');
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].sources, ['https://a']);
  ok('parseResearchJson 解析 sources');
}

// 4. buildResearchPrompt 要求深度联网与 sources
{
  const prompt = buildResearchPrompt([{ content: 'yyds', evidence: [{ text: '这波 yyds' }] }]);
  assert.ok(prompt.includes('web_fetch'), 'prompt 应要求 web_fetch 抓正文');
  assert.ok(prompt.includes('"sources"'), 'prompt 应要求输出 sources');
  assert.ok(prompt.includes('深度联网考究'), 'prompt 应强调深度联网考究');
  ok('buildResearchPrompt 深度研究指令');
}

// 5. buildSlangContext 只注入已确认且有含义的词条
{
  const ctx = buildSlangContext([
    { content: 'a', meaning: '甲', status: SLANG_STATUS.CONFIRMED, count: 2 },
    { content: 'b', meaning: '', status: SLANG_STATUS.CONFIRMED, count: 1 },
    { content: 'c', meaning: '丙', status: SLANG_STATUS.CANDIDATE, count: 9 },
  ], 8);
  assert.ok(ctx.includes('a：甲'));
  assert.ok(!ctx.includes('b：'));
  assert.ok(!ctx.includes('c：丙'));
  ok('buildSlangContext 只注入已确认且有含义词条');
}

// 6. buildSlangContext 是「出向」渲染：不能把引号转成 HTML 实体
{
  const ctx = buildSlangContext([
    {
      content: '冒名号',
      meaning: '指冒用别人昵称的"高仿号" & 冒充者',
      usage: '只在重名语境里成立（"顶着名字"）',
      status: SLANG_STATUS.CONFIRMED,
      count: 1,
    },
  ], 8);
  assert.ok(ctx.includes('"高仿号"'), '引号应保持原样');
  assert.ok(ctx.includes('& 冒充者'), '& 应保持原样');
  assert.ok(!ctx.includes('&quot;'), '不应出现 &quot;');
  assert.ok(!ctx.includes('&amp;'), '不应出现 &amp;');
  ok('buildSlangContext 不做 HTML 转义（出向渲染）');
}

// 7. 历史数据里已被转义的实体，渲染时要还原回来
{
  const ctx = buildSlangContext([
    { content: 'a', meaning: '叫&quot;高仿号&quot;', status: SLANG_STATUS.CONFIRMED, count: 1 },
  ], 8);
  assert.ok(ctx.includes('叫"高仿号"'), '旧数据里的实体应被还原');
  assert.ok(!ctx.includes('&quot;'), '渲染结果不应残留实体');
  ok('buildSlangContext 还原旧数据里的 HTML 实体');
}

// 8. sanitizeSlangOutputText 的边界：大小写、未知实体、控制字符
{
  assert.equal(sanitizeSlangOutputText('&QUOT;x&QUOT;'), '"x"', '大写实体也要还原');
  assert.equal(sanitizeSlangOutputText('&nbsp;'), '&nbsp;', '不认识的实体原样保留');
  assert.equal(sanitizeSlangOutputText('a\u0000b\u0007c'), 'abc', '控制字符应去掉');
  assert.equal(sanitizeSlangOutputText(null), '', 'null 安全');
  ok('sanitizeSlangOutputText 处理大小写/未知实体/控制字符');
}

// 9. 注入块里的多行文本要压成单行，否则会把黑话表撑散
{
  const ctx = buildSlangContext([
    { content: 'a', meaning: '第一行\n第二行', status: SLANG_STATUS.CONFIRMED, count: 1 },
  ], 8);
  const line = ctx.split('\n').find((l) => l.startsWith('- a'));
  assert.ok(line.includes('第一行 第二行'), '换行应压成空格');
  assert.equal(ctx.split('\n').filter((l) => l.startsWith('- ')).length, 1, '仍是一行一个词条');
  ok('buildSlangContext 把词条内换行压成单行');
}

console.log(`\n🎉 黑话学习新增逻辑测试通过（${passed} 项）`);
