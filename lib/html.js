/**
 * 轻量 HTML 解析与 CSS 选择器。
 *
 * 为什么自己写：官方抓取能力只能取回纯文本，而结构化抓取必须能"按结构定位"。
 * 引入 lxml/cheerio 这类依赖会违反"零必装依赖"，所以只实现抓取真正用到的那一小块：
 *
 *   解析：元素 / 文本 / 注释 / CDATA；script·style·title·textarea 等按原文处理；
 *         隐式闭合常见到不会把 ul>li 这类结构吞掉。
 *   选择器：tag、.class、#id、*、[attr]、[attr=v]、[attr^=v] 等、
 *           :first-child、:last-child、:nth-child(n)、:not(...)、:contains(...)
 *   关系：空格（后代）、>（子）、+（紧跟的兄弟）
 *   分组：逗号
 *
 * 明确不做（做了就是无谓的复杂度）：完整 CSS 语义、伪元素、`:hover` 之类。
 */

/**
 * 内容按【原文】处理的标签：里面的尖括号不是标签。
 *
 * 这里**不能**放 `svg` —— 实测踩过：SVG 内部的 `<!--[-->` 是**真注释**，
 * 一旦把 SVG 当原文，这些标记就变成字面文本混进抓取结果
 * （B站每个图标 SVG 都是这种结构，直接污染了标题旁边的字段）。
 * `script` / `style` 里的 `<!--` 确实是 JS / CSS 代码，必须按原文。
 */
const RAW_TEXT_TAGS = new Set(["script", "style", "textarea", "title", "iframe", "noscript"]);

/** 这些标签遇到父级同名开标签时，视为隐式闭合（抓取里最常见的是 li / p / tr / td）。 */
const AUTO_CLOSE = {
  li: new Set(["li"]),
  p: new Set(["p", "div", "ul", "ol", "li", "table", "h1", "h2", "h3", "h4", "h5", "h6"]),
  td: new Set(["td", "th", "tr"]),
  th: new Set(["td", "th", "tr"]),
  tr: new Set(["tr"]),
  option: new Set(["option"]),
  dt: new Set(["dt", "dd"]),
  dd: new Set(["dt", "dd"]),
};

/** 解析属性串，支持双引号、单引号、无引号三种写法。 */
function parseAttributes(src) {
  const attrs = {};
  const re = /([^\s"'=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m;
  while ((m = re.exec(src))) {
    const name = m[1].toLowerCase();
    if (name === "/" || !name) continue;
    const value = m[2] ?? m[3] ?? m[4] ?? "";
    attrs[name] = decodeEntities(value);
  }
  return attrs;
}

/** 只处理抓取里真正会遇到的实体；不全量实现 HTML 实体表。 */
export function decodeEntities(s) {
  if (typeof s !== "string" || s.indexOf("&") === -1) return s;
  const named = {
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0",
    hellip: "…", mdash: "—", ndash: "–", middot: "·", times: "×",
    ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’", copy: "©", reg: "®",
  };
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return Object.prototype.hasOwnProperty.call(named, body.toLowerCase()) ? named[body.toLowerCase()] : whole;
  });
}

function makeElement(tag, attrs, parent) {
  return { type: "element", tag, attrs, children: [], parent };
}

function makeText(text, parent) {
  return { type: "text", text, children: [], parent };
}

/**
 * 把 HTML 解析成树。返回 { root, truncated }。
 * `maxNodes` 是防爆保护：超大页面只解析前 N 个节点，并如实报告截断。
 */
export function parseHtml(html, maxNodes = 60000) {
  const root = { type: "element", tag: "#root", attrs: {}, children: [], parent: null };
  let cur = root;
  let i = 0;
  let nodes = 1;
  let truncated = false;
  const src = String(html ?? "");

  const push = (node) => {
    node.parent = cur;
    cur.children.push(node);
    nodes += 1;
    if (nodes > maxNodes) truncated = true;
    return node;
  };

  while (i < src.length && !truncated) {
    const lt = src.indexOf("<", i);

    if (lt === -1) {
      const text = src.slice(i);
      if (text.trim()) push(makeText(decodeEntities(text), cur));
      break;
    }
    if (lt > i) {
      const text = src.slice(i, lt);
      if (text.trim()) push(makeText(decodeEntities(text), cur));
      i = lt;
    }

    // 注释 / CDATA / DOCTYPE / 处理指令
    if (src.startsWith("<!--", i)) {
      const end = src.indexOf("-->", i + 4);
      i = end === -1 ? src.length : end + 3;
      continue;
    }
    if (src.startsWith("<![", i)) {
      const end = src.indexOf("]]>", i + 2);
      i = end === -1 ? src.length : end + 3;
      continue;
    }
    if (src.startsWith("<!", i) || src.startsWith("<?", i)) {
      const end = src.indexOf(">", i);
      i = end === -1 ? src.length : end + 1;
      continue;
    }

    const gt = src.indexOf(">", i);
    if (gt === -1) break; // 尾部残缺标签，丢弃
    const inner = src.slice(i + 1, gt);
    i = gt + 1;

    if (inner[0] === "/") {
      const tag = inner.slice(1).trim().toLowerCase();
      // 闭合到最近的同名祖先；找不到就忽略（容错优先）
      let node = cur;
      while (node && node !== root && node.tag !== tag) node = node.parent;
      if (node && node !== root) cur = node.parent;
      continue;
    }

    const selfClosing = inner.endsWith("/");
    const spaceAt = inner.search(/[\s/]/);
    const tag = (spaceAt === -1 ? inner : inner.slice(0, spaceAt)).trim().toLowerCase();
    if (!tag) continue;
    const attrs = parseAttributes(spaceAt === -1 ? "" : inner.slice(spaceAt));

    // 隐式闭合：li/p/td/tr 等。
    //
    // 方向必须对：拿【当前】元素的规则，去查【新标签】是否要求它闭合。
    //   正确：<li> 里遇到 <li> → 当前是 li，AUTO_CLOSE.li 含 li → 闭合
    //   反例（曾经写反）：<div> 里遇到 <p> → 拿 AUTO_CLOSE.p 去查 cur=div，
    //     而 AUTO_CLOSE.p 恰好含 "div"，于是把外层 div 关掉了，
    //     `<div><p>x</p></div>` 被解析成 div 与 p 互为兄弟。
    //     后果很隐蔽：`div.bd span` 之类选择器全返回 0，看起来像"选择器写错了"，
    //     实测让人白排查很久（豆瓣详情页 #info 整块取不到就是这个原因）。
    const closes = AUTO_CLOSE[cur.tag];
    if (closes && closes.has(tag)) cur = cur.parent;

    const el = push(makeElement(tag, attrs, cur));
    if (selfClosing) continue;

    if (RAW_TEXT_TAGS.has(tag)) {
      // 原文内容：不解析其中的尖括号，并把文本挂在【该元素】下（挂到 cur 会变成兄弟节点）
      const closeRe = new RegExp(`</${tag}\\s*>`, "i");
      const rest = src.slice(i);
      const m = closeRe.exec(rest);
      const raw = m ? rest.slice(0, m.index) : rest;
      if (raw.trim()) el.children.push(makeText(decodeEntities(raw), el));
      i += m ? m.index + m[0].length : rest.length;
      continue;
    }

    cur = el;
  }

  return { root, truncated };
}

// ------------------------------------------------------------------ 选择器

/**
 * 解析一个复合选择器（不带关系符），如 `div.item[data-id]:first-child`。
 *
 * 用命名分组而不是编号分组：编号分组一旦算错，属性选择器会和伪类串位，
 * 表现为「`:hover` 被当成属性名静默吞掉」这种极难发现的错误（实测踩过）。
 */
const COMPOUND_TOKEN = new RegExp(
  [
    "(?<tag>[a-zA-Z][\\w-]*|\\*)",
    "|\\.(?<cls>[\\w-]+)",
    "|#(?<id>[\\w-]+)",
    "|\\[(?<attr>[\\w-]+)(?:(?<op>[~^$*|]?=)\\s*(?:\"(?<dq>[^\"]*)\"|'(?<sq>[^']*)'|(?<uq>[^\\]]*)))?\\]",
    "|:(?<pseudo>[\\w-]+)(?:\\((?<parg>[^)]*)\\))?",
  ].join(""),
  "g",
);

function parseCompound(text) {
  const simple = { tag: null, classes: [], id: null, attrs: [], pseudos: [] };
  const re = new RegExp(COMPOUND_TOKEN.source, "g");
  let m;
  let consumed = 0;

  while ((m = re.exec(text))) {
    if (m.index !== consumed) return null; // 中间有认不出的语法
    consumed = m.index + m[0].length;
    const g = m.groups ?? {};

    if (g.tag) simple.tag = g.tag.toLowerCase();
    else if (g.cls) simple.classes.push(g.cls);
    else if (g.id) simple.id = g.id;
    else if (g.attr) {
      simple.attrs.push({
        name: g.attr.toLowerCase(),
        op: g.op ?? null,
        value: g.dq ?? g.sq ?? g.uq ?? "",
      });
    } else if (g.pseudo) {
      const name = g.pseudo.toLowerCase();
      const arg = g.parg ?? "";
      // 遇到不支持的伪类必须整体判定为不可解析 —— 否则 `li:hover` 会被当成 `li`，
      // 静默返回一个"看起来对但语义不是用户要的"结果。
      if (name === "contains" || name === "first-child" || name === "last-child" || name === "not") {
        simple.pseudos.push({ name, arg: name === "contains" ? unquote(arg) : arg });
      } else if (name === "nth-child") {
        simple.pseudos.push({ name, arg: arg.trim() });
      } else {
        return null;
      }
    }
  }

  return consumed === text.length ? simple : null;
}

function unquote(s) {
  const t = String(s).trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
  return t;
}

/**
 * 解析完整选择器串成 [{ compound, combinator }] 的分组列表。
 * combinator 表示"该复合选择器相对前一个的关系"：' ' 后代、'>' 子、'+' 相邻兄弟。
 */
export function parseSelector(input) {
  const groups = [];
  for (const raw of String(input).split(",")) {
    const text = raw.trim();
    if (!text) continue;
    const steps = [];
    let buf = "";
    let combinator = " ";
    let explicit = false; // 是否刚读过 > 或 + —— 决定后面的空白是"关系符"还是纯排版空格
    let bad = false;

    const flush = () => {
      if (!buf) return;
      const compound = parseCompound(buf);
      if (!compound) bad = true;
      else steps.push({ compound, combinator });
      buf = "";
    };

    for (let k = 0; k < text.length; k++) {
      const ch = text[k];
      if (ch === ">" || ch === "+") {
        flush();
        combinator = ch;
        explicit = true;
      } else if (/\s/.test(ch)) {
        flush();
        if (steps.length && !explicit) combinator = " ";
      } else {
        // :not(...) 里的内容整体吃掉，避免括号里的空格被当成关系符
        if (ch === ":") {
          const open = text.indexOf("(", k);
          const colonEnd = text.slice(k).search(/[\s>+]/);
          if (open !== -1 && (colonEnd === -1 || open < k + colonEnd)) {
            const close = text.indexOf(")", open);
            if (close !== -1) {
              buf += text.slice(k, close + 1);
              k = close;
              explicit = false;
              continue;
            }
          }
        }
        buf += ch;
        explicit = false;
      }
    }
    flush();
    if (bad) return null;
    if (steps.length) groups.push(steps);
  }
  return groups.length ? groups : null;
}

function attrMatches(el, { name, op, value }) {
  const actual = el.attrs?.[name];
  if (actual === undefined) return false;
  if (!op) return true;
  switch (op) {
    case "=":
      return actual === value;
    case "~=":
      return actual.split(/\s+/).includes(value);
    case "^=":
      return actual.startsWith(value);
    case "$=":
      return actual.endsWith(value);
    case "*=":
      return actual.includes(value);
    case "|=":
      return actual === value || actual.startsWith(`${value}-`);
    default:
      return false;
  }
}

function elementIndex(el) {
  const parent = el.parent;
  if (!parent) return 1;
  let n = 0;
  for (const sib of parent.children) {
    if (sib.type !== "element") continue;
    n += 1;
    if (sib === el) return n;
  }
  return 1;
}

function matchesCompound(el, c) {
  if (el.type !== "element") return false;
  if (c.tag && c.tag !== "*" && el.tag !== c.tag) return false;
  if (c.id && el.attrs.id !== c.id) return false;
  for (const cls of c.classes) {
    const list = (el.attrs.class ?? "").split(/\s+/);
    if (!list.includes(cls)) return false;
  }
  for (const a of c.attrs) if (!attrMatches(el, a)) return false;

  for (const p of c.pseudos) {
    if (p.name === "first-child" && elementIndex(el) !== 1) return false;
    if (p.name === "last-child") {
      const siblings = el.parent ? el.parent.children.filter((n) => n.type === "element") : [el];
      if (siblings[siblings.length - 1] !== el) return false;
    }
    if (p.name === "nth-child") {
      const idx = elementIndex(el);
      if (p.arg === "odd" && idx % 2 === 0) return false;
      else if (p.arg === "even" && idx % 2 !== 0) return false;
      else if (/^\d+$/.test(p.arg) && idx !== Number(p.arg)) return false;
    }
    if (p.name === "not") {
      const inner = parseCompound(String(p.arg).trim());
      if (!inner) return false; // 不认识的 :not 参数一律不匹配，宁可空也不要错
      if (matchesCompound(el, inner)) return false;
    }
    if (p.name === "contains" && !textOf(el).includes(p.arg)) return false;
  }
  return true;
}

function findRoot(node) {
  let n = node;
  while (n.parent) n = n.parent;
  return n;
}

/** 在 root 子树里按选择器找元素（文档顺序）。 */
export function queryAll(root, selector) {
  const groups = parseSelector(selector);
  if (!groups) return [];

  const out = [];
  const seen = new Set();

  const descendants = (node, acc) => {
    for (const child of node.children) {
      if (child.type !== "element") continue;
      acc.push(child);
      descendants(child, acc);
    }
    return acc;
  };

  for (const steps of groups) {
    // 从最左的复合选择器开始匹配，再逐步向右侧推进
    let current = descendants(root, []);
    let matched = null;
    for (let s = 0; s < steps.length; s++) {
      const { compound, combinator } = steps[s];
      if (s === 0) {
        matched = current.filter((el) => matchesCompound(el, compound));
      } else {
        const next = [];
        for (const el of matched) {
          if (combinator === ">") {
            for (const c of el.children) if (c.type === "element" && matchesCompound(c, compound)) next.push(c);
          } else if (combinator === "+") {
            const siblings = el.parent ? el.parent.children.filter((n) => n.type === "element") : [];
            const at = siblings.indexOf(el);
            const sib = at >= 0 ? siblings[at + 1] : null;
            if (sib && matchesCompound(sib, compound)) next.push(sib);
          } else {
            for (const d of descendants(el, [])) if (matchesCompound(d, compound)) next.push(d);
          }
        }
        matched = next;
      }
      if (!matched.length) break;
    }
    for (const el of matched ?? []) {
      if (!seen.has(el)) {
        seen.add(el);
        out.push(el);
      }
    }
  }

  // 恢复文档顺序，让结果稳定可预期
  const order = new Map();
  descendants(root, []).forEach((el, idx) => order.set(el, idx));
  out.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
  return out;
}

/** 取第一个匹配元素。 */
export function queryOne(root, selector) {
  return queryAll(root, selector)[0] ?? null;
}

// ------------------------------------------------------------------ 取值

/** 元素（含后代）的纯文本。 */
export function textOf(el) {
  if (!el) return "";
  if (el.type === "text") return el.text;
  let out = "";
  for (const child of el.children) out += textOf(child);
  return out;
}

/** 把元素的子节点重新序列化成 HTML（用于 take: "html"）。 */
export function innerHtmlOf(el) {
  if (!el || el.type !== "element") return "";
  return el.children.map(serialize).join("");
}

function serialize(node) {
  if (node.type === "text") return node.text;
  const attrs = Object.entries(node.attrs ?? {})
    .map(([k, v]) => (v === "" ? ` ${k}` : ` ${k}="${String(v).replace(/"/g, "&quot;")}"`))
    .join("");
  return `<${node.tag}${attrs}>${node.children.map(serialize).join("")}</${node.tag}>`;
}

/** 取元素文本并压缩空白。 */
export function cleanText(el) {
  return textOf(el).replace(/\s+/g, " ").trim();
}

// ------------------------------------------------------- 字段取值方式解析

/**
 * 把一个字段定义解析成 { sel, take, name }。
 *
 * 支持两种写法，避免让调用方记两套东西：
 *   结构化：{ sel: "h3", take: "attr", name: "href" }
 *   简写式：{ sel: "h3::text" } / { sel: "a@href" } / { sel: ".x::html" }
 *
 * `sel` 留空表示【条目元素本身】，用于取整条记录（`{ sel: "", take: "html" }`
 * 取这一条的整段 HTML）。为什么需要它：字段选择器是在条目元素【内部】查找的，
 * 写条目自己的选择器查不到自己（`items: "div.bd"` + `sel: "div.bd"` 得到 0 个匹配）。
 * 这不是 bug 而是 CSS 后代选择器的语义，但没有空写法时调用方只能靠猜。
 *
 * `take: "all"` 不参与简写式（它表示"取全部匹配"，而不是取元素的哪一部分），
 * 所以要取多个就显式写 take:"all"，避免和 `::text` 这类"取什么"的语义混淆。
 *
 * 放在这里而不是引擎里：**校验和执行必须共用同一个解析** ——
 * 否则 `h3::text` 会被校验当成非法选择器拒掉，而执行时其实是合法的（实测踩过）。
 */
export function resolveTake(spec) {
  let sel = String(spec?.sel ?? "").trim();
  let take = spec?.take ?? "text";
  let name = spec?.name ?? null;

  const htmlMatch = sel.match(/::(text|html)\s*$/i);
  if (htmlMatch) {
    take = htmlMatch[1].toLowerCase();
    sel = sel.slice(0, htmlMatch.index).trim();
  }
  const attrMatch = sel.match(/@([\w-]+)\s*$/);
  if (attrMatch) {
    // `take: "all"` 是"取全部匹配"，与 @attr（取元素的哪个属性）不冲突，
    // 所以不能把 take 覆盖成 "attr" —— 覆盖会让 take:"all" 静默失效，
    // 结果从数组退回成单个值，而调用方以为自己在用多值（实测踩过）。
    if (take !== "all") take = "attr";
    name = attrMatch[1];
    sel = sel.slice(0, attrMatch.index).trim();
  }
  return { sel, take, name };
}
