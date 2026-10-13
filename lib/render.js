/**
 * 结果渲染：把结构化结果变成模型能读的文本。
 *
 * 单独成模块的理由：渲染规则是**一套**，而工具是六个。
 * 混在一起时每个工具都要重复"先说发生了什么、再说怎么办"这条顺序。
 *
 * 两条硬约定：
 *   · 失败时必须先说要紧的：发生了什么 → 怎么办 → 技术细节放最后。
 *     用户第一眼看到的必须是能看懂的话，不是错误码。
 *   · 简单查询类的结果直接渲染，不要再套一层 JSON ——
 *     套了之后换行会变成字面量 \n，读起来是一堆转义字符。
 */

/** 一个带标题的要点列表；没有内容时整块不出现。 */
export function bullet(lines, label, values) {
  if (!values || !values.length) return;
  lines.push("", `${label}：`);
  for (const v of values) lines.push(`  · ${v}`);
}

/**
 * 渲染一条失败。顺序固定：发生了什么 → 怎么办 → 提示 → 技术细节。
 *
 * 为什么强调顺序：调用方（模型）最需要的是"这条建议能不能解决问题"，
 * 而不是错误对象的形状。技术细节放在最后，需要时才看。
 */
export function renderFailure(lines, payload) {
  lines.push("", String(payload.error ?? "操作未成功"));
  if (payload.fix) lines.push("", "—— 怎么办 ——", String(payload.fix));
  if (payload.hint) lines.push("", String(payload.hint));
  if (payload.detail) lines.push("", "—— 技术细节 ——", String(payload.detail));

  if (payload.problems?.length) {
    lines.push("", "—— 规则里的问题 ——");
    for (const p of payload.problems) lines.push(`  · ${p}`);
  }
  if (payload.pages?.length) {
    lines.push("", "—— 抓取过程 ——");
    for (const p of payload.pages) {
      lines.push(`  ${p.ok ? "OK  " : "FAIL"} ${p.url}${p.error ? ` —— ${p.error}` : ` —— 命中 ${p.matched} 条`}`);
    }
  }
  if (payload.stopRetrying) {
    lines.push("", "⚠ 这不是“换个参数再试一次”的建议 —— 换参数不会让结果不同。");
  }
}

/** 抓取过程的一行摘要，运行与试跑共用。 */
export function pageLines(pages) {
  return (pages ?? []).map((p) => {
    // 标出数据是快照还是联网拿的 —— 离线重放时必须能一眼看出有没有偷偷联网
    const source = p.fromFixture ? "｜快照" : p.replayMissed ? "｜联网(无快照)" : "";
    return `${p.ok ? "OK  " : "FAIL"} ${p.url}${p.ok ? ` —— 命中 ${p.matched} 条` : ` —— ${p.error}`}${source}`;
  });
}
