/**
 * 运行环境自检。
 *
 * 只报告"这台机器上能不能干活"，不猜任何站点信息。
 * 数据目录的读写权限必须【实测】—— 假设它可写是最常见的误判来源。
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export function selfCheck({ config, note, build, store, exec }) {
  const checks = [];
  const add = (ok, label, detail) => checks.push({ ok, label, detail });

  // 数据落在哪里，取决于"当前会话的工作区"能不能拿到 —— 拿不到就会退回进程
  // 工作目录，而桌面版的进程工作目录是 profile 目录。这一点必须显式报出来，
  // 否则用户只会发现"数据不在我的工作区里"却不知道为什么。
  // 注意：这一项不算"失败" —— 拿不到会话时工具照样能用，只是落点不理想，
  // 所以它只作为提示出现，不让整个自检变成"未通过"。
  const workspace = config.workspace ?? null;
  add(
    true,
    "数据落点",
    workspace
      ? `会话工作区 ${workspace}　→　数据目录 ${store ? store.root : "(未初始化)"}`
      : `拿不到会话工作区，已退回进程工作目录 ${config.baseDir ?? process.cwd()}` +
          `　→　数据目录 ${store ? store.root : "(未初始化)"}（可能不在你的工作区里，可用配置的 dataRoot 指定绝对路径）`,
  );

  add(true, "运行时", `${process.version} · ${process.platform}/${process.arch}`);
  add(true, "构建", String(build ?? "未知"));
  add(typeof fetch === "function", "HTTP 抓取", typeof fetch === "function" ? "内置 fetch 可用" : "内置 fetch 不可用 —— 无法抓取");
  add(
    true,
    "文本解码",
    "内置 TextDecoder：支持 UTF-8 与 gb18030（覆盖 GBK/GB2312）；Big5、Shift_JIS、韩文编码不支持 —— 遇到会如实报告，不会硬解出乱码",
  );

  // 数据目录可写性：真的写一次再删掉
  let writable = false;
  let detail = config.dataRoot;
  try {
    mkdirSync(config.dataRoot, { recursive: true });
    const probeFile = path.join(config.dataRoot, ".crawlkit-write-probe");
    writeFileSync(probeFile, "ok", "utf8");
    writable = existsSync(probeFile);
    rmSync(probeFile, { force: true });
  } catch (e) {
    detail = `${config.dataRoot} —— ${e?.code ?? e?.name}: ${e?.message}`;
  }
  add(writable, "数据目录可写", detail);

  const overview = store ? store.overview() : null;
  const failed = checks.filter((c) => !c.ok);

  return {
    ok: failed.length === 0,
    verdict: failed.length === 0 ? "全部通过" : `${failed.length} 项未通过`,
    summary: `数据目录：${config.dataRoot}｜正文上限：${config.textLimit} 字｜单次超时：${config.timeoutMs} ms`,
    checks,
    note: note ?? null,
    library: overview
      ? {
          adapters: overview.adapters.length,
          brokenAdapters: overview.brokenAdapters.length,
          datasets: overview.datasets.length,
          totalItems: overview.totalItems,
        }
      : null,
    error: failed.length ? failed.map((c) => `${c.label}：${c.detail}`).join("\n") : "",
    fix: failed.length ? "看上面未通过的项。若是数据目录不可写，用配置里的 dataRoot 换一个可写目录。" : "",
  };
}
