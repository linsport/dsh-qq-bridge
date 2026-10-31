// 二代仿真模式：等待/结束回合相关的轻量判断工具。
// 这些是“提示/软信号”，不是硬规则；最终是否等待、是否发催话仍由 AI 自主决定。

// 常见“话说一半/没说完”的结尾特征。
const UNFINISHED_TAIL_RE = /(?:你知道|等一下|我跟你讲|其实吧|但是|所以说|然后|那个|就是|我想说|对了|等我|等等|我看看|还有|再说|主要是|毕竟|因为|所以|但是吧|回头|回头说|待会|晚点|等会|再说吧)$/;

// 以中文逗号/顿号/分号/冒号等“非终止标点”结尾，也常表示还没说完。
const UNFINISHED_PUNCT_RE = /[，、；：,;:]$/;

// 明确以终止标点/省略号结尾的消息视为说完。
const FINISHED_TAIL_RE = /[。！？!?…～~]+$/;

export function looksLikeUnfinished(text) {
  const s = String(text ?? '').trim();
  if (!s) return false;
  if (FINISHED_TAIL_RE.test(s)) return false;
  if (UNFINISHED_TAIL_RE.test(s)) return true;
  if (UNFINISHED_PUNCT_RE.test(s)) return true;
  return false;
}

// 这里曾经还导出过三个常量：UNFINISHED_PROMPT_REPLIES（催话短句）、
// END_ROUND_WAIT_MIN_MS / END_ROUND_WAIT_MAX_MS（结束前等待 5~10 分钟）。
// 2026-10-31 审查确认它们零消费点 —— 全仓搜下来只有本文件的定义和
// scripts/test-v2-wait.mjs 的断言，没有任何生产代码读它们。
// 真正决定等多久的是 config.json 的 socialV2.wait.minMs / maxMs（现 5000 / 600000），
// 催话与否也已经交给 AI 自己判断，硬编码一份 5~10 分钟只会跟配置漂移。
// 想改等待时长请改配置，别在这里加回常量。
