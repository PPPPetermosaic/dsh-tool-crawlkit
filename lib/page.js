/**
 * 页面摘要与数据源发现。
 *
 * 这两件事是"生成适配器"的前置条件：先用最少的 token 看清一页有什么，
 * 再判断数据到底在 HTML 里、还是在接口/内嵌 JSON 里。
 */

import { cleanText, parseHtml, queryAll, queryOne, textOf } from "./html.js";

/** 去掉 script/style 之后的可读正文，用于摘要与交给模型前的裁剪。 */
export function readableText(root, limit = 4000) {
  const drop = new Set(["script", "style", "noscript", "svg", "template"]);
  const parts = [];
  let used = 0;

  const walk = (node, depth) => {
    if (used >= limit || depth > 400) return;
    if (node.type === "text") {
      const t = node.text.replace(/\s+/g, " ").trim();
      if (t) {
        parts.push(t);
        used += t.length + 1;
      }
      return;
    }
    if (node.type !== "element" || drop.has(node.tag)) return;
    for (const child of node.children) walk(child, depth + 1);
  };

  walk(root, 0);
  return parts.join(" ").slice(0, limit);
}

/**
 * 这些标签不可能是"列表条目"：文档元信息、脚本、样式、文档结构。
 *
 * 为什么必须排除：它们天然会重复出现（一篇页面有十几个 `meta`），
 * 而且文本量极大（`script` 内容动辄几 KB），
 * 任何"按内容量打分"的做法都会被它们顶到第一名 —— 实测踩过。
 */
const NON_LIST_TAGS = new Set([
  "html", "head", "body", "meta", "link", "script", "style", "title", "base",
  "br", "hr", "img", "source", "track", "noscript", "template", "iframe",
]);

/** 全树元素表（文档顺序）。 */
function allElements(root) {
  const out = [];
  const walk = (node) => {
    for (const child of node.children ?? []) {
      if (child.type !== "element") continue;
      out.push(child);
      walk(child);
    }
  };
  walk(root);
  return out;
}

/**
 * 一个便宜的"像不像同一种条目"的签名：标签 + 类名集合。
 *
 * 只看类名集合（排序后），不看顺序、不看 id —— 真实列表里同一组条目
 * 常常各自多一个位置类（`li.a` 与 `li.a.on` 并存），
 * 要求签名完全一致会把整组丢掉（实测：某书站的 20 本书就是这样被丢掉的）。
 */
function signatureOf(el) {
  const cls = (el.attrs.class ?? "").split(/\s+/).filter(Boolean).sort().join(".");
  return cls ? `${el.tag}.${cls}` : el.tag;
}

/**
 * 条目内部的字段选择器：**相对条目**，不是绝对链。
 *
 * 为什么必须相对：取字段时是在条目元素内部查询的，
 * 绝对链（从 body 开始）在那里永远匹配不到东西 —— 实测表现为
 * "匹配到 20 条，但每条的所有字段都是空的"。
 *
 * 会在条目作用域内核对唯一性：能唯一定位就用短的，定位不到就用完整子链。
 */
function relativeSelector(el, item, { shortest = false } = {}) {
  const chain = [];
  let node = el;
  while (node && node.type === "element" && node !== item && chain.length < 4) {
    if (node.attrs?.id) {
      chain.unshift(`#${node.attrs.id}`);
      break;
    }
    const cls = (node.attrs?.class ?? "").split(/\s+/).filter(Boolean)[0];
    chain.unshift(cls ? `${node.tag}.${cls}` : node.tag);
    node = node.parent;
  }
  if (!chain.length) return el.tag;

  if (!shortest) return chain.join(" > ");
  for (let from = chain.length - 1; from >= 0; from--) {
    for (const sep of [" > ", " "]) {
      const candidate = chain.slice(from).join(sep);
      if (queryAll(item, candidate).length === 1) return candidate;
    }
  }
  return chain.join(" > ");
}

/**
 * 结构性摘要：告诉调用方"这一页有什么"，而不是把整页塞进上下文。
 *
 * 重点不是列全，而是给出**能直接用**的东西。所以每条候选都带：
 *   · `selector` —— 拿去当 `extract.items` 用，且**已核对匹配数等于 itemCount**
 *   · `itemFields` —— 条目内部的子结构与示例值，用来定字段选择器
 *
 * 为什么要核对：容器本身通常只匹配 1 个元素，而候选里的"条数"是它子元素的个数。
 * 把容器选择器直接当 `extract.items` 用，会得到一个"跑得通但只有 1 条"的适配器 ——
 * 实测踩过：某新闻站的 20 条被塞进一条记录里，而条数看起来还是 20。
 */
export function summarizePage(root, { url = "", limit = 4000, maxLinks = 40, maxSamples = 15 } = {}) {
  const titleEl = queryOne(root, "title");
  const title = titleEl ? cleanText(titleEl) : "";
  const metaDesc = queryOne(root, 'meta[name="description"]')?.attrs?.content ?? "";

  const headings = [];
  for (const tag of ["h1", "h2", "h3"]) {
    const items = queryAll(root, tag).map((el) => cleanText(el)).filter(Boolean);
    if (items.length) headings.push({ level: Number(tag[1]), count: items.length, samples: items.slice(0, 5) });
  }

  // 重复出现的同种元素 = 列表页的强信号。
  //
  // 全树按签名聚合。为什么不留一个"候选容器标签白名单"：那等于用一份手写清单
  // 去猜真实页面的结构 —— 实测踩过两次：
  //   · 只看"直接子元素"→ 被包一层的列表（`ul > li > li.media`）整组丢掉；
  //   · 只用白名单标签 → `li` 不在清单里，纯 `ul > li` 的列表直接识别不出来。
  const groups = new Map();
  for (const el of allElements(root)) {
    const sig = signatureOf(el);
    if (!groups.has(sig)) groups.set(sig, []);
    groups.get(sig).push(el);
  }

  const containers = [];
  for (const [sig, members] of groups) {
    if (members.length < 3) continue;
    if (NON_LIST_TAGS.has(sig.split(".")[0])) continue;

    // 以签名涉及的首个类名为准生成选择器；能唯一对应上这组成员才采纳
    const cls = sig.includes(".") ? sig.split(".").slice(1).join(".") : null;
    const tag = sig.split(".")[0];
    let selector = null;
    for (const candidate of [cls ? `${tag}.${cls}` : tag, `.${cls}`, tag]) {
      if (!candidate || candidate === ".") continue;
      if (queryAll(root, candidate).length === members.length) {
        selector = candidate;
        break;
      }
    }
    if (!selector) continue;

    const sample = members[0];
    const linked = members.filter((m) => queryOne(m, "a[href]")).length;
    const textLen = members.reduce((n, m) => n + cleanText(m).length, 0) / members.length;
    // 排除导航/页脚这类"成员很多但每条几乎没有内容"的组。
    // 阈值故意放得很低：中文列表条目可以极短（"商品1"），
    // 收紧会把真实列表误杀，真正的噪音靠"最少 3 条 + 能唯一定位"挡掉。
    if (textLen < 3) continue;

    const childElements = sample.children.filter((c) => c.type === "element").length;
    containers.push({
      selector,
      itemCount: members.length,
      itemSignature: sig,
      sampleText: cleanText(sample).slice(0, 120),
      withLink: linked,
      avgTextLength: Math.round(textLen),
      // 字段选择器必须【相对条目】写 —— 取字段时是在条目元素内部查询的
      itemFields: sample.children
        .filter((c) => c.type === "element")
        .slice(0, 6)
        .map((c) => ({
          selector: relativeSelector(c, sample),
          alt: relativeSelector(c, sample, { shortest: true }),
          sample: cleanText(c).slice(0, 60),
        }))
        .filter((f) => f.sample),
      // 打分只看这两项，"字多"不是列表的特征
      score: members.length * (1 + Math.min(childElements, 8)) * (1 + Math.min(linked, members.length) / members.length),
    });
  }
  // 条目多、内部有结构的排前面
  containers.sort((a, b) => b.score - a.score);

  const tables = queryAll(root, "table")
    .map((t) => {
      const rows = queryAll(t, "tr");
      const header = rows[0] ? queryAll(rows[0], "th,td").map((c) => cleanText(c).slice(0, 30)) : [];
      return { rows: rows.length, header: header.slice(0, 10) };
    })
    .filter((t) => t.rows > 1);

  const links = [];
  for (const a of queryAll(root, "a[href]")) {
    const text = cleanText(a).slice(0, 60);
    if (!text) continue;
    links.push({ text, href: a.attrs.href });
    if (links.length >= maxLinks) break;
  }

  const bodyText = readableText(root, limit);

  return {
    url,
    title,
    metaDescription: String(metaDesc).slice(0, 300),
    headings,
    containers: containers.slice(0, maxSamples),
    tables: tables.slice(0, 5),
    links,
    textLength: bodyText.length,
    text: bodyText,
    hint:
      containers.length > 0
        ? `看起来是列表型页面：最大的一组重复条目在 ${containers[0].selector}（${containers[0].itemCount} 条）。` +
          `把它当 extract.items；字段选择器照 itemFields 里的子结构写。`
        : tables.length > 0
          ? "看起来以表格为主，可考虑按表格解析。"
          : "没有发现可用的重复列表结构；数据可能来自接口或内嵌 JSON，建议用 crawlkit_probe 探测。",
  };
}

// ------------------------------------------------------- 内嵌数据 / 接口线索

/**
 * 从内嵌 JSON 里提取数据。
 *
 * 为什么不用固定正则：`__NEXT_DATA__` 之类的框架变量用非贪婪匹配遇到嵌套 JSON 会截断
 * （实测：一个 101KB 的 `__INITIAL_STATE__` 就因此解析失败）。
 * 通用做法是找到 `名字 = {` 后用括号配平扫描。
 */
function balancedJsonAt(text, startIndex) {
  const open = text[startIndex];
  if (open !== "{" && open !== "[") return null;
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let quote = "";
  let escaped = false;

  for (let i = startIndex; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quote) inString = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      continue;
    }
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return text.slice(startIndex, i + 1);
    }
  }
  return null;
}

const FRAMEWORK_STATE = [
  "__NEXT_DATA__",
  "__NUXT__",
  "__INITIAL_STATE__",
  "__APOLLO_STATE__",
  "__PRELOADED_STATE__",
  "window.__data",
  "window.__INITIAL_STATE__",
];

/** 估算一个 JSON 值的"数据量"，用来判断它是不是真正的数据源。 */
function measureJson(value) {
  if (Array.isArray(value)) {
    return { kind: "array", length: value.length, sampleKeys: value[0] && typeof value[0] === "object" ? Object.keys(value[0]).slice(0, 12) : [] };
  }
  if (value && typeof value === "object") {
    return { kind: "object", length: Object.keys(value).length, sampleKeys: Object.keys(value).slice(0, 12) };
  }
  return { kind: typeof value, length: 0, sampleKeys: [] };
}

/** 扫描页面里的数据源线索。 */
export function discoverSources(root, html, { maxEmbedded = 5, maxEndpoints = 30 } = {}) {
  const source = String(html ?? "");

  // 1) JSON-LD
  const jsonLd = [];
  for (const s of queryAll(root, 'script[type="application/ld+json"]')) {
    const raw = textOf(s).trim();
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      const list = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of list) {
        jsonLd.push({ type: item?.["@type"] ?? "(未标注)", keys: Object.keys(item ?? {}).slice(0, 15) });
      }
    } catch {
      jsonLd.push({ type: "(解析失败)", keys: [] });
    }
  }

  // 2) 框架内嵌状态：先找 `名字 = {`，再括号配平
  const embedded = [];
  for (const name of FRAMEWORK_STATE) {
    const at = source.indexOf(name);
    if (at === -1) continue;
    const brace = source.indexOf("{", at);
    const bracket = source.indexOf("[", at);
    let start = -1;
    if (brace !== -1 && bracket !== -1) start = Math.min(brace, bracket);
    else start = brace !== -1 ? brace : bracket;
    if (start === -1) continue;
    const json = balancedJsonAt(source, start);
    if (!json) continue;
    try {
      const parsed = JSON.parse(json);
      embedded.push({ name, bytes: json.length, ...measureJson(parsed) });
    } catch {
      embedded.push({ name, bytes: json.length, kind: "(解析失败)", length: 0, sampleKeys: [] });
    }
    if (embedded.length >= maxEmbedded) break;
  }

  // 3) 接口线索：脚本里出现的、看起来像数据接口的地址
  const endpoints = new Set();
  const apiRe = /["'`](\/[A-Za-z0-9_\-./]*(?:api|ajax|graphql|list|feed|json)[A-Za-z0-9_\-./]*(?:\?[^"'`\s]*)?)["'`]/gi;
  let m;
  while ((m = apiRe.exec(source)) && endpoints.size < maxEndpoints) endpoints.add(m[1]);

  // 4) 分页线索
  const pagination = [];
  for (const a of queryAll(root, "a[href]")) {
    const href = a.attrs.href ?? "";
    if (/([?&](page|p|pn|offset|start|pg)=\d+)|(\/page\/\d+)/i.test(href)) {
      pagination.push({ text: cleanText(a).slice(0, 30), href });
      if (pagination.length >= 8) break;
    }
  }
  const relNext = queryOne(root, 'link[rel="next"]')?.attrs?.href ?? null;

  const verdict =
    embedded.length > 0
      ? `数据很可能在页面内嵌的 ${embedded[0].name} 里（${embedded[0].bytes} 字节，${embedded[0].kind === "array" ? `${embedded[0].length} 条` : "对象"}）。走内嵌 JSON 比解析 HTML 更稳。`
      : endpoints.size > 0
        ? `页面脚本里出现了 ${endpoints.size} 个疑似接口地址，数据可能来自接口调用。`
        : jsonLd.length > 0
          ? "页面带结构化数据（JSON-LD），可优先从它取字段。"
          : "未发现内嵌数据或接口线索，数据应直接在 HTML 里，用选择器解析。";

  return {
    verdict,
    jsonLd,
    embedded,
    endpoints: [...endpoints],
    pagination,
    relNext,
  };
}

// ------------------------------------------------------- JSON 结构探测

/**
 * 在一个接口返回的 JSON 里找"哪条路径像数据列表"。
 *
 * 为什么需要：JSON 通道要求适配器写路径（`data.list`）。让 agent 靠猜
 * 是行不通的，必须把真实结构摆出来。只往下找有限层，避免在大响应里空转。
 */
export function probeJson(json, { maxDepth = 4, maxPaths = 25, minItems = 2 } = {}) {
  const paths = [];
  const visited = new Set();

  /** 把一个数组登记成候选路径。 */
  const record = (arr, path) => {
    if (paths.length >= maxPaths) return;
    const sample = arr[0];
    const isPlain = sample && typeof sample === "object" && !Array.isArray(sample);
    paths.push({
      path,
      count: arr.length,
      itemKind: Array.isArray(sample) ? "array" : sample === null ? "null" : typeof sample,
      fields: isPlain ? Object.keys(sample).slice(0, 20) : [],
      sample: isPlain
        ? Object.fromEntries(
            Object.entries(sample)
              .slice(0, 6)
              .map(([k, v]) => [k, v === null || typeof v === "object" ? typeof v : String(v).slice(0, 40)]),
          )
        : sample,
    });
  };

  const walk = (value, path, depth) => {
    if (depth > maxDepth || !value || typeof value !== "object") return;
    if (visited.has(value)) return;
    visited.add(value);

    if (Array.isArray(value)) {
      if (value.length >= minItems) record(value, path);
      // 数组里的对象也可能含真正的列表
      if (value[0] && typeof value[0] === "object" && !Array.isArray(value[0])) {
        walk(value[0], `${path}[0]`, depth + 1);
      }
      return;
    }

    for (const [key, child] of Object.entries(value)) {
      const next = path ? `${path}.${key}` : key;
      if (Array.isArray(child)) {
        if (child.length >= minItems) record(child, next);
        if (child[0] && typeof child[0] === "object" && !Array.isArray(child[0])) {
          walk(child[0], `${next}[0]`, depth + 1);
        }
      } else if (child && typeof child === "object") {
        walk(child, next, depth + 1);
      }
    }
  };

  if (json && typeof json === "object") walk(json, "", 0);
  paths.sort((a, b) => b.count - a.count);

  return {
    topLevelKeys: json && typeof json === "object" && !Array.isArray(json) ? Object.keys(json).slice(0, 20) : [],
    code: json && typeof json === "object" && !Array.isArray(json) ? (json.code ?? null) : null,
    candidates: paths,
  };
}
