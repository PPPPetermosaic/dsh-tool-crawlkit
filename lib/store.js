/**
 * 落盘：适配器、数据集、响应快照。
 *
 * 三条不可动摇的约束：
 *   ① 全部写在【当前会话工作区】的数据目录下，与插件目录物理分离 ——
 *      这样仓库永远干净，用户也总能找到自己的数据。
 *   ② 适配器是纯数据；数据是 JSONL（一行一条），大结果不必整份读进内存。
 *   ③ 数据目录会随【当前会话】变化（见 setBase）—— 同一个进程里可能同时有
 *      多个工作区的会话，用进程级目录会把数据写到别人的工作区去。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { adapterMatchesHost, validateAdapter } from "./adapter.js";
import { FailureTracker } from "./failure.js";
import { FixtureStore } from "./fixtures.js";

/** 数据集目录名一律走白名单，避免路径穿越。 */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
  return dir;
}

export class Store {
  /**
   * @param {string} configured - 配置里的 dataRoot（可能是相对路径）
   * @param {(exec: unknown) => string|null} [workspaceOf] - 取当前会话工作区
   * @param {(configured: string, base?: string) => string} [resolve] - 解析成绝对路径
   */
  constructor(configured, workspaceOf, resolve) {
    this.configured = configured;
    this.workspaceOf = workspaceOf;
    this.resolve = resolve ?? ((value) => value);
    this.setBase(this.resolve(configured));
  }

  /**
   * 按一次工具调用的会话重新定位数据目录（就地改，返回自身）。
   *
   * 为什么必须能换：DSH 的进程工作目录**不是**会话工作区，插件激活时无法
   * 确定该写哪里，只有拿到当前会话之后才知道。实测踩过：桌面版把数据写进了
   * profile 目录（`~/.dsh/profiles/desktop/crawlkit-data`），而那个会话的工作区
   * 其实是别的地方 —— 用户在自己的工作区里根本找不到数据。
   */
  forExec(exec) {
    const workspace = this.workspaceOf?.(exec);
    return this.setBase(this.resolve(this.configured, workspace ?? undefined));
  }

  setBase(dataRoot) {
    this.root = dataRoot;
    this.adapterDir = path.join(dataRoot, "adapters");
    this.datasetDir = path.join(dataRoot, "datasets");
    // 快照跟着同一落点走；已建过的实例就地改基准，避免外面抓到旧对象
    if (this.fixtures) this.fixtures.setBase(dataRoot);
    return this;
  }

  /** 响应快照（离线重放用）。惰性创建，落点与会话一致。 */
  get fixtures() {
    if (!this._fixtures) this._fixtures = new FixtureStore(this.root);
    return this._fixtures;
  }

  /**
   * 连续失败计数器（进程级，按失败类别 + 目标站记忆）。
   *
   * 为什么挂在 store 上而不是每次调用新建：它是**跨调用**的信息 ——
   * 只有记住"这个站已经失败过几次"，才能在第 N 次说"别在这个方向上试了"。
   * 每次新建就等于永远只失败 1 次，阈值（网络类 2 次）永远不会达成。
   */
  get failures() {
    if (!this._failures) this._failures = new FailureTracker();
    return this._failures;
  }

  // ------------------------------------------------------------- 适配器

  /** 列出全部适配器（含解析失败的，如实报告而不是隐藏）。 */
  listAdapters() {
    if (!existsSync(this.adapterDir)) return { adapters: [], broken: [] };
    const adapters = [];
    const broken = [];
    for (const file of readdirSync(this.adapterDir)) {
      if (!file.endsWith(".json")) continue;
      const full = path.join(this.adapterDir, file);
      try {
        const parsed = JSON.parse(readFileSync(full, "utf8"));
        const result = validateAdapter(parsed);
        if (!result.ok) {
          broken.push({ file, problems: result.problems });
          continue;
        }
        // 文件名与里面的 id 必须一致。
        //
        // 为什么必须查：文件按【文件名】遍历，但身份取的是里面的 id。
        // 手改过文件名之后两者会分叉，表现是"列表里看得到、按任何名字都调不出来"
        // （实测：文件名 file-A.json、id 是 id-B 时，
        //   readAdapter('file-A') 与 readAdapter('id-B') 都是 null），
        // 而且两个文件写同一个 id 时列表里会出现两条一样的 —— 静默分叉，极难查。
        const bare = file.slice(0, -".json".length);
        if (result.adapter.id !== bare) {
          broken.push({
            file,
            problems: [
              `文件名与规则里的 id 不一致：文件名是 "${bare}"，里面的 id 是 "${result.adapter.id}"。` +
                `适配器是按 id 索引的，改文件名不会改 id —— 请把文件名改成 ${result.adapter.id}.json，或把规则里的 id 改成 ${bare}。`,
            ],
          });
          continue;
        }
        adapters.push(result.adapter);
      } catch (e) {
        broken.push({ file, problems: [`无法解析：${e?.message ?? e}`] });
      }
    }
    adapters.sort((a, b) => a.id.localeCompare(b.id));
    return { adapters, broken };
  }

  readAdapter(id) {
    return this.listAdapters().adapters.find((a) => a.id === id) ?? null;
  }

  /** 保存适配器。写入前必须通过校验 —— 不合法的规则不该进入数据目录。 */
  saveAdapter(input) {
    const result = validateAdapter(input);
    if (!result.ok) return { ok: false, problems: result.problems };

    ensureDir(this.adapterDir);
    const existing = this.readAdapter(result.adapter.id);
    const record = {
      ...result.adapter,
      version: existing ? existing.version + 1 : result.adapter.version,
      updatedAt: new Date().toISOString(),
    };
    writeFileSync(path.join(this.adapterDir, `${record.id}.json`), JSON.stringify(record, null, 2), "utf8");
    return { ok: true, adapter: record, replaced: Boolean(existing) };
  }

  deleteAdapter(id) {
    const file = path.join(this.adapterDir, `${id}.json`);
    if (!existsSync(file)) return { ok: false, problems: [`没有这个适配器：${id}`] };
    rmSync(file, { force: true });
    return { ok: true, id };
  }

  /** 按域名找可用适配器。 */
  findAdaptersForHost(host) {
    return this.listAdapters().adapters.filter((a) => adapterMatchesHost(a, host));
  }

  // ------------------------------------------------------------- 数据集

  datasetPath(name) {
    if (!NAME_RE.test(name)) throw new Error(`数据集名字不合法：${name}（只能用字母、数字、点、下划线、连字符）`);
    return path.join(this.datasetDir, name);
  }

  /**
   * 保存一批数据。
   * mode: "replace" 覆盖，其它值一律追加 —— 追加是默认，因为抓取常常分批进行。
   */
  saveDataset(name, items, meta = {}) {
    const dir = this.datasetPath(name);
    ensureDir(dir);
    const file = path.join(dir, "items.jsonl");

    const lines = items.map((item) => JSON.stringify(item));
    if (meta.mode === "replace" || !existsSync(file)) {
      writeFileSync(file, lines.length ? `${lines.join("\n")}\n` : "", "utf8");
    } else {
      const prev = readFileSync(file, "utf8");
      const sep = prev && !prev.endsWith("\n") ? "\n" : "";
      writeFileSync(file, `${prev}${sep}${lines.length ? `${lines.join("\n")}\n` : ""}`, "utf8");
    }

    const info = this.datasetInfo(name);
    const metaFile = path.join(dir, "meta.json");
    const previous = existsSync(metaFile) ? JSON.parse(readFileSync(metaFile, "utf8")) : {};
    // nextCursor 只在明确传了才覆盖：否则一次"不关心续抓"的调用会把位置抹掉，
    // 之后用户说"继续抓"就变成了从头再来（数据会重复）。
    const cursorPatch = meta.nextCursor !== undefined ? { nextCursor: meta.nextCursor } : {};
    writeFileSync(
      metaFile,
      JSON.stringify(
        {
          ...previous,
          name,
          adapterId: meta.adapterId ?? previous.adapterId ?? null,
          source: meta.source ?? previous.source ?? null,
          updatedAt: new Date().toISOString(),
          count: info.count,
          ...cursorPatch,
        },
        null,
        2,
      ),
      "utf8",
    );
    return { ok: true, name, count: info.count, added: items.length };
  }

  /**
   * 这个数据集上次抓完留下的"下一次从哪开始"。
   *
   * 三种情况必须分清（混在一起就会做错事）：
   *   · 没有这个数据集 / 没记录过 → null（当作从没抓过，从适配器起点开始）
   *   · 记录过、但游标是 null → 已经翻到底，没有更多了（**不该从头再来**）
   *   · 记录过、游标有值 → 从这个位置继续
   * 所以返回 { known, cursor }，而不是单看 cursor 是否为 null。
   */
  readCursor(name) {
    const file = path.join(this.datasetPath(name), "meta.json");
    if (!existsSync(file)) return { known: false, cursor: null };
    try {
      const meta = JSON.parse(readFileSync(file, "utf8"));
      if (!("nextCursor" in meta)) return { known: false, cursor: null };
      return { known: true, cursor: meta.nextCursor };
    } catch {
      return { known: false, cursor: null };
    }
  }

  /** 记下"下一次从哪开始"；`null` 表示已翻到底。 */
  writeCursor(name, cursor) {
    const dir = this.datasetPath(name);
    ensureDir(dir);
    const metaFile = path.join(dir, "meta.json");
    let meta = {};
    try {
      meta = existsSync(metaFile) ? JSON.parse(readFileSync(metaFile, "utf8")) : {};
    } catch {
      meta = {};
    }
    writeFileSync(metaFile, JSON.stringify({ ...meta, name, nextCursor: cursor ?? null }, null, 2), "utf8");
  }

  datasetInfo(name) {
    const file = path.join(this.datasetPath(name), "items.jsonl");
    if (!existsSync(file)) return { name, count: 0, bytes: 0 };
    const text = readFileSync(file, "utf8");
    const count = text.split("\n").filter((l) => l.trim()).length;
    return { name, count, bytes: statSync(file).size };
  }

  listDatasets() {
    if (!existsSync(this.datasetDir)) return [];
    const out = [];
    for (const entry of readdirSync(this.datasetDir)) {
      const dir = path.join(this.datasetDir, entry);
      if (!statSync(dir).isDirectory()) continue;
      const info = this.datasetInfo(entry);
      const metaFile = path.join(dir, "meta.json");
      let meta = {};
      try {
        meta = existsSync(metaFile) ? JSON.parse(readFileSync(metaFile, "utf8")) : {};
      } catch {
        meta = {};
      }
      out.push({ ...info, adapterId: meta.adapterId ?? null, source: meta.source ?? null, updatedAt: meta.updatedAt ?? null });
    }
    out.sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
    return out;
  }

  /** 读数据集的一段（offset/limit），避免把大结果整份读进上下文。 */
  readDataset(name, { offset = 0, limit = 20 } = {}) {
    const file = path.join(this.datasetPath(name), "items.jsonl");
    if (!existsSync(file)) return { ok: false, problems: [`没有这个数据集：${name}`] };
    const lines = readFileSync(file, "utf8").split("\n").filter((l) => l.trim());
    const slice = lines.slice(Math.max(0, offset), Math.max(0, offset) + Math.max(1, limit));
    const items = [];
    for (const line of slice) {
      try {
        items.push(JSON.parse(line));
      } catch {
        items.push({ _parseError: true, raw: line.slice(0, 200) });
      }
    }
    return { ok: true, name, total: lines.length, offset, items };
  }

  /** 在数据集里做子串检索：多个词要同时命中（AND），字段值任意一处命中即可。 */
  searchDataset(name, query, { limit = 20 } = {}) {
    const file = path.join(this.datasetPath(name), "items.jsonl");
    if (!existsSync(file)) return { ok: false, problems: [`没有这个数据集：${name}`] };
    const terms = String(query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return { ok: false, problems: ["查询词为空"] };

    const lines = readFileSync(file, "utf8").split("\n").filter((l) => l.trim());
    const hits = [];
    let scanned = 0;

    for (const line of lines) {
      scanned += 1;
      let item;
      try {
        item = JSON.parse(line);
      } catch {
        continue;
      }
      const hay = Object.values(item).map((v) => String(v ?? "")).join(" ").toLowerCase();
      if (terms.every((t) => hay.includes(t))) {
        hits.push(item);
        if (hits.length >= limit) break;
      }
    }
    return { ok: true, name, query, scanned, hits, truncated: hits.length >= limit };
  }

  deleteDataset(name) {
    const dir = this.datasetPath(name);
    if (!existsSync(dir)) return { ok: false, problems: [`没有这个数据集：${name}`] };
    rmSync(dir, { recursive: true, force: true });
    return { ok: true, name };
  }

  /** 数据目录的整体概况，供自检与列表使用。 */
  overview() {
    const { adapters, broken } = this.listAdapters();
    const datasets = this.listDatasets();
    return {
      dataRoot: this.root,
      // 只挑轻量字段：overview 是给"有哪些东西"用的，不该把整套规则都带上。
      // 但 params 必须带上 —— 它是"调用方要填什么"，不带的话调用方无从知道，
      // 只能去翻规则文件猜（"换个词就得新建一个适配器"正是这么来的）。
      adapters: adapters.map((a) => ({
        id: a.id,
        match: a.match,
        version: a.version,
        note: a.note,
        params: a.fetch?.params ?? [],
      })),
      brokenAdapters: broken,
      datasets,
      totalItems: datasets.reduce((n, d) => n + d.count, 0),
    };
  }
}
