/**
 * 配置与路径解析。
 *
 * 两个要点：
 *   ① 数据默认落在【会话工作区】下，不是插件目录 —— 否则用户找不到自己的数据。
 *   ② Config 必须是 Standard Schema（手写零依赖），普通对象会让 cordis 报
 *      `Cannot read properties of undefined (reading 'validate')`。
 */

import path from "node:path";

/** 数据目录名只在这一处定义，避免"改了其中一处导致数据突然找不到"。 */
export const DEFAULT_DATA_DIR = "crawlkit-data";

/**
 * 数据目录的基准路径（加载期的兜底）。
 *
 * 权威来源是**当前会话的工作目录**（`exec.agent.session.header.cwd`），
 * 不是进程工作目录。实测踩过两次：
 *   · 用 DSH 的 workspace 表（那是所有工作区的全局集合）→ 数据落到别的工作区；
 *   · 用 `process.cwd()` 当会话工作区 → 桌面版把它设成 profile 目录，
 *     于是数据写进了 `~/.dsh/profiles/desktop/`，用户在自己的工作区里找不到。
 *
 * 插件激活时还没有会话，所以这里只能退回进程工作目录；
 * 每次工具调用都会用 `workspaceOf(exec)` 重新定位（见 tools.js 的 storeFor）。
 *
 * 这里不出现任何本机绝对路径 —— 这是"干净"要求的硬约束。
 */
export function baseDir() {
  return process.cwd();
}

/** 从一次工具调用里取会话工作区；取不到返回 null。 */
export function workspaceOf(exec) {
  const cwd = exec?.agent?.session?.header?.cwd;
  return typeof cwd === "string" && cwd.trim() ? cwd.trim() : null;
}

/** 相对路径按给定基准解析，绝对路径原样使用。 */
export function resolveDataRoot(configured, base = baseDir()) {
  const raw = configured || DEFAULT_DATA_DIR;
  if (/^([A-Za-z]:[\\/]|\\\\|\/)/.test(raw)) return raw;
  return path.join(base, raw);
}

/** 手写的 Standard Schema —— cordis 的 resolveConfig 会调用 ~standard.validate。 */
function standardSchema(fields) {
  return {
    "~standard": {
      version: 1,
      vendor: "crawlkit",
      validate(input) {
        const value = input == null ? {} : input;
        const out = {};
        for (const [key, spec] of Object.entries(fields)) {
          const given = value[key];
          if (given === undefined || given === null) {
            out[key] = spec.default;
            continue;
          }
          if (spec.type && typeof given !== spec.type) {
            return { issues: [{ message: `${key} 应为 ${spec.type}，收到 ${typeof given}`, path: [key] }] };
          }
          out[key] = given;
        }
        return { value: out };
      },
    },
  };
}

export const Config = standardSchema({
  dataRoot: {
    type: "string",
    default: DEFAULT_DATA_DIR,
    description: "数据目录。相对路径按当前会话的工作区解析，也可以用绝对路径。",
  },
  textLimit: {
    type: "number",
    default: 4000,
    description: "单次返回给模型的正文字符数上限。",
  },
  timeoutMs: {
    type: "number",
    default: 30000,
    description: "单次网络请求的超时时间（毫秒）。别设太大，否则失败一次要等很久。",
  },
  delayMs: {
    type: "number",
    default: 800,
    description: "同一站点连续请求之间的间隔（毫秒），用于主动限速。",
  },
  cookie: {
    type: "string",
    default: "",
    description:
      "登录 cookie，格式 name=value; name2=value2。留空则匿名抓取：能访问的页面变少、单页可见的数据也可能大幅减少。",
  },
  cookieFile: {
    type: "string",
    default: "",
    description:
      "从文件读 cookie（Netscape cookies.txt 或 name=value; 串）。推荐用它而不是 cookie：登录态留在配置之外的文件里，换 cookie 不用改配置、不用重启；而配置文件通常是会进 git 的，把登录凭证写进去迟早会泄露。",
  },
  loadMarker: {
    type: "boolean",
    default: false,
    description:
      "是否在数据目录里写一个 load.json 记录本次加载情况（build、解析到的数据目录、注册了哪些工具、哪些对模型可见）。默认关：它会往你的数据目录里放一个你没要的文件；排查加载问题时再打开。",
  },
});

/** 把外部配置补全成内部形状；容忍 null / 类型不对，插件不因此加载失败。 */
export function normalizeConfig(config) {
  const c = config && typeof config === "object" ? config : {};
  const positive = (v, fallback) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : fallback);
  const text = (v, fallback) => (typeof v === "string" && v.trim() ? v.trim() : fallback);

  return {
    baseDir: baseDir(),
    // 配置里的原始 dataRoot（可能是相对路径）：每次工具调用都要按会话重新解析它
    dataRootSetting: typeof c.dataRoot === "string" && c.dataRoot.trim() ? c.dataRoot.trim() : DEFAULT_DATA_DIR,
    // 加载期的解析结果，仅用于写"加载痕迹"；真正的数据目录在调用时定
    dataRoot: resolveDataRoot(typeof c.dataRoot === "string" ? c.dataRoot : ""),
    textLimit: positive(c.textLimit, 4000),
    timeoutMs: positive(c.timeoutMs, 30000),
    delayMs: positive(c.delayMs, 800),
    cookie: text(c.cookie, ""),
    // 加载痕迹：默认【关】。打开后会在数据目录里写一个 load.json，
    // 记录本次加载的 build、解析到的数据目录、注册了哪些工具、哪些对模型可见。
    // 默认关是因为它会往用户的数据目录里放一个用户没要的文件，
    // 而"数据落在哪"这件事已经由 crawlkit_selfcheck 实时报告。
    loadMarker: c.loadMarker === true,
    // 仅供包自检使用：设了就完全不写"加载痕迹"。
    // 自检不应该有副作用 —— 否则它会往用户目录里留文件（实测踩过）。
    skipLoadMarker: c.skipLoadMarker === true,
  };
}
