/**
 * 网络传输：请求、解码、cookie、限速。
 *
 * 三件事容易静默出错，都在这里集中处理：
 *   ① 解码：头部常常不声明 charset，页面的真实编码只能从 <meta> 前若干字节里找；
 *      解错了【不报错】，只是一串乱码。内置可用编码有限，解不了的要如实说"解不了"。
 *   ② cookie：域名比较绝不能用裸后缀匹配 —— 那会把 A 站的登录态发给 B 站。
 *      必须按**点边界**比（见 hostMatches）。
 *   ③ 风控：被拦时常返回 200 + 一个"出错啦"页面，必须判成失败，否则会变成空数据空转。
 */

import { classifyNetworkError, detectBlock, detectLoginPage, fail, FailureClass } from "./failure.js";

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

// ---------------------------------------------------------------- 编码

/** BOM → 编码名。 */
const BOMS = [
  [[0xef, 0xbb, 0xbf], "utf-8"],
  [[0xff, 0xfe], "utf-16le"],
  [[0xfe, 0xff], "utf-16be"],
];

/** 常见 charset 别名 → TextDecoder 认识的名字。 */
const CHARSET_ALIASES = {
  "utf8": "utf-8",
  "utf-8": "utf-8",
  "gb2312": "gb18030",
  "gbk": "gb18030",
  "gb18030": "gb18030",
  "big5": "big5",
  "big5-hkscs": "big5",
  "shift_jis": "shift_jis",
  "shift-jis": "shift_jis",
  "sjis": "shift_jis",
  "euc-jp": "euc-jp",
  "euc-kr": "euc-kr",
  "iso-8859-1": "windows-1252", // 现实里几乎都是 windows-1252
  "latin1": "windows-1252",
  "windows-1252": "windows-1252",
  "us-ascii": "utf-8",
};

function sniffBom(buf) {
  for (const [bytes, name] of BOMS) {
    if (bytes.every((b, i) => buf[i] === b)) return name;
  }
  return null;
}

/** 从头部若干字节里找 <meta charset>（要按 latin1 读，否则编码还没定就先错了）。 */
function sniffMeta(buf) {
  const head = buf.subarray(0, 8192).toString("latin1");
  const direct = head.match(/<meta[^>]*charset\s*=\s*["']?\s*([\w-]+)/i);
  if (direct) return direct[1];
  const httpEquiv = head.match(/<meta[^>]*http-equiv\s*=\s*["']?content-type["']?[^>]*content\s*=\s*["'][^"']*charset=([\w-]+)/i);
  return httpEquiv ? httpEquiv[1] : null;
}

function sniffHeaderEncoding(contentType) {
  const m = String(contentType ?? "").match(/charset\s*=\s*["']?\s*([\w-]+)/i);
  return m ? m[1] : null;
}

/** 检测某个编码在本运行时是否真的可用（能 import 到 ≠ 能用）。 */
function decoderFor(charset) {
  if (!charset) return null;
  const name = CHARSET_ALIASES[String(charset).toLowerCase().trim()];
  if (!name) return null;
  try {
    return { name, decoder: new TextDecoder(name) };
  } catch {
    return null;
  }
}

/**
 * 按优先级判定编码，并解出文本。
 *
 * 返回值里带 `encoding` 与 `suspect`：
 *   · 编码明确 → 直接用；
 *   · 找不到声明 → 先用 UTF-8，若出现替换字符且该文本"看起来像中文站"，
 *     再试 gb18030，谁更干净用谁；
 *   · 声明了但本运行时解不了 → 明确报告，不硬解出乱码。
 */
export function decodeBody(buf, contentType) {
  const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);

  const bom = sniffBom(bytes);
  const declared = sniffHeaderEncoding(contentType) ?? sniffMeta(bytes);
  const attempts = [];

  if (bom) attempts.push(bom);
  if (declared) attempts.push(declared);
  attempts.push("utf-8", "gb18030"); // 兜底：先 UTF-8，再中文最常见的 gb18030

  const tried = [];
  let unsupported = null;

  for (const charset of attempts) {
    const found = decoderFor(charset);
    if (!found) {
      if (charset === declared && unsupported === null) unsupported = charset;
      continue;
    }
    let text;
    try {
      text = found.decoder.decode(bytes);
    } catch {
      continue;
    }
    const bad = (text.match(/\uFFFD/g) ?? []).length;
    tried.push({ encoding: found.name, bad });

    // 编码是 BOM 或头部明确声明的：直接采信，不再比较
    if (bom && found.name === CHARSET_ALIASES[bom]) return { text, encoding: found.name, suspect: false };
    if (declared && found.name === CHARSET_ALIASES[String(declared).toLowerCase()]) {
      return { text, encoding: found.name, suspect: bad > 0 };
    }
    // 否则：没有替换字符就算干净，可以用
    if (bad === 0) return { text, encoding: found.name, suspect: false };
  }

  // 所有尝试都有坏字符：选坏得最少的，并如实标记可疑
  tried.sort((a, b) => a.bad - b.bad);
  const best = tried[0];
  if (best) {
    const found = decoderFor(best.encoding);
    return {
      text: found ? found.decoder.decode(bytes) : bytes.toString("utf8"),
      encoding: best.encoding,
      suspect: true,
    };
  }

  return {
    text: bytes.toString("utf8"),
    encoding: "utf-8",
    suspect: true,
    unsupportedCharset: unsupported ?? declared ?? null,
  };
}

// ---------------------------------------------------------------- cookie

/** 解析 `name=value; name2=value2` 形式的 cookie 串。 */
export function parseCookieString(raw) {
  const out = [];
  for (const part of String(raw ?? "").split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    out.push({ name: trimmed.slice(0, eq).trim(), value: trimmed.slice(eq + 1).trim() });
  }
  return out;
}

/** 解析 Netscape cookies.txt（用户从浏览器扩展导出的常见格式）。 */
export function parseNetscapeCookies(text) {
  const out = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const cols = trimmed.split(/\t/);
    if (cols.length < 7) continue;
    out.push({ domain: cols[0], name: cols[5], value: cols[6], path: cols[2] });
  }
  return out;
}

/**
 * 域名匹配：按**点边界**比较。
 *
 * 绝不能用裸后缀匹配：那样一个以目标域名为后缀的**其他域名**也会命中，
 * 等于把 A 站的登录态发给了 B 站。
 */
export function hostMatches(host, domain) {
  const h = String(host ?? "").toLowerCase();
  const d = String(domain ?? "").toLowerCase().replace(/^\./, "");
  if (!h || !d) return false;
  return h === d || h.endsWith(`.${d}`);
}

/** 极简 cookie 罐：够用于"用户提供 cookie 抓登录站"这一场景。 */
export class CookieJar {
  constructor() {
    this.entries = []; // { name, value, domain, path, expires }
  }

  /** 用户显式提供的 cookie：绑定到给定 host（含其子域）。 */
  setForHost(host, cookieStringOrList) {
    const list = typeof cookieStringOrList === "string"
      ? parseCookieString(cookieStringOrList)
      : Array.isArray(cookieStringOrList) ? cookieStringOrList : [];
    for (const c of list) {
      if (!c.name) continue;
      this.entries.push({
        name: c.name,
        value: c.value ?? "",
        domain: c.domain ? String(c.domain).toLowerCase() : String(host ?? "").toLowerCase(),
        path: c.path ?? "/",
      });
    }
  }

  /** 从响应里收 cookie。 */
  absorb(host, setCookieHeaders) {
    for (const raw of setCookieHeaders ?? []) {
      const segments = String(raw).split(";");
      const first = segments.shift() ?? "";
      const eq = first.indexOf("=");
      if (eq <= 0) continue;
      const entry = {
        name: first.slice(0, eq).trim(),
        value: first.slice(eq + 1).trim(),
        domain: String(host ?? "").toLowerCase(),
        path: "/",
      };
      for (const seg of segments) {
        const [k, v] = seg.split("=").map((s) => s?.trim());
        const key = k?.toLowerCase();
        if (key === "domain" && v) entry.domain = v.toLowerCase().replace(/^\./, "");
        else if (key === "path" && v) entry.path = v;
        else if (key === "max-age" && Number(v) <= 0) entry.expires = 0;
      }
      if (entry.expires === 0) {
        this.entries = this.entries.filter((e) => !(e.name === entry.name && hostMatches(host, e.domain)));
        continue;
      }
      // 同名同域只保留最后一个
      this.entries = this.entries.filter((e) => !(e.name === entry.name && e.domain === entry.domain));
      this.entries.push(entry);
    }
  }

  /** 生成 Cookie 头；只发匹配该 host 的项。 */
  headerFor(host, pathname = "/") {
    const picked = this.entries.filter(
      (e) => hostMatches(host, e.domain) && (e.path === "/" || String(pathname).startsWith(e.path)),
    );
    if (!picked.length) return "";
    return picked.map((e) => `${e.name}=${e.value}`).join("; ");
  }
}

// ---------------------------------------------------------------- 抓取

/**
 * 抓一个地址。
 *
 * 返回统一形状：成功 { ok: true, status, headers, text, encoding, ... }
 *               失败 { ok: false, failureClass, error, fix, ... }
 * 永不抛异常 —— 让调用方总能拿到可读的结论。
 */
export async function fetchPage(url, options = {}) {
  const {
    timeoutMs = 30000,
    cookieHeader = "",
    extraHeaders = {},
    maxBytes = 8 * 1024 * 1024,
    jar = null,
    method = "GET",
    body = "",
  } = options;

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return fail(FailureClass.INPUT, "", `不是合法的网址：${url}`, {
      fix: "请给一个完整地址，包含 http:// 或 https://。",
    });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return fail(FailureClass.INPUT, parsed.host, `不支持的协议：${parsed.protocol}`, {
      fix: "只支持 http 与 https。",
    });
  }

  const headers = { "user-agent": DEFAULT_UA, accept: "*/*", "accept-language": "zh-CN,zh;q=0.9,en;q=0.8", ...extraHeaders };
  const cookie = jar ? jar.headerFor(parsed.hostname, parsed.pathname) : cookieHeader;
  if (cookie) headers.cookie = cookie;

  // 请求方法与请求体。
  //
  // 为什么必须真做：适配器校验里写着支持 POST，但这里以前只调
  // `fetch(url, { headers, redirect, signal })` —— 不带 method 就是 GET。
  // 于是"POST 适配器"会通过校验、保存成功，实际发出去的却是 GET，
  // 属于"通过了但行为不是你说的那样"，最难发现（实测核实过）。
  const verb = String(method ?? "GET").toUpperCase();
  const payload = typeof body === "string" ? body : "";
  const hasBody = payload !== "" && verb !== "GET" && verb !== "HEAD";
  if (hasBody && !headers["content-type"]) {
    // 没写就按最常见的表单给一个默认值；写了就以调用方的为准
    headers["content-type"] = "application/x-www-form-urlencoded";
  }

  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;

  let res;
  try {
    res = await fetch(url, {
      method: verb,
      headers,
      redirect: "manual",
      signal,
      ...(hasBody ? { body: payload } : {}),
    });
  } catch (err) {
    const { cls, error } = classifyNetworkError(err);
    return fail(cls, parsed.host, error, {
      fix:
        cls === FailureClass.TIMEOUT
          ? "目标站可能很慢或被限速。先确认它在本机浏览器里能打开；能打开还超时说明站点本身慢。"
          : "这类问题出在网络可达性，不在抓取参数。请先确认这个地址在本机浏览器里能正常打开。",
      detail: `${err?.name ?? ""}: ${err?.message ?? ""}`,
    });
  }

  // 手动处理重定向：这样每一跳都能正确带上 cookie
  if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
    const location = new URL(res.headers.get("location"), url).href;
    if (jar) jar.absorb(parsed.hostname, res.headers.getSetCookie?.() ?? []);
    if (options.redirectCount >= 5) {
      return fail(FailureClass.NETWORK, parsed.host, "重定向次数过多。", { fix: "该地址可能陷入了循环跳转。" });
    }
    return fetchPage(location, { ...options, redirectCount: (options.redirectCount ?? 0) + 1 });
  }

  if (jar) jar.absorb(parsed.hostname, res.headers.getSetCookie?.() ?? []);

  let buf;
  try {
    const ab = await res.arrayBuffer();
    buf = Buffer.from(ab);
  } catch (err) {
    const { cls, error } = classifyNetworkError(err);
    return fail(cls, parsed.host, error, { detail: `${err?.name}: ${err?.message}` });
  }

  const truncated = buf.length > maxBytes;
  // 注意：这里的 rawBody 是【响应体】。上面 options 里的 body 是【请求体】，
  // 两者同名会遮蔽，所以这里改名。
  const rawBody = truncated ? buf.subarray(0, maxBytes) : buf;
  const contentType = res.headers.get("content-type") ?? "";
  const { text, encoding, suspect, unsupportedCharset } = decodeBody(rawBody, contentType);

  const result = {
    ok: true,
    status: res.status,
    url: res.url || url,
    finalHost: parsed.hostname,
    contentType,
    bytes: buf.length,
    truncated,
    encoding,
    encodingSuspect: suspect,
    text,
    headers: Object.fromEntries(res.headers.entries()),
  };

  // 凭据类要排在风控类之前判：403 既是"状态码像被拦"也是"要登录"，
  // 而两者给的下一步完全不同 —— 判错会把用户引向错误的方向。
  if (res.status === 401 || res.status === 403) {
    return fail(FailureClass.CREDENTIAL, parsed.host, `${parsed.host} 拒绝了本次访问（HTTP ${res.status}），通常表示需要登录态。`, {
      fix:
        "请先在浏览器登录该站，把 cookie 交给 crawlkit（配置里的 cookie 项，或调用时传 cookie 参数）。" +
        "如果已经提供了 cookie，说明它已失效或缺少另外的令牌。\n" +
        "若这个站本来就不需要登录，那它是在做风控拦截 —— 换参数不会通过。",
      status: res.status,
    });
  }

  // 风控 / 挑战页：必须判成失败，绝不能当成功返回空数据
  if (detectBlock(res.status, text)) {
    return fail(FailureClass.BLOCKED, parsed.host, `${parsed.host} 拒绝了本次抓取（风控或访问控制）。`, {
      fix:
        "这类站点主动阻止自动化访问，换参数不会通过。不要再试同一个地址；" +
        "换数据源，或改用该站提供的正式接口/导出功能。",
      detail: `HTTP ${res.status}${contentType ? ` · ${contentType}` : ""}`,
      status: res.status,
    });
  }

  if (detectLoginPage(text)) {
    return fail(FailureClass.CREDENTIAL, parsed.host, `${parsed.host} 返回的是登录页，不是内容。`, {
      fix: "该页需要登录态。请提供 cookie 后重试；已提供则说明 cookie 已失效。",
      status: res.status,
    });
  }

  if (res.status >= 400) {
    return fail(FailureClass.NETWORK, parsed.host, `${parsed.host} 返回 HTTP ${res.status}。`, {
      fix:
        res.status === 404
          ? "地址不存在。请确认链接是否正确。"
          : "这是目标站返回的状态码，通常与抓取参数无关。",
      status: res.status,
    });
  }

  if (unsupportedCharset) {
    result.note = `页面声明的编码 ${unsupportedCharset} 无法在本运行时解码，已按 ${encoding} 处理，可能出现乱码。`;
  } else if (suspect) {
    result.note = `页面没有可靠声明编码，已按 ${encoding} 解码；若见到乱码，说明这个站用了不常见的编码。`;
  }

  return result;
}

// ------------------------------------------------------- JSON / 接口风控

/** 尝试把响应解析成 JSON。不是 JSON 就返回 null（调用方据此走 HTML 路线）。 */
export function asJson(res) {
  const text = String(res?.text ?? "").trimStart();
  // 以内容为准，不完全信 content-type：很多接口把它写错
  if (!text || (text[0] !== "{" && text[0] !== "[")) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * 识别"HTTP 200，但 body 是错误码"的接口风控。
 *
 * 这是最阴的一类失败：状态码正常、内容也是合法 JSON，
 * 只有 body 里的 `code` 说明"我被拒了"。不识别它就会把风控误报成"没有数据"，
 * 让调用方反复改选择器。实测：某站接口在限流时返回 `{"code":-352}`，HTTP 却是 200。
 *
 * 判定刻意保守，两条**同时**成立才算：
 *   ① 有明确的失败信号（`code` 非 0 / `success:false` / `status:"error"` / 有 `error`）；
 *   ② **没有可用的数组数据** —— 否则会把"`code` 恰好是业务字段、数据却正常"的响应
 *      误杀（实测踩过：`{code:7, data:{list:[...]}}` 是正常响应）。
 */
export function detectApiError(json) {
  if (!json || typeof json !== "object" || Array.isArray(json)) return null;

  const code = json.code ?? json.error_code ?? json.errcode;
  const failed =
    (typeof code === "number" && code !== 0) ||
    json.success === false ||
    json.ok === false ||
    (json.status === "error" && json.data === undefined) ||
    (typeof json.error === "string" && json.error.trim() !== "" && json.data === undefined);

  if (!failed) return null;
  if (containsArray(json.data)) return null; // 有数据就不是风控

  return {
    code: code ?? json.status ?? "unknown",
    message: String(json.message ?? json.msg ?? json.error ?? "").trim(),
  };
}

/** data 里是否存在"列表型数据"（哪怕为空 —— 空列表也是接口正常给出的结果）。 */
function containsArray(value, depth = 0) {
  if (depth > 3 || !value || typeof value !== "object") return false;
  if (Array.isArray(value)) return true;
  return Object.values(value).some((v) => containsArray(v, depth + 1));
}

// --------------------------------------------- 客户端渲染的空壳页识别

const APP_MOUNT_RE = /<div[^>]+id\s*=\s*["'](app|root|__next|__nuxt|main)["']/i;

/**
 * 识别"HTML 里根本没有内容"的纯客户端渲染页。
 *
 * 为什么必须单独判：这类页面返回 200、也不是风控、也不是登录页，
 * 但 HTML 只是空壳。若按"选择器没命中"报出去，调用方会一直改选择器，
 * 而无论怎么改都取不到东西 —— 实测某站的排行榜页就是这种（5KB 空壳，
 * 去标签后可见文本只有几百字，还全是 CSS）。
 *
 * 判定用"可见文本极少" + "存在框架挂载点或体积不小"两条同时成立，
 * 避免把一个内容确实很少的正常小页面误判。
 */
export function detectClientRendered(html) {
  const text = String(html ?? "");
  if (!text) return null;

  const visible = text
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (visible.length > 600) return null;

  const bytes = Buffer.byteLength(text, "utf8");
  const mount = APP_MOUNT_RE.test(text);
  if (!mount && bytes < 3 * 1024) return null;

  return {
    visibleChars: visible.length,
    bytes,
    mountPoint: mount,
    note: mount
      ? "页面里只有框架挂载点，数据靠 JavaScript 在浏览器里渲染。"
      : "页面返回的 HTML 几乎没有可见内容。",
  };
}
