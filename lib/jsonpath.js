/**
 * JSON 取值（极简路径）。
 *
 * 为什么必须有它：当下最主流的站点把数据放在**接口返回的 JSON** 里，
 * 页面 HTML 只是个空壳。没有这条通道，这类站点一个都抓不了 ——
 * 实测：B站的热门、每周必看、视频详情全在 JSON 接口里，只有少数 HTML 页面可抓。
 *
 * 路径语法（只实现抓取真正用到的部分）：
 *   $ 或留空          根值本身（接口直接返回数组时用它）
 *   data.list          逐层取属性
 *   data.list[0]       数组下标
 *   data.list[*]      通配，返回数组
 *   owner.name         深层字段
 * 不做过滤表达式、不做函数 —— 那些是另一套语言，不是抓取必需。
 */

/** 根值在路径里的内部标记（不导出，避免和真实字段名冲突）。 */
const ROOT = Symbol("root");

export function isEmptyPath(path) {
  const text = String(path ?? "").trim();
  return text === "" || text === "$";
}

/** 按路径取值。取不到返回 undefined。 */
export function pick(value, path) {
  const segments = parsePath(path);
  if (!segments) return undefined;
  if (segments[0] === ROOT) return value;
  let cur = value;
  for (const seg of segments) {
    if (cur === null || cur === undefined) return undefined;
    if (seg === "*") {
      if (!Array.isArray(cur)) return undefined;
      return cur;
    }
    if (typeof seg === "number") {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[seg];
    } else {
      if (typeof cur !== "object") return undefined;
      cur = cur[seg];
    }
  }
  return cur;
}

/**
 * 按路径取**一组**值：路径含 `*` 或 `deep` 时，把数组里每项的该字段取出来。
 * 用于"条目内取字段"这类场景（`owner.name` 从一个对象里取，`stat.view` 同理）。
 */
export function pickAll(value, path, deep = false) {
  const segments = parsePath(path);
  if (!segments) return [];
  if (segments[0] === ROOT) return [value];

  const walk = (cur, index) => {
    if (index >= segments.length) return [cur];
    const seg = segments[index];
    if (cur === null || cur === undefined) return [];
    if (seg === "*") {
      return Array.isArray(cur) ? cur.flatMap((v) => walk(v, index + 1)) : [];
    }
    if (typeof seg === "number") {
      return Array.isArray(cur) ? walk(cur[seg], index + 1) : [];
    }
    if (typeof cur !== "object") return [];
    return walk(cur[seg], index + 1);
  };

  const direct = walk(value, 0);
  if (!deep || !Array.isArray(value)) return direct;
  // deep：数组里每一项都取一次，结果摊平（用于"条目内还有一层数组"的取值）
  return value.flatMap((v) => walk(v, 0));
}

/**
 * 解析路径成段落；`a.b[0].c` → ["a","b",0,"c"]。解析不了返回 null。
 *
 * 两个细节都是实测踩出来的：
 *   · 段名的字符集要写明（`[\w$-]`），不能用"除点以外的任意字符" ——
 *     后者会把点吃进段名里，"data.list" 变成一个段；
 *   · 段与段之间的 `.` 是分隔符，必须允许它落在两段之间的空隙里 ——
 *     把任何空隙都当成"无法解析"会把每一条路径都判成非法。
 *
 * 根值用单独的标记 `ROOT` 表示，不用字符串 `"$"` ——
 * 否则一个恰好叫 `$` 的字段会和"根"混淆。空路径同样解析成根。
 */
function parsePath(path) {
  const text = String(path ?? "").trim();
  if (isEmptyPath(text)) return [ROOT];
  const segments = [];
  const re = /([\w$-]+)|\[(\d+|\*)\]/g;
  let m;
  let consumed = 0;
  while ((m = re.exec(text))) {
    const gap = text.slice(consumed, m.index);
    if (gap !== "" && !/^[.\s]*$/.test(gap)) return null; // 空隙里只允许分隔符
    consumed = m.index + m[0].length;
    if (m[1] !== undefined) segments.push(m[1]);
    else if (m[2] === "*") segments.push("*");
    else segments.push(Number(m[2]));
  }
  if (!/^[.\s]*$/.test(text.slice(consumed))) return null; // 尾部也只允许分隔符
  return segments.length ? segments : null;
}
