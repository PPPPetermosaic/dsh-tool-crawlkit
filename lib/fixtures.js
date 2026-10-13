/**
 * 响应快照（fixture）：把"抓到过的那一次"存下来，之后离线反复调规则。
 *
 * 为什么必须有它：
 *   · 生成适配器要试错很多次（选择器/路径/字段）。每一次都真打目标站，
 *     既慢又无礼，还可能直接触发风控 —— 而风控一旦触发，
 *     后续的试错就全在噪声里进行。
 *   · 存下一次响应后，改规则 → 重放 → 看结果，全程不打网络，也不依赖目标站还活着。
 *
 * 约束：
 *   · 快照落在**数据目录**（会话工作区），不进仓库 —— 与"干净"一致。
 *   · 只按 URL 取，不猜站点语义；取不到就如实说"没有这个快照"。
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

/** 一个 URL 对应一个稳定的文件名；用哈希避免 URL 里的怪字符。 */
function keyOf(url) {
  return createHash("sha1").update(String(url)).digest("hex").slice(0, 16);
}

export class FixtureStore {
  constructor(dataRoot) {
    this.setBase(dataRoot);
  }

  setBase(dataRoot) {
    this.root = path.join(dataRoot, "fixtures");
    return this;
  }

  /** 把一次成功的响应存下来。返回 { ok, file, bytes }。 */
  save(url, res) {
    mkdirSync(this.root, { recursive: true });
    const file = path.join(this.root, `${keyOf(url)}.json`);
    const record = {
      url: String(url),
      finalUrl: res.url ?? String(url),
      status: res.status,
      contentType: res.contentType ?? "",
      encoding: res.encoding ?? "",
      savedAt: new Date().toISOString(),
      body: String(res.text ?? ""),
    };
    writeFileSync(file, JSON.stringify(record), "utf8");
    return { ok: true, file, bytes: Buffer.byteLength(record.body, "utf8") };
  }

  /** 读一份快照；没有就返回 null。 */
  read(url) {
    const file = path.join(this.root, `${keyOf(url)}.json`);
    if (!existsSync(file)) return null;
    try {
      const record = JSON.parse(readFileSync(file, "utf8"));
      return {
        ok: true,
        url: record.url,
        status: record.status ?? 200,
        contentType: record.contentType ?? "",
        encoding: record.encoding ?? "",
        text: String(record.body ?? ""),
        savedAt: record.savedAt ?? null,
        fromFixture: true,
        bytes: Buffer.byteLength(String(record.body ?? ""), "utf8"),
      };
    } catch (e) {
      return { ok: false, error: `快照读不了：${e?.message ?? e}` };
    }
  }

  /** 列出已有快照（用于告诉调用方"哪些地址可以离线重放"）。 */
  list() {
    if (!existsSync(this.root)) return [];
    const out = [];
    for (const name of readdirSync(this.root)) {
      if (!name.endsWith(".json")) continue;
      const file = path.join(this.root, name);
      try {
        const record = JSON.parse(readFileSync(file, "utf8"));
        out.push({ url: record.url, status: record.status, bytes: statSync(file).size, savedAt: record.savedAt });
      } catch {
        out.push({ url: `(读不出来) ${name}`, status: 0, bytes: statSync(file).size, savedAt: null });
      }
    }
    out.sort((a, b) => String(b.savedAt ?? "").localeCompare(String(a.savedAt ?? "")));
    return out;
  }

  /** 删掉某个地址的快照。 */
  remove(url) {
    const file = path.join(this.root, `${keyOf(url)}.json`);
    if (!existsSync(file)) return { ok: false, error: `没有这个地址的快照：${url}` };
    rmSync(file, { force: true });
    return { ok: true, url };
  }
}
