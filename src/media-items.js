// 媒体项的归类与文案：qq_get_message_images 拿桥接 /api/images/message 的结果时用。
//
// 抽成纯函数是为了能脱离 MCP server 直接测 —— 这段逻辑踩过两次坑：
//  1. 2026-10-30：2.72MB 的图压不动，桥接仍回 ok:true + 一条说明文字，工具照着打绿勾，
//     模型以为自己看过了。于是加了「一项真图都没拿到就判失败」。
//  2. 2026-10-31：群里发 QQ 系统小表情（faceId=264「捂脸」），服务端给不出 PNG，
//     同样一项真图都没拿到 —— 被上一条规则误判成故障，群里每发一次小表情就红一次。
//
// 判据因此分成两类：真图片/表情包（拿不到像素才算失败）与 QQ 系统小表情（名字就是全部信息）。

/**
 * @param {Array} images 桥接 /api/images/message 返回的 images 数组
 * @returns {{
 *   images: Array,       // 带 data + mimeType 的项（要作为 image content 返回）
 *   textParts: string[], // 每项一行的中文描述
 *   faceNames: string[], // 只拿到名称的 QQ 系统小表情
 *   bitmapItems: number, // 真图片/表情包的项数（含失败的）
 *   bitmapGot: number,   // 真图片/表情包里真正拿到像素的数量
 *   isFailure: boolean   // 有真图片却一项像素都没拿到
 * }}
 */
export function classifyMediaItems(images) {
  const list = Array.isArray(images) ? images : [];
  const out = [];
  const textParts = [];
  const faceNames = [];
  let bitmapItems = 0;
  let bitmapGot = 0;

  for (const img of list) {
    const isFace = img?.kind === 'face';
    const who = `${isFace ? '表情' : '图片'}${img?.index ?? ''}`;
    if (img?.data && img?.mimeType) {
      textParts.push(`[${who}${img.text ? ' ' + img.text : ''}]`);
      out.push({ type: 'image', mimeType: img.mimeType, data: img.data });
      // 能拿到像素的小表情（有 url 的少数情况）也算「拿到了」，但不算 bitmapItems ——
      // 否则「全是小表情」就会被当成有真图片却失败。
      if (!isFace) { bitmapItems += 1; bitmapGot += 1; }
    } else if (isFace) {
      // QQ 系统小表情是客户端字形渲染的，服务端常常给不出 PNG —— 实测 faceId=264
      // 「捂脸」抓回来的是「不是有效图片（PNG/JPEG/GIF/WebP）」。名字就是全部信息。
      // faceId 和 text 都缺时不能拼出 "[表情#]"（一个空的井号）。
      // 老老实实写「[表情]」，比留个空编号让人去猜强；有 faceId 的照旧用 [表情#999]。
      const faceIdText = img.faceId === undefined || img.faceId === null ? '' : String(img.faceId).trim();
      const faceLabel = img.text
        ? String(img.text).trim()
        : (faceIdText ? `[表情#${faceIdText}]` : '[表情]');
      faceNames.push(faceLabel);
      textParts.push(`[${who}${img.text ? ' ' + img.text : '（无名称）'}]`);
    } else {
      bitmapItems += 1;
      textParts.push(`[${who}${img.text ? ' ' + img.text : '（获取失败）'}]`);
    }
  }

  return {
    images: out,
    textParts,
    faceNames,
    bitmapItems,
    bitmapGot,
    isFailure: bitmapItems > 0 && bitmapGot === 0
  };
}

/**
 * 把归类结果拼成给模型看的那段说明文字（不含画像本身）。
 *
 * @param {string} messageId
 * @param {{ textParts: string[], faceNames: string[], images: Array }} classified
 * @param {number} total 桥接报的项数（可能包含被跳过的）
 */
export function describeMediaItems(messageId, classified, total) {
  const textParts = Array.isArray(classified?.textParts) ? classified.textParts : [];
  if (!textParts.length) return '';
  const faceNames = Array.isArray(classified?.faceNames) ? classified.faceNames : [];
  const note = faceNames.length
    ? `\n其中 ${faceNames.length} 项是 QQ 系统小表情（${faceNames.join('、')}）：它们没有可看的像素，名称就是全部信息，不用为看不到去重试或换工具找图。`
    : '';
  return `消息 ${messageId} 的媒体内容（${total} 项）：\n${textParts.join('\n')}${note}`;
}
