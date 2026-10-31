// 二代“对面没说完 / 结束前等待”逻辑测试。
// 验证：
// 1. looksLikeUnfinished 能识别常见“话说一半”的结尾；
// 2. 已说完的句子不会被误判；
// 3. 配置里有足够长的等待上限（曾经由 END_ROUND_WAIT_MAX_MS 硬编码，
//    2026-10-31 清掉那三个零消费点的常量后，改为直接盯配置）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { looksLikeUnfinished } from '../src/v2-wait.js';

// 「结束前再等一轮」的长等待下限。原先是 src/v2-wait.js 里导出的常量，
// 但没有任何生产代码读它 —— 真正的开关是 config.json 的 socialV2.wait.maxMs。
const END_ROUND_WAIT_MAX_MS = 10 * 60 * 1000;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

let failed = 0;
function assert(cond, label) {
  if (cond) {
    console.log(`✅ ${label}`);
  } else {
    console.error(`❌ ${label}`);
    failed = 1;
  }
}

// 1. 未说完特征
const unfinishedCases = [
  '你知道',
  '等一下',
  '我跟你讲',
  '但是',
  '所以说',
  '然后',
  '那个',
  '就是',
  '我想说',
  '对了',
  '等我',
  '等等',
  '我看看',
  '还有',
  '再说',
  '主要是',
  '回头说',
  '待会',
  '再说吧',
  '你听我说，'
];
for (const text of unfinishedCases) {
  assert(looksLikeUnfinished(text) === true, `未说完判定 true: ${JSON.stringify(text)}`);
}

// 2. 已说完/普通消息不应误判
const finishedCases = [
  '',
  '好的',
  '今天好累',
  'B站搜猫踩奶视频 解压一绝',
  '那去看跳伞第一视角视频',
  '你再说一遍试试',
  '？',
  '哦牛批',
  '这么刺激',
  '你说完了。'
];
for (const text of finishedCases) {
  assert(looksLikeUnfinished(text) === false, `已说完/普通判定 false: ${JSON.stringify(text)}`);
}

// 3. 配置允许长等待（催话与等待时长都归配置/AI 管，不再有硬编码常量可断言）
try {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  const maxMs = Number(cfg.socialV2?.wait?.maxMs) || 0;
  assert(maxMs >= END_ROUND_WAIT_MAX_MS, `wait.maxMs=${maxMs} >= ${END_ROUND_WAIT_MAX_MS}`);
} catch (error) {
  console.error('❌ 读取 config.json 失败:', error.message);
  failed = 1;
}

if (failed) {
  console.error('\n❌ 测试失败');
  process.exit(1);
}
console.log('\n🎉 二代等待/结束回合逻辑测试通过');
