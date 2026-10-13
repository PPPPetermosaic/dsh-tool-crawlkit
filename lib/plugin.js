/**
 * crawlkit :: DSH 插件入口。
 *
 * 一个给 DSH 用的网页数据工具箱：按站点生成【适配器】（纯数据的抓取规则），
 * 再用适配器把网页抽成结构化数据，落到工作区的数据集里。
 *
 * 设计上的三条硬约定（都来自实测，不是偏好）：
 *   ① 包内不内置任何站点适配器 —— 适配器是用户数据，按需生成。
 *      这同时是"仓库永远干净"的机制：站点知识天然落在仓库之外。
 *   ② 零第三方依赖 —— 官方 `@deepseek-ai/dsh-tools` 不随插件安装
 *      （实测 `MODULE_NOT_FOUND`），所以 DSL 编译按官方语义本地复刻。
 *   ③ 失败必须给"下一步怎么办"，且同类失败到阈值后换成固定话术 ——
 *      否则调用方会一直换参数重试，把 `超时 × 重试次数` 累加成十几分钟空转。
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { baseDir, Config, normalizeConfig, resolveDataRoot, workspaceOf } from "./config.js";
import { compileTool } from "./schema.js";
import { Store } from "./store.js";
import { buildTools } from "./tools.js";

export { Config };

export const name = "crawlkit";
export const inject = ["tools"];

/** 构建标记：用来区分"新代码"和"进程内存里的旧代码"。改代码后请递增。 */
const BUILD = "1.0.0";

export function apply(ctx, config = {}) {
  const cfg = normalizeConfig(config);

  // 数据目录按【当前会话的工作区】解析，而不是进程工作目录 ——
  // 桌面版的进程工作目录是 profile 目录，拿它当工作区会把数据写错地方（实测踩过）。
  // 每次工具调用都会重新定位，所以同一个进程里多个工作区的会话各写各的。
  const store = new Store(cfg.dataRootSetting, workspaceOf, resolveDataRoot);

  const tools = buildTools({ store, cfg, build: BUILD });
  for (const tool of tools) {
    ctx.tools.register(compileTool(tool));
  }

  /**
   * 记录加载痕迹，并**延迟**回读注册表确认工具对模型可见。
   *
   * 默认**不写**：它会往用户的数据目录里放一个用户没要的文件，而它当初的用途
   * （排查"数据落在哪"）现在已经由 `crawlkit_selfcheck` 实时报告，
   * 那条路更准也更省事。需要排查加载问题时，把配置里的 `loadMarker` 设为 true。
   *
   * 为什么要延迟回读：插件可能比工具呈现提供方更早激活，激活瞬间读 `schemas()`
   * 会得到空数组 —— 实测出现过（同一份代码有一次读到、一次读不到），
   * 而 `visibleToModel: []` 看起来像"工具没生效"，会把排查引向完全错误的方向。
   * 所以这里等到工具集合真正变化、或超时后，再据实写一次。
   */
  const writeLoad = (extra) => {
    if (cfg.skipLoadMarker) return; // 包自检：完全无副作用
    try {
      mkdirSync(cfg.dataRoot, { recursive: true });
      writeFileSync(
        path.join(cfg.dataRoot, "load.json"),
        JSON.stringify(
          {
            build: BUILD,
            loadedAt: new Date().toISOString(),
            baseDir: baseDir(),
            dataRoot: cfg.dataRoot,
            registered: tools.map((t) => t.name),
            ...extra,
          },
          null,
          2,
        ),
        "utf8",
      );
    } catch {
      // 写不进去不致命 —— 自检工具会报告出来
    }
  };

  const readVisible = () => {
    try {
      return (ctx.tools?.schemas?.() ?? [])
        .map((s) => String(s.name))
        .filter((n) => n.startsWith("crawlkit_"));
    } catch (e) {
      return [`(回读失败) ${String(e?.message ?? e)}`];
    }
  };

  // 默认不写加载痕迹；只有显式打开 loadMarker 时才动用户的目录
  const tracing = cfg.loadMarker === true;
  if (tracing) writeLoad({ visibleToModel: null, note: "回读尚未完成，稍后会覆盖本文件" });

  let settled = false;
  const settle = (why) => {
    if (settled) return;
    settled = true;
    if (tracing) writeLoad({ visibleToModel: readVisible(), settledBy: why });
  };

  if (tracing) {
    try {
      ctx.on?.("tools/change", () => settle("tools/change"));
    } catch {
      // 该事件不可用就只依赖定时兜底
    }
    const timer = setTimeout(() => settle("timeout"), 5000);
    try {
      ctx.effect?.(() => () => clearTimeout(timer));
    } catch {
      // 没有 effect 就让它自然到期，不影响功能
    }
  }

  ctx.logger?.info?.(`crawlkit [${BUILD}] 已加载：注册 ${tools.length} 个工具`);
}
