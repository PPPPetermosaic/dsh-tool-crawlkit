/**
 * 适配器执行引擎。
 *
 * 一条原则贯穿全文：**"命中 0 条"必须显式失败**。
 * 成熟爬虫库里选择器没命中通常静默返回空，而 agent 生成适配器时最需要的
 * 恰恰是"你这条选择器一条都没命中"这个信号。没有它，生成适配器就是空话。
 */

import { cleanText, decodeEntities, innerHtmlOf, parseHtml, queryAll, queryOne, resolveTake, textOf } from "./html.js";
import { fillUrl } from "./urlparams.js";
import { pick, pickAll } from "./jsonpath.js";
import { fail, FailureClass } from "./failure.js";
import { asJson, detectApiError, detectClientRendered, fetchPage } from "./http.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- 字段取值

/**
 * Unix 时间戳的范围（秒）：2001-09-09 ~ 2096-10-02。
 *
 * 为什么要认它：接口返回的时间字段通常是时间戳（如 `1791759600`），
 * 而"能读的日期"才是人要看的东西。实测踩过：规则里写 `parse: "number"` 或
 * 什么都不写，数据集里就是一串数字，用户还得自己换算。
 */
/**
 * 时间戳的合理范围（秒与毫秒）。
 *
 * 必须【两端都设界】。以前只设了下界、且毫秒那一支写成 `n >= 下界 * 1000`，
 * 于是比下界还小的数字被当成毫秒：`123` → 1970 年附近的 123 毫秒 → 算出 0122 年
 * （实测：`parse:"date"` 对 "<b>ABC</b> 123" 返回 "0122-12-31T15:54:17.000Z"）。
 * 范围外必须返回 null，让调用方【原样保留】，而不是编出一个荒诞日期。
 */
const TS_SECONDS_MIN = 1_000_000_000; // 2001-09
const TS_SECONDS_MAX = 4_000_000_000; // 2096-10
const TS_MS_MIN = TS_SECONDS_MIN * 1000;
const TS_MS_MAX = TS_SECONDS_MAX * 1000;

/** 纯数字的字符串按"时间戳"解释（秒或毫秒），否则按普通日期文本解析。 */
function parseDate(raw) {
  const text = String(raw).trim();
  if (/^-?\d+$/.test(text)) {
    const n = Number(text);
    let ms = null;
    if (n >= TS_MS_MIN && n <= TS_MS_MAX) ms = n; // 毫秒
    else if (n >= TS_SECONDS_MIN && n <= TS_SECONDS_MAX) ms = n * 1000; // 秒
    if (ms !== null) return new Date(ms).toISOString();
    // 明显不是时间戳的数字（太小/太大）→ 落到下面的文本解析，通常直接返回 null
  }
  // 不是时间戳时，只认【看起来真的像日期】的文本。
  //
  // 这里必须严格：宽松交给 Date.parse 是不行的 —— 它会在任意字符串里找出
  // 一个像年份的数字。实测：`"<b>ABC</b> 123"` 被它当成"公元 123 年"，
  // 最终返回 "0122-12-31…"。这类输入本该【原样保留】，而不是编出个日期。
  // 所以先要求形如 2026-10-12 / 2026/10/12 / 2026年10月12日 / 10-12。
  const normalized = text.replace(/[年/.]/g, "-").replace(/月/g, "-").replace(/日/g, "").trim();
  if (!/^\d{1,4}-\d{1,2}-\d{1,2}(\s+\d{1,2}:\d{2}(:\d{2})?)?$/.test(normalized)) return null;
  const ts = Date.parse(normalized.length <= 10 ? `${normalized}T00:00:00` : normalized);
  return Number.isNaN(ts) ? null : new Date(ts).toISOString();
}

function applyParse(value, mode) {
  if (value === null || value === undefined) return value;
  let out = value;
  if (mode === "number") {
    const m = String(out).match(/-?\d+(?:\.\d+)?/);
    out = m ? Number(m[0]) : null;
  } else if (mode === "date") {
    // 解析不了就【原样保留】，连类型都不改 ——
    // 悄悄把数字变成字符串会让下游的数值判断失效，且很难察觉
    const parsed = parseDate(out);
    if (parsed !== null) out = parsed;
  } else if (mode === "lower") {
    out = String(out).toLowerCase();
  } else if (mode === "text") {
    // 去掉标签、解掉实体、压缩空白，只留可读文字。
    //
    // 为什么需要它：搜索类接口返回的标题常带高亮标记 —— 搜索接口常把命中的词
    // 包成 `<em class="keyword">高亮词</em>`，不清掉的话数据集字段里存的是 HTML 片段，
    // 下游做统计还得自己再洗一遍（实测：有适配器就在这个字段上踩到）。
    //
    // 它和 take 的 "text" 同名但不是一回事：
    //   take:  "text" —— 从 HTML 元素里取文字（HTML 通道）
    //   parse: "text" —— 把拿到的字符串洗成纯文字（两个通道都能用）
    // 保留这个名字是因为"洗成纯文字"确实属于清洗；校验器也一并接受它。
    out = decodeEntities(cleanText(parseHtml(String(out)).root));
  }
  return out;
}

function absolutize(value, baseUrl) {
  if (typeof value !== "string" || !value) return value;
  try {
    return new URL(value, baseUrl).href;
  } catch {
    return value;
  }
}

/** 从一条元素里取一个字段。 */
export function extractField(item, spec, baseUrl) {
  const { sel, take, name } = resolveTake(spec);

  // take: "all" 取【所有】匹配元素，返回数组；其它模式只取第一个，返回字符串。
  // 为什么需要它：本来多值只能取到第一个，或者被拼成一整串
  // （`<span class="attrs">张国荣</span> / <span class="attrs">张丰毅</span>`
  // 只能得到 "张国荣"，或想办法拼成 "张国荣 / 张丰毅"），
  // 之后做统计还得自己拆。返回数组才是它本来的形状。
  // take:"all" 也能配 @attr（`a.lnk@href` + take:"all" 取全部链接的 href）。
  const multi = take === "all";
  const effectiveTake = multi ? (name ? "attr" : "text") : take;
  const matched = multi ? (sel ? queryAll(item, sel) : [item]) : sel ? [queryOne(item, sel)] : [item];

  const values = [];
  for (const node of matched) {
    if (node === null || node === undefined) continue;
    const raw =
      effectiveTake === "attr"
        ? (node.attrs?.[name] ?? "")
        : effectiveTake === "html"
          ? innerHtmlOf(node)
          : textOf(node);
    // 默认压缩空白；要原样保留时用 trim: false
    let v = spec.trim === false ? decodeEntities(String(raw)) : cleanText({ type: "text", text: String(raw), children: [] });
    if (spec.abs === true) v = absolutize(v, baseUrl);
    values.push(v);
  }

  if (!multi) return applyParse(values[0] ?? "", spec.parse ?? "none");

  // 多值通道：数组不做 parse（数组没法变成数字或日期），校验器已拦住这种组合
  return values;
}

/**
 * 从一条 JSON 记录里取一个字段（路径写法）。
 *
 * `abs: true` 同样生效（把相对地址补成绝对），基准用接口地址 ——
 * 接口返回 `/video/xxx` 这类相对路径在真实站点上很常见。
 */
export function extractJsonField(record, spec, baseUrl) {
  const path = typeof spec === "string" ? spec : spec.path;
  const deep = typeof spec === "object" && spec.deep === true;
  const parse = typeof spec === "object" ? (spec.parse ?? "none") : "none";

  const raw = deep ? pickAll(record, path, true) : pick(record, path);
  let value;
  if (Array.isArray(raw)) value = raw.map((v) => (v === null || v === undefined ? "" : v)).join(" | ");
  else if (raw === null || raw === undefined) value = "";
  else if (typeof raw === "object") value = JSON.stringify(raw);
  else value = raw;

  if (typeof value === "string") value = value.replace(/\s+/g, " ").trim();
  if (typeof spec === "object" && spec.abs === true) value = absolutize(value, baseUrl);
  return applyParse(value, parse);
}

/** 按适配器规则从一页里抽出条目。html 走选择器，json 走路径。 */
export function extractItems(adapter, body, pageUrl) {
  const type = adapter.extract.type ?? "html";
  const fields = Object.entries(adapter.extract.fields);

  if (type === "json") {
    const parsed = typeof body === "string" ? safeJson(body) : body;
    if (parsed === null) return { items: [], matched: 0, root: null, jsonError: "响应不是合法 JSON" };

    // 接口风控：HTTP 200 但 body 是错误码。必须在"取不到数据"时优先报这个，
    // 否则会被误报成"规则没命中"，把调用方引向改选择器（实测踩过）。
    const apiError = detectApiError(parsed);
    const raw = pick(parsed, adapter.extract.items);
    // 有些接口只返回【一个对象】而不是数组（B站视频详情 /x/web-interface/view 就是这样）。
    // 以前这里只认数组，对象一律变成空列表 —— 于是那类适配器永远返回 0 条，
    // 而报的却是"命中 0 条"这种最容易把人引向改选择器的形态（实测踩过）。
    // 规则：数组直接用；对象（且不是 null）当作一条记录；其它类型才算取不到。
    const single = adapter.extract.single === true;
    let list;
    if (Array.isArray(raw)) list = raw;
    else if (raw !== null && raw !== undefined && typeof raw === "object") list = [raw];
    else list = [];
    const singleRecord = list.length === 1 && !Array.isArray(raw) && raw !== null && typeof raw === "object";
    if (single && !singleRecord && list.length === 0) {
      // 显式声明了 single 却取不到对象：说清是路径问题，而不是"选择器写错"
      return {
        items: [],
        matched: 0,
        root: null,
        failure: fail(
          FailureClass.EMPTY,
          adapter.extract.items,
          `规则声明了 extract.single（接口只返回一个对象），但路径 "${adapter.extract.items}" 取到的不是对象。`,
          {
            fix: `先确认这个接口的返回结构：它应该在某个路径下有一个对象。当前路径取到的是 ${raw === undefined ? "空（路径不存在）" : typeof raw}。`,
            detail: `items = ${adapter.extract.items}`,
          },
        ),
      };
    }

    if (apiError && list.length === 0) {
      return {
        items: [],
        matched: 0,
        root: null,
        apiError,
        failure: fail(
          FailureClass.API_BLOCKED,
          adapter.extract.items,
          `接口返回错误码 ${apiError.code}${apiError.message ? `（${apiError.message}）` : ""}，没有返回数据。`,
          {
            fix:
              "这不是规则写错了 —— 接口明确拒绝了这次请求（通常是请求签名或风控）。\n" +
              "改抓取参数不会通过。请换一个数据来源，或改用该站其它不设签名要求的接口。",
            detail: `数据路径 ${adapter.extract.items} 取到 ${list.length} 条；接口 code=${apiError.code}`,
          },
        ),
      };
    }

    const items = list.map((record) => {
      const row = {};
      for (const [key, spec] of fields) row[key] = extractJsonField(record, spec, adapter.fetch.url);
      return row;
    });
    return { items, matched: list.length, root: null };
  }

  const { root } = parseHtml(body);
  const nodes = queryAll(root, adapter.extract.items);
  const items = [];
  for (const node of nodes) {
    const row = {};
    for (const [key, spec] of fields) row[key] = extractField(node, spec, pageUrl);
    items.push(row);
  }
  return { items, matched: nodes.length, root };
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** 按 uniqueBy 去重（保序）。 */
/**
 * 去重。
 *
 * `against` 是"已经存在、不该再进来"的条目（例如数据集里已有的那些）。
 * 为什么要它能跨批次生效：只对本次这批去重的话，一个会重复返回同一页的站点
 * 会把同样的数据反复堆进数据集 —— 用户看到的是"条数涨了"，实际全是重复
 * （实测踩过：50 条的数据集再抓一次变成 60 条，多出来的 10 条是第一页的副本）。
 */
export function dedupe(items, uniqueBy, against = []) {
  if (!uniqueBy || uniqueBy.length === 0) return { items, dropped: 0, droppedExisting: 0 };
  const seen = new Set();
  for (const item of against) {
    const key = dedupeKey(item, uniqueBy);
    if (key !== null) seen.add(key);
  }
  const out = [];
  let dropped = 0;
  let droppedExisting = 0;
  for (const item of items) {
    const key = dedupeKey(item, uniqueBy);
    if (key === null) {
      // 去重字段全空 → 无从判断，保留（宁可多留，不可误删）
      out.push(item);
      continue;
    }
    if (seen.has(key)) {
      dropped += 1;
      if (against.length) droppedExisting += 1;
      continue;
    }
    seen.add(key);
    out.push(item);
  }
  return { items: out, dropped, droppedExisting };
}

/** 一条记录的去重键；去重字段全空时返回 null（表示"无法判断"，不该参与去重）。 */
export function dedupeKey(item, uniqueBy) {
  const key = uniqueBy.map((k) => String(item[k] ?? "")).join("\u0000");
  return key.replace(/\u0000/g, "") === "" ? null : key;
}

// ---------------------------------------------------------------- 分页

/**
 * 本次从哪个游标开始。
 *
 * `resume` 是上次抓完留下的"下一次该从哪开始"。类型对不上就丢掉、退回默认起点 ——
 * 静默用一个来路不明的游标会让抓取从一个奇怪的位置开始，比退回起点更糟。
 */
function startCursor(adapter, startUrl, resume, params = {}) {
  const paginate = adapter.fetch.paginate;
  if (!paginate || paginate.kind === "nextLink") {
    // 起点也要先把参数填好：nextLink 方式直接从这个地址开始抓，
    // 留着 `{keyword}` 的话会去请求一个字面量地址（必然 404）。
    const link = typeof resume === "string" && resume ? resume : fillUrl(startUrl ?? adapter.fetch.url, params).url;
    return { link };
  }
  if (paginate.kind === "cursor") {
    return { value: typeof resume === "string" && resume ? resume : paginate.start };
  }
  // 数值型分页：必须显式判断"有没有给起点"。
  // 直接 Number(resume) 是错的 —— Number(null) 和 Number("") 都是 0，
  // 会把"没给起点"当成"从 0 开始"，于是适配器写的 start（常见是 1）被悄悄吃掉，
  // 第一页就请求错了位置（实测：适配器 start=1，实际请求 page=0）。
  const hasResume = resume !== null && resume !== undefined && String(resume).trim() !== "";
  const n = hasResume ? Number(resume) : NaN;
  return { value: Number.isFinite(n) ? n : paginate.start };
}

/**
 * 游标往后推一步（只处理"不需要看响应内容"的分页方式）。
 *
 * page / offset：数值加步长。
 * cursor：认得 `{ next }` 形式，供上层拿到新 token 后传进来；否则保持原值。
 * nextLink：必须看响应里的链接，这里推不动，原样返回。
 *
 * 抽出来是为了让"循环里的推进"和"结果里的续抓点"用同一套算法 ——
 * 两处各写一遍迟早会不一致，而那种偏差表现为"续抓跳页或重抓"，很难查。
 */
function advance(adapter, cursor) {
  const paginate = adapter.fetch.paginate;
  if (!paginate) return null;
  if (paginate.kind === "page" || paginate.kind === "offset") {
    return Number(cursor.value) + paginate.step;
  }
  if (paginate.kind === "cursor") {
    return cursor.next !== undefined ? cursor.next : cursor.value;
  }
  return cursor.link ?? null; // nextLink
}

/**
 * 把需要调用方提供的占位符填进一个地址（不动分页占位符）。
 *
 * 分两步走是刻意的：先填调用方的参数，再填分页值。
 * 合成一步会让"哪些没填"分不清，而缺参数必须能指名道姓地报出来 ——
 * 静默请求一个 `keyword=` 为空的地址会拿到无关结果，且完全看不出来。
 */
/** 构造第 n 页的地址。 */
export function pageUrl(adapter, cursor, params = {}) {
  const { url, paginate } = adapter.fetch;
  const base = fillUrl(url, params);

  // 没有分页规则、或走 nextLink 时，地址【由 cursor 决定】（起点链接 / 下一页链接）。
  //
  // 这里曾经返回 base.url（也就是 adapter.fetch.url），后果很隐蔽（实测踩到）：
  //   · 调用方通过 url 传进来的起始地址被静默丢掉 —— 手工传一个带时间窗的地址，
  //     实际却请求适配器里的裸地址，于是每个窗口拿到一样的数字，
  //     而工具报告里显示的 URL 是"对的"，极难发现；
  //   · nextLink 分页永远停在第一页（cursor.link 被丢掉）。
  // 静默发错请求比直接报错严重得多，所以必须用 cursor。
  if (!paginate || paginate.kind === "nextLink") return cursor?.link ?? base.url;

  if (paginate.kind === "cursor") {
    // `{cursor}` 也可能写成 `{{cursor}}`
    const token = base.url.match(/\{\{?cursor\}?\}/)?.[0];
    if (token) return base.url.replace(token, encodeURIComponent(cursor?.value ?? ""));
    return `${base.url}${base.url.includes("?") ? "&" : "?"}${paginate.param ?? "cursor"}=${encodeURIComponent(cursor?.value ?? "")}`;
  }
  const kind = paginate.kind === "page" ? "page" : "offset";
  const value = String(cursor?.value ?? paginate.start);
  const token = base.url.match(new RegExp(`\\{\\{?${kind}\\}?\\}`))?.[0];
  if (token) return base.url.replace(token, value);
  const sep = base.url.includes("?") ? "&" : "?";
  return `${base.url}${sep}${paginate.param ?? kind}=${value}`;
}

/** 从已抓到的页面里找下一页的地址（nextLink 方式）。 */
function nextLinkFrom(adapter, root, currentUrl) {
  const found = queryOne(root, adapter.fetch.paginate.selector);
  const href = found?.attrs?.href;
  if (!href) return null;
  try {
    return new URL(href, currentUrl).href;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- 编排

/**
 * 跑一个适配器。
 *
 * @returns 统一形状的结果；失败时带 failureClass / fix / stopRetrying。
 */
export async function runAdapter(adapter, options = {}) {
  const {
    limit = 50,
    maxPages = null,
    timeoutMs = 30000,
    delayMs = 800,
    cookieHeader = "",
    jar = null,
    startUrl = null,
    replay = false,
    fixtures = null,
    resumeFrom = null,
    params = {},
  } = options;

  // 先把"调用方提供的占位符"查一遍：缺了就在发请求之前停下。
  // 提前查而不是等填的时候才发现 —— 否则会先打出去一个 `keyword=` 为空的地址，
  // 拿到一堆无关结果，还完全看不出哪里错了。
  const baseUrlForCheck = startUrl ?? adapter.fetch.url;
  const missingParams = fillUrl(baseUrlForCheck, params).missing;
  if (missingParams.length) {
    return fail(
      FailureClass.INPUT,
      adapter.id,
      `这个适配器需要提供 ${missingParams.map((n) => `"${n}"`).join("、")}，但没给。`,
      {
        fix:
          `用 params 传进来，例如 params: { ${missingParams.map((n) => `"${n}": "你的值"`).join(", ")} }。\n` +
          "这些是地址里的查询条件（搜索词之类），不是分页参数。",
        detail: `fetch.url = ${baseUrlForCheck}`,
      },
    );
  }

  const paginate = adapter.fetch.paginate;
  // 抓几页由三方共同决定：适配器声明的上限、调用方传的上限、以及是否真的有分页规则。
  // 续抓时必须【不受适配器 max 限制】再抓一次：上次可能正好停在上限处，
  // 卡在上限上会导致"说了继续抓、实际一条都没动"（实测很容易踩）。
  const resuming = resumeFrom !== null && resumeFrom !== undefined && paginate;
  const pageCap = paginate ? Math.max(1, maxPages ?? paginate.max) : 1;

  const collected = [];
  const pageReports = [];
  let cursor = startCursor(adapter, startUrl, resuming ? resumeFrom : null, params);
  let pageIndex = 0;
  let collectedAnySuccess = false;
  // 本次抓完后"下一次该从哪开始"。
  //
  // 初值取【下一页】而不是当前页：本次一定会抓当前页，所以抓完后的续抓点必然是下一页。
  // 若取当前页，只抓一页时（循环因页数上限直接退出、没走到推进游标那一步）就会返回
  // "还是这一页"，续抓变成原地重抓（实测踩过）。
  // 没有分页规则时恒为 null —— 那种情况下不存在"下次接着抓"。
  let nextCursor = paginate ? advance(adapter, cursor) : null;

  while (pageIndex < pageCap && collected.length < limit) {
    const url = pageUrl(adapter, cursor, params);
    if (pageIndex > 0 && delayMs > 0) await sleep(delayMs); // 主动限速

    const headers = { ...adapter.fetch.headers };
    // 请求方法与请求体必须真的传下去：适配器校验允许 POST，但以前这里没传，
    // 于是 POST 适配器会"通过校验、保存成功、实际发的是 GET"（实测核实过）。
    const httpOptions = { timeoutMs, cookieHeader, jar, extraHeaders: headers, method: adapter.fetch.method, body: adapter.fetch.body };
    // 离线重放：有快照就用快照，没有就照常联网（并标记出来，不让人误以为在离线跑）
    let res = replay && fixtures ? fixtures.read(url) : null;
    if (res?.ok) res = { ...res, fromFixture: true };
    else if (replay && fixtures) {
      res = await fetchPage(url, httpOptions);
      if (res.ok) res.replayMissed = true;
    } else {
      res = await fetchPage(url, httpOptions);
    }

    if (!res.ok) {
      // 一页都没成功 → 整体失败；已有数据 → 报告部分成功并保留
      if (!collected.length) return res;
      pageReports.push({ url, ok: false, error: res.error });
      break;
    }

    const isJson = (adapter.extract.type ?? "html") === "json";
    const jsonBody = asJson(res);

    // 接口风控（HTTP 200 但 body 是错误码）：在传输层就判，与适配器声明的类型无关。
    // 只认"明确的失败信号"，避免把 code 恰好是业务字段的正常响应误杀。
    const apiError = detectApiError(jsonBody);
    if (apiError) {
      const failure = fail(
        FailureClass.API_BLOCKED,
        res.url,
        `接口返回错误码 ${apiError.code}${apiError.message ? `（${apiError.message}）` : ""}，不是数据。`,
        {
          fix:
            "这不是规则写错了 —— 接口明确拒绝了这次请求（通常是请求签名或风控）。\n" +
            "改抓取参数不会通过。请换一个数据来源，或改用该站其它不设签名要求的接口。",
          detail: `HTTP ${res.status}，响应以 {"code":${apiError.code}} 开头`,
          pages: pageReports,
        },
      );
      if (!collected.length) return failure;
      pageReports.push({ url: res.url, ok: false, error: failure.error });
      break;
    }

    const extracted = extractItems(adapter, res.text, res.url);

    // JSON 通道自己也能发现风控（例如列表路径取不到东西时）
    if (extracted.failure) {
      if (!collected.length) return { ...extracted.failure, pages: pageReports };
      pageReports.push({ url: res.url, ok: false, error: extracted.failure.error });
      break;
    }

    const { items, matched, root } = extracted;
    pageReports.push({
      url: res.url,
      ok: true,
      matched,
      taken: Math.min(matched, Math.max(0, limit - collected.length)),
      fromFixture: Boolean(res.fromFixture),
      replayMissed: Boolean(res.replayMissed),
    });

    // 纯客户端渲染的空壳页：报"改选择器"是错的方向，必须单独说清
    if (!isJson && matched === 0 && !collectedAnySuccess) {
      const shell = detectClientRendered(res.text);
      if (shell) {
        return {
          ...fail(
            FailureClass.NEEDS_BROWSER,
            res.url,
            `${res.url} 返回的 HTML 里没有数据（可见正文只有 ${shell.visibleChars} 字），这一页靠 JavaScript 在浏览器里渲染。`,
            {
              fix:
                "不要再改选择器了 —— 这一页的 HTML 是空壳，写什么选择器都取不到内容。\n" +
                "可以走的两条路：① 用 crawlkit_probe 找这一页调用的接口，改成抓接口（推荐，最稳）；\n" +
                "② 换一个服务端渲染、或本身就是接口的地址。",
              detail: shell.note,
            },
          ),
          pages: pageReports,
        };
      }
    }
    if (matched > 0) {
      collectedAnySuccess = true;
    } else if (collected.length > 0) {
      // 前面抓到过东西、这一页空了 → 这就是列表末尾。
      // 把游标清掉：否则续抓会一直停在这个空页上，每次都"成功但 0 条"（实测会卡住）。
      nextCursor = null;
      break;
    }

    for (const item of items) {
      if (collected.length >= limit) break;
      collected.push(item);
    }

    pageIndex += 1;
    if (!paginate) break;

    if (paginate.kind === "nextLink") {
      const next = nextLinkFrom(adapter, root, res.url);
      // 没有"下一页"了：游标清空表示已翻到底（不是"从头再来"）
      if (!next) {
        nextCursor = null;
        break;
      }
      cursor = { link: next };
    } else if (paginate.kind === "cursor") {
      // 游标既可能来自 HTML 链接，也可能来自 JSON 字段
      const token = isJson
        ? pick(asJson(res), paginate.selector ?? "")
        : queryOne(root, paginate.selector ?? 'link[rel="next"]')?.attrs?.href;
      if (!token) {
        nextCursor = null;
        break;
      }
      cursor = { value: token };
    } else {
      cursor = { value: Number(cursor.value) + paginate.step };
    }
    // 续抓点与循环实际用的游标同源，避免两处算法漂移
    nextCursor = paginate.kind === "nextLink" ? cursor.link : cursor.value;
  }

  const { items, dropped } = dedupe(collected, adapter.extract.uniqueBy);
  const totalMatched = pageReports.reduce((n, r) => n + (r.matched ?? 0), 0);

  // 一条都没命中 → 判失败，这是 agent 唯一能自我校准的信号。
  // 但"真的没命中"和"命中过、全被去重掉"是两件事，必须分开说 ——
  // 后者报成"规则没命中"会把排查引向改选择器，方向完全错（实测踩过）。
  if (items.length === 0) {
    const isJson = (adapter.extract.type ?? "html") === "json";
    if (totalMatched > 0) {
      return {
        ok: true,
        adapterId: adapter.id,
        count: 0,
        totalMatched,
        duplicatesDropped: dropped,
        dedupedAll: true,
        pagesFetched: pageReports.length,
        pages: pageReports,
        items: [],
        nextCursor,
        resumedFrom: resuming ? resumeFrom : null,
        warning:
          `本次取到 ${totalMatched} 条，但它们和已抓到的内容重复，去重后没有新条目。` +
          "通常说明这个站点已经没有下一页了，或者分页规则没生效（每次都在取同一页）。",
      };
    }
    return fail(
      FailureClass.EMPTY,
      adapter.extract.items,
      isJson
        ? `路径没有取到条目：extract.items = "${adapter.extract.items}" 取出 0 条。`
        : `规则没有命中任何条目：extract.items = "${adapter.extract.items}" 匹配到 0 个元素。`,
      {
        fix: isJson
          ? "接口的响应结构与你写的路径不一致。先用 crawlkit_probe 看清这个接口返回的 JSON 结构，再改路径。"
          : "规则与页面结构不匹配。请先用 crawlkit_read 看清这一页的真实结构，再据此调整 extract.items；\n" +
            "如果页面本身没有这些内容，那不是规则问题，而是这个地址给不出想要的数据。",
        pages: pageReports,
        hint: "命中 0 条不等于抓取成功 —— 这是最常见的“看着在跑其实什么也没拿到”的形态。",
      },
    );
  }

  return {
    ok: true,
    adapterId: adapter.id,
    count: items.length,
    totalMatched,
    duplicatesDropped: dropped,
    pagesFetched: pageReports.length,
    pages: pageReports,
    items,
    // 交给调用方存起来，下次接着这个位置抓。
    // null 表示已经翻到底（没有更多了），而不是"从头再来"。
    nextCursor,
    resumedFrom: resuming ? resumeFrom : null,
    warning:
      totalMatched > items.length
        ? `匹配到 ${totalMatched} 条，但受上限限制只取了 ${items.length} 条（去重后）。`
        : "",
  };
}
