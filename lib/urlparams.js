/**
 * URL 里的占位符：解析与填充。
 *
 * 为什么单独一个文件：两个模块都要用，但它们的依赖方向必须保持单向 ——
 *   · adapter.js 校验规则时要知道 URL 需要哪些参数
 *   · engine.js 执行时要往里填值
 * 如果放在 adapter.js 里，engine.js 就得 import adapter.js；而 adapter.js 又
 * 已经 import 了 html.js，模块图会绕回来变成循环依赖。放成叶子模块最省事。
 */

/**
 * 分页占位符由分页机制自己填，不算"需要调用方提供的参数"。
 */
export const RESERVED_PLACEHOLDERS = new Set(["page", "offset", "cursor"]);

/**
 * 从 URL 里找出【需要调用方提供的】占位符名字。
 *
 * 为什么要它：分页占位符一直有（`{page}`），但"查询条件"这类占位符没有 ——
 * 于是换个搜索词只能再存一个适配器（实测：两个 B站搜索适配器除了关键词
 * 一字不差，约 95% 是复制品）。有了它，一个适配器就能服务任意关键词。
 *
 * 命名接受 `{keyword}` 与 `{{keyword}}` 两种写法：后者是很多人对模板的直觉写法，
 * 与其报"无法解析"，不如都认。
 */
export function urlPlaceholders(url) {
  const text = String(url ?? "");
  const found = [];
  for (const m of text.matchAll(/\{\{?\s*([A-Za-z_][\w-]*)\s*\}?\}/g)) {
    const name = m[1];
    if (!RESERVED_PLACEHOLDERS.has(name) && !found.includes(name)) found.push(name);
  }
  return found;
}

/**
 * 把参数填进 URL。
 *
 * 三个刻意的决定：
 *   · **值默认编码**。中文关键词直接拼进地址会发出坏请求（实测踩过）；
 *     需要原样拼接时写 `{!name}`（叹号前缀 = 不编码）。
 *   · **缺参数不静默**。返回 `missing`，由上层明确报错 ——
 *     否则会请求一个 `keyword=` 为空的地址，拿到无关结果还完全看不出来。
 *   · **分页占位符原样留着**，交给分页逻辑填。两步走才能分清"哪些是调用方该给的"。
 */
export function fillUrl(url, values = {}) {
  const missing = [];
  const filled = String(url ?? "").replace(/\{\{?(!?)\s*([A-Za-z_][\w-]*)\s*\}?\}/g, (whole, bang, name) => {
    if (RESERVED_PLACEHOLDERS.has(name)) return whole; // 分页的自己填
    const raw = values[name];
    if (raw === undefined || raw === null || String(raw) === "") {
      if (!missing.includes(name)) missing.push(name);
      return whole;
    }
    return bang ? String(raw) : encodeURIComponent(String(raw));
  });
  return { url: filled, missing };
}
