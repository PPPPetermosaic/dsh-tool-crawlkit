/**
 * 失败分类与固定话术。
 *
 * 这个模块存在的唯一理由：**止住重试循环**。
 *
 * 背景（实测踩过的坑）：插件装好后第一个任务，调用方可能连续十几分钟没有结果。
 * 根因不是某一次调用挂了，而是**每次失败都附一条新的"再试试 X"**：
 *   · 本机不可用的模式也照样建议 → 必然失败 → 又给新建议
 *   · 报错里写"加代理参数" → 调用方不知道端口 → 瞎试
 *   · 兜底建议列了三条"再试一次"
 * 单次超时又长，于是 `超时 × 重试次数` 累加成十几分钟的空转。
 *
 * 对策两条：
 *   1. 被拦截必须判成【失败】，绝不能返回"正常响应 + 空数据"；
 *   2. 同类失败到达阈值后换成固定话术，**不再提供任何新的尝试方向**。
 *
 * 写建议时的硬规则：任何一条"怎么办"，都要能回答
 *   「这条建议在这台机器上真的有可能成功吗？」
 * 答不上来就别写。
 */

/** 失败类别。同类判定要【同时】看类别和目标。 */
export const FailureClass = {
  BLOCKED: "blocked",
  CREDENTIAL: "credential",
  NETWORK: "network",
  TIMEOUT: "timeout",
  PARSE: "parse",
  EMPTY: "empty",
  INPUT: "input",
  INTERNAL: "internal",
  /** 接口返回的是风控/错误码，不是数据（HTTP 往往还是 200）。 */
  API_BLOCKED: "api-blocked",
  /** 页面是纯客户端渲染的空壳，HTML 里根本没有数据。 */
  NEEDS_BROWSER: "needs-browser",
};

/** 同一类失败连续几次后就不再给新方向。导出是为了让外部与文档/测试对齐同一份定义。 */
export const THRESHOLDS = {
  [FailureClass.CREDENTIAL]: 1,
  [FailureClass.BLOCKED]: 1,
  [FailureClass.API_BLOCKED]: 1,
  [FailureClass.NEEDS_BROWSER]: 1,
  [FailureClass.NETWORK]: 2,
  [FailureClass.TIMEOUT]: 2,
  [FailureClass.EMPTY]: 1,
};

/** 到阈值后说的固定话术：只描述状态，不给新尝试方向。 */
const ESCALATIONS = {
  [FailureClass.CREDENTIAL]: () => ({
    error: "这个站点需要登录态，当前没有可用的凭据。",
    fix:
      "改变抓取参数不会让它通过 —— 请先在浏览器里登录该站，\n" +
      "把 cookie 交给 crawlkit（配置里的 cookie 项，或调用时传 cookie 参数），然后再试。\n" +
      "如果已经提供了 cookie，说明它已失效或缺少另外的令牌，需要重新获取。",
  }),
  [FailureClass.BLOCKED]: (target) => ({
    error: `${target} 拒绝了本次抓取（风控或访问控制）。`,
    fix:
      "换任何参数都不会通过。这类站点是主动阻止自动化的，工具无法绕过。\n" +
      "不要再试同一个地址；换一个数据源，或改用该站提供的正式接口/导出功能。",
  }),
  [FailureClass.NETWORK]: (target) => ({
    error: `连不上 ${target}。`,
    fix:
      "不要再换抓取参数 —— 问题在网络可达性，不在参数。\n" +
      "请确认这个地址在本机浏览器里能正常打开；打不开就是本机网络/地区限制的问题，先解决它。",
  }),
  [FailureClass.TIMEOUT]: (target) => ({
    error: `${target} 持续超时。`,
    fix:
      "这个站点响应太慢或对自动请求做了限速。\n" +
      "换一个响应更快的目标，或稍后再试；不要靠调整抓取参数来解决。",
  }),
  [FailureClass.EMPTY]: (target) => ({
    error: `在 ${target} 上没有找到符合当前规则的内容。`,
    fix:
      "规则与页面结构不匹配。请先用 crawlkit_read 看清这一页到底有什么，再据此调整规则；\n" +
      "如果页面本身没有这些数据，那就不是规则问题，而是这个地址给不出想要的内容。",
  }),
  [FailureClass.API_BLOCKED]: (target) => ({
    error: `${target} 的接口返回了错误码，不是数据。`,
    fix:
      "这不是“规则写错了” —— 接口明确拒绝了这次请求（通常是请求签名或风控）。\n" +
      "改抓取参数不会通过。请换一个数据来源，或改用该站其它不设签名要求的接口。",
  }),
  [FailureClass.NEEDS_BROWSER]: (target) => ({
    error: `${target} 的 HTML 里没有数据 —— 这一页靠 JavaScript 在浏览器里渲染。`,
    fix:
      "不要再改选择器了：这一页返回的 HTML 是空的，无论写什么选择器都取不到内容。\n" +
      "可以走的两条路：① 用 crawlkit_probe 找这一页调用的接口，改成抓接口（推荐，最稳）；\n" +
      "② 换一个服务端渲染、或本身就是接口的地址。",
  }),
};

/**
 * 失败追踪：只保留最近一条同类记录，成功一次立即清零。
 * 判定"同类"要同时满足：同一类别 + 同一目标。
 */
export class FailureTracker {
  constructor() {
    this.last = null; // { cls, target, count }
  }

  reset() {
    this.last = null;
  }

  /** 记一次失败，返回累计次数。 */
  record(cls, target) {
    if (this.last && this.last.cls === cls && this.last.target === target) {
      this.last.count += 1;
    } else {
      this.last = { cls, target, count: 1 };
    }
    return this.last.count;
  }

  shouldEscalate(cls, count) {
    const limit = THRESHOLDS[cls];
    return typeof limit === "number" && count >= limit;
  }
}

/** 构造一条结构化的失败结果（给 render 用的统一形状）。 */
export function fail(cls, target, error, extra = {}) {
  return {
    ok: false,
    failureClass: cls,
    target: target ?? "",
    error,
    fix: extra.fix ?? "",
    detail: extra.detail ?? "",
    ...extra,
  };
}

/** 到阈值时把失败替换成固定话术，并标记"不要再试"。 */
export function escalate(cls, target) {
  const build = ESCALATIONS[cls];
  const text = build ? build(target || "目标站点") : { error: "操作未成功。", fix: "看上面的详细信息。" };
  // `ok: false` 必须带上：渲染层靠它判断走成功还是失败分支，
  // 少了它就会把失败当成功渲染（实测：升级后的结果 ok 为 undefined，渲染走错分支）。
  return { ok: false, ...text, stopRetrying: true, failureClass: cls, target: target ?? "" };
}

/** 判断 HTTP 状态码是否属于"被拦"而不是"正常的非 2xx"。 */
export function isBlockStatus(status) {
  return status === 401 || status === 403 || status === 407 || status === 429 || status === 444 || status === 503;
}

/**
 * 从页面内容里识别风控/挑战页。
 *
 * 为什么必须做：风控站常返回 HTTP 200 + 一个"出错啦"页面。
 * 若当成功返回，调用方看到的是"正常结果 + 空数据"，于是不停换参数 —— 这正是空转的直接原因。
 */
const BLOCK_MARKERS = [
  /just a moment/i,
  /cf-browser-verification/i,
  /cf-challenge/i,
  /checking your browser/i,
  /enable javascript and cookies to continue/i,
  /attention required!?\s*\|?\s*cloudflare/i,
  /access denied/i,
  /are you a robot/i,
  /请开启\s*javascript/i,
  /滑动验证/,
  /安全验证/,
  /人机验证/,
  /访问过于频繁/,
  /您的访问出错了/,
  /拒绝访问/,
];

export function detectBlock(status, bodySnippet) {
  if (isBlockStatus(status)) return true;
  const head = String(bodySnippet ?? "").slice(0, 8192);
  return BLOCK_MARKERS.some((re) => re.test(head));
}

/**
 * 识别"返回的是登录页而不是内容"。
 *
 * 为什么必须做：cookie 失效时站点通常不报错，而是返回一个登录页。
 * 当成功就变成"正常响应 + 0 条数据"，又掉进空转。
 */
const LOGIN_MARKERS = [
  /<form[^>]+(login|signin|sign-in)/i,
  /name=["'](password|passwd)["']/i,
  /需要登录/,
  /请先登录/,
  /登录后(才)?(可|能)查看/,
  /sign in to continue/i,
  /please log in/i,
  /login required/i,
];

export function detectLoginPage(bodySnippet) {
  const head = String(bodySnippet ?? "").slice(0, 8192);
  return LOGIN_MARKERS.some((re) => re.test(head));
}

/** 把网络层抛出的异常翻译成类别 + 人话。 */
export function classifyNetworkError(err) {
  const name = err?.name ?? "";
  const msg = String(err?.message ?? err ?? "");
  const cause = String(err?.cause?.code ?? err?.cause?.message ?? "");

  if (name === "AbortError" || name === "TimeoutError") {
    return { cls: FailureClass.TIMEOUT, error: "请求超时。" };
  }
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(`${msg} ${cause}`)) {
    return { cls: FailureClass.NETWORK, error: "域名解析不了（DNS 失败）。" };
  }
  if (/ECONNREFUSED/i.test(`${msg} ${cause}`)) {
    return { cls: FailureClass.NETWORK, error: "连接被拒绝。" };
  }
  if (/ECONNRESET|EPIPE|socket hang up/i.test(`${msg} ${cause}`)) {
    return { cls: FailureClass.NETWORK, error: "连接被中途断开。" };
  }
  if (/CERT|TLS|SSL/i.test(`${msg} ${cause}`)) {
    return { cls: FailureClass.NETWORK, error: "TLS 证书校验失败。" };
  }
  if (/fetch failed/i.test(msg)) {
    return { cls: FailureClass.NETWORK, error: "网络请求失败。" };
  }
  return { cls: FailureClass.INTERNAL, error: msg || "未知错误。" };
}
