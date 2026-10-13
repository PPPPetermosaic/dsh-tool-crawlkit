/**
 * 适配器规范：校验与规范化。
 *
 * 适配器是**纯数据**，不是代码 —— 这样它能被审查、被 diff、被分享，
 * 而且生成它的过程不需要执行任何东西。规则里不允许出现脚本。
 *
 * 为什么把校验做得这么细：适配器通常由 agent 现场生成，写错时若静默通过，
 * 表现就是"跑通了但 0 条数据"，而 0 条数据恰恰是最难排查的形态。
 * 这里尽量在【写入前】把错误说清楚。
 */

import { parseSelector, resolveTake } from "./html.js";
import { pick, isEmptyPath } from "./jsonpath.js";
import { fillUrl, RESERVED_PLACEHOLDERS, urlPlaceholders } from "./urlparams.js";

// 重新导出：适配器规范的一部分（校验时判断 URL 需要哪些参数），
// 让调用方从一个地方就能拿到，不必知道它落在哪个文件。
export { fillUrl, RESERVED_PLACEHOLDERS, urlPlaceholders };

/** 取值方式：text/html/attr 取第一个匹配；all 取全部匹配并返回数组。 */
export const TAKE_MODES = ["text", "html", "attr", "all"];
/**
 * 取值后的清洗方式。
 *
 * `text` 是"去掉标签与实体、只留可读文字"。它和 TAKE_MODES 里的 `text` 同名，
 * 但作用完全不同（那个是"从元素里取文字"，这个是"把字符串洗成纯文字"）——
 * 搜索接口的标题常带 `<em class="keyword">` 这类高亮标记，就是靠它洗掉的。
 * 这个名字容易被写混，所以两处都保留了它，但注释里说清区别。
 */
export const PARSE_MODES = ["none", "number", "date", "lower", "text"];
export const TIERS = ["http", "api"];
/** 提取方式：html 用 CSS 选择器，json 用路径。 */
export const EXTRACT_TYPES = ["html", "json"];

const ID_RE = /^[a-z0-9][a-z0-9._-]*$/;
const DOMAIN_RE = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/** 校验并规范化一个适配器。返回 { ok: true, adapter } 或 { ok: false, problems: [...] }。 */
export function validateAdapter(input) {
  const problems = [];
  const a = input && typeof input === "object" ? input : {};
  const bad = (msg) => problems.push(msg);

  // ---- id
  if (typeof a.id !== "string" || !a.id.trim()) bad("缺少 id");
  else if (!ID_RE.test(a.id)) bad(`id "${a.id}" 不合法：只能用小写字母、数字、点、下划线、连字符，且以字母或数字开头`);

  // ---- match
  if (!Array.isArray(a.match) || a.match.length === 0) bad("match 必须是非空数组，列出适用的域名");
  else {
    for (const d of a.match) {
      if (typeof d !== "string" || !DOMAIN_RE.test(d.replace(/^\*\./, ""))) bad(`match 里的 "${d}" 不像域名`);
    }
  }

  // ---- fetch
  const fetchSpec = a.fetch;
  if (!fetchSpec || typeof fetchSpec !== "object") bad("缺少 fetch");
  else {
    if (!TIERS.includes(fetchSpec.tier)) bad(`fetch.tier 必须是 ${TIERS.join(" 或 ")}`);
    if (typeof fetchSpec.url !== "string" || !/^https?:\/\//.test(fetchSpec.url)) bad("fetch.url 必须是 http/https 开头的完整地址");
    if (fetchSpec.method && !["GET", "POST"].includes(String(fetchSpec.method).toUpperCase())) bad("fetch.method 只支持 GET 或 POST");

    const pg = fetchSpec.paginate;
    if (pg) {
      if (!["page", "offset", "cursor", "nextLink"].includes(pg.kind)) {
        bad("fetch.paginate.kind 必须是 page / offset / cursor / nextLink 之一");
      } else if (pg.kind !== "cursor" && pg.kind !== "nextLink") {
        const token = pg.kind === "page" ? "{page}" : "{offset}";
        if (typeof fetchSpec.url === "string" && !fetchSpec.url.includes(token) && !(pg.param && fetchSpec.url.includes(pg.param))) {
          bad(`分页方式是 ${pg.kind}，但 fetch.url 里既没有 ${token} 占位符，也没有 ${pg.param ?? pg.kind} 参数`);
        }
      }
      for (const key of ["start", "step", "max"]) {
        if (pg[key] !== undefined && !Number.isFinite(Number(pg[key]))) bad(`fetch.paginate.${key} 必须是数字`);
      }
      if (pg.kind === "nextLink" && typeof pg.selector !== "string") {
        bad("fetch.paginate.kind 是 nextLink 时必须给 selector（指向下一页链接的选择器）");
      }
    }

    // 需要调用方提供的占位符（查询词之类）。
    // 它们让"一个适配器服务任意关键词"，而不是换个词就得再存一个（实测：两个 B站
    // 搜索适配器除了关键词一字不差）。
    const needs = urlPlaceholders(fetchSpec.url);
    if (needs.length && fetchSpec.params !== undefined) {
      if (!Array.isArray(fetchSpec.params)) bad("fetch.params 必须是数组（列出这个适配器需要调用方提供的名字）");
      else {
        for (const name of fetchSpec.params) {
          if (!needs.includes(String(name))) {
            bad(`fetch.params 里的 "${name}" 在 fetch.url 里没有对应占位符；URL 里需要的是：${needs.map((n) => `{${n}}`).join("、")}`);
          }
        }
      }
    }
  }

  // ---- extract
  const extract = a.extract;
  if (!extract || typeof extract !== "object") bad("缺少 extract");
  else {
    const type = extract.type ?? "html";
    if (!EXTRACT_TYPES.includes(type)) bad(`extract.type 必须是 ${EXTRACT_TYPES.join(" 或 ")}`);

    if (type === "json") {
      // JSON 通道：items 是路径（如 data.list），字段是路径（如 owner.name）。
      // 有些接口的根就是一个数组（豆瓣的搜索建议接口就是），此时 items 用 "" 或 "$"。
      if (typeof extract.items !== "string") {
        bad('extract.items 必须是取数据列表的路径，如 data.list；接口根就是数组时写 "$" 或留空');
      } else if (!isEmptyPath(extract.items) && pick({ probe: true }, extract.items) !== undefined) {
        bad(`extract.items 的路径写法可能有问题：${extract.items}`);
      }
      // single：接口只返回一个对象（不是数组）。以前这个字段被静默丢掉，
      // 于是"单个对象"的接口永远取到 0 条，而且报成"命中 0 条"（实测踩过）。
      if (extract.single !== undefined && typeof extract.single !== "boolean") {
        bad("extract.single 必须是布尔值（接口只返回一个对象时写 true）");
      }

      const fields = extract.fields;
      if (!fields || typeof fields !== "object" || Array.isArray(fields) || Object.keys(fields).length === 0) {
        bad("extract.fields 必须是非空对象，至少定义一个字段");
      } else {
        for (const [name, spec] of Object.entries(fields)) {
          const where = `extract.fields.${name}`;
          if (typeof spec === "string") {
            if (!spec.trim()) bad(`${where} 的路径不能为空`);
            continue;
          }
          if (!spec || typeof spec !== "object") {
            bad(`${where} 必须是路径字符串，或 { path, deep, parse } 对象`);
            continue;
          }
          if (typeof spec.path !== "string" || !spec.path.trim()) bad(`${where}.path 必须是非空路径`);
          if (spec.deep !== undefined && typeof spec.deep !== "boolean") bad(`${where}.deep 必须是布尔值`);
          const parse = spec.parse ?? "none";
          if (!parse || !PARSE_MODES.includes(parse)) bad(`${where}.parse 必须是 ${PARSE_MODES.join(" / ")}`);
        }
      }
    } else {
      if (typeof extract.items !== "string" || !extract.items.trim()) bad('extract.items 必须是定位"每一条"的选择器（HTML 通道不支持留空；接口根是数组时请用 extract.type:"json" 并写 "$"）');
      else if (!parseSelector(extract.items)) bad(`extract.items 的选择器无法解析：${extract.items}`);

      const fields = extract.fields;
      if (!fields || typeof fields !== "object" || Array.isArray(fields) || Object.keys(fields).length === 0) {
        bad("extract.fields 必须是非空对象，至少定义一个字段");
      } else {
        for (const [name, spec] of Object.entries(fields)) {
          const where = `extract.fields.${name}`;
          if (!spec || typeof spec !== "object") {
            bad(`${where} 必须是对象`);
            continue;
          }
          // 先解析简写式，再校验 —— 校验与执行必须看同一个选择器
          const resolved = resolveTake(spec);
          // sel 留空 = 条目元素本身（合法写法，见 resolveTake 的说明）
          if (typeof spec.sel !== "string") bad(`${where}.sel 必须是选择器字符串（留空表示取条目元素本身）`);
          else if (spec.sel.trim() && !parseSelector(resolved.sel)) bad(`${where}.sel 无法解析：${resolved.sel}`);

          if (!TAKE_MODES.includes(resolved.take)) bad(`${where}.take 必须是 ${TAKE_MODES.join(" / ")}`);
          if (resolved.take === "attr" && (typeof resolved.name !== "string" || !resolved.name.trim())) {
            bad(`${where} 的 take 是 attr，必须给属性名（take=attr + name，或在 sel 里写 @属性名）`);
          }
          const parse = spec.parse ?? "none";
          if (!parse || !PARSE_MODES.includes(parse)) bad(`${where}.parse 必须是 ${PARSE_MODES.join(" / ")}`);
          // take:all 返回数组，parse（数字/日期）对数组没有意义 —— 与其产出奇怪的结果，不如当场拒绝
          if (resolved.take === "all" && parse !== "none") {
            bad(`${where} 用了 take:"all"（返回数组），不能再写 parse:"${parse}" —— 请去掉 parse，或把 take 改回 text/attr`);
          }
        }
      }
    }

    if (extract.uniqueBy !== undefined) {
      if (!Array.isArray(extract.uniqueBy)) bad("extract.uniqueBy 必须是数组");
      else if (extract.fields && typeof extract.fields === "object" && !Array.isArray(extract.fields)) {
        const available = Object.keys(extract.fields);
        for (const key of extract.uniqueBy) {
          if (key in extract.fields) continue;
          // 报错必须带上"可用的字段名" —— 只说"不在 fields 中"会让人只能猜，
          // 实测使用者会反复试字段名，每次都只拿到同一个不清楚的提示。
          bad(
            `extract.uniqueBy 里的 "${key}" 不在 extract.fields 中。` +
              (available.length ? `可用的是：${available.join(" / ")}` : "当前没有定义任何字段"),
          );
        }
      } else {
        bad("extract.uniqueBy 需要 extract.fields 先定义好字段，否则无从去重。");
      }
    }
  }

  if (problems.length) return { ok: false, problems };

  return { ok: true, adapter: normalizeAdapter(a) };
}

/**
 * 补全默认值，输出内部统一使用的形状。
 *
 * 一条硬约束：**返回的对象里不能出现值为 `undefined` 的键**。
 *
 * 为什么：工具返回值要经过 DSH 的"无损 JSON"校验，而 `undefined` 不是合法 JSON 值。
 * 只要有一个键的值是 `undefined`，整个工具调用就报 `value is not lossless JSON` ——
 * 而**写入其实已经成功了**，这个报错纯属误导：实测有人因此以为没存上、
 * 反复重试同一个 save（漏网的就是 `paginate.selector`）。
 * 所以可选字段一律用「有值才放进去」，不写 `key: maybeUndefined`。
 */
export function normalizeAdapter(a) {
  const pg = a.fetch.paginate;

  const paginate = pg
    ? {
        kind: pg.kind,
        start: Number.isFinite(Number(pg.start)) ? Number(pg.start) : 1,
        step: Number.isFinite(Number(pg.step)) ? Number(pg.step) : 1,
        max: Number.isFinite(Number(pg.max)) ? Number(pg.max) : 1,
      }
    : null;

  if (paginate) {
    // param：page / offset 有默认值；cursor 与 nextLink 没有
    const param = pg.param ?? (pg.kind === "page" ? "page" : pg.kind === "offset" ? "offset" : null);
    if (param) paginate.param = param;
    // selector：只有 cursor / nextLink 用得到
    if (typeof pg.selector === "string" && pg.selector) paginate.selector = pg.selector;
  }

  return {
    id: a.id,
    match: a.match.map((d) => String(d).toLowerCase()),
    version: Number(a.version) || 1,
    note: typeof a.note === "string" ? a.note : "",
    fetch: {
      tier: a.fetch.tier,
      url: a.fetch.url,
      method: String(a.fetch.method ?? "GET").toUpperCase(),
      headers: a.fetch.headers && typeof a.fetch.headers === "object" ? a.fetch.headers : {},
      body: typeof a.fetch.body === "string" ? a.fetch.body : "",
      // 需要调用方提供的占位符名，从 URL 里自动得出。
      // 不要求手写：手写会漏、会写错，而 URL 本身就是唯一事实来源。
      // 列出来是为了让调用方（和模型）知道"这个适配器要填什么"。
      ...(urlPlaceholders(a.fetch.url).length ? { params: urlPlaceholders(a.fetch.url) } : {}),
      paginate,
    },
    extract: {
      type: a.extract.type ?? "html",
      items: a.extract.items,
      fields: a.extract.fields,
      // single 必须保留：以前它在这里被静默丢掉，于是"接口只返回一个对象"的适配器
      // 存下来等于没写这个字段，抓取时永远 0 条（实测踩过）。
      ...(a.extract.single === true ? { single: true } : {}),
      uniqueBy: Array.isArray(a.extract.uniqueBy) ? a.extract.uniqueBy : [],
    },
  };
}

/** 这个适配器是否适用于某个 host。 */
export function adapterMatchesHost(adapter, host) {
  const h = String(host ?? "").toLowerCase();
  return (adapter.match ?? []).some((pattern) => {
    const p = String(pattern).toLowerCase();
    if (p.startsWith("*.")) {
      const base = p.slice(2);
      return h.endsWith(`.${base}`); // 通配符只覆盖子域，不覆盖裸域本身
    }
    return h === p;
  });
}
