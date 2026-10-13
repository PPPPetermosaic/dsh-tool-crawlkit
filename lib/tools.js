/**
 * 工具定义。
 *
 * 分工必须分清（踩过的坑）：
 *     execute → 返回【结构化对象】，对齐 output.schema
 *     render  → 把它变成【可读文本】，这才是模型看到的
 * 把渲染提前到 execute 里，DSH 会报 `returned invalid output: "value" must be an object`。
 *
 * 工具描述本身就是提示词的一部分 —— 描述写得好不好，直接决定 agent 会不会正确使用它。
 */

import { readFileSync } from "node:fs";
import { dedupeKey, extractItems, pageUrl, runAdapter } from "./engine.js";
import { parseHtml } from "./html.js";
import { asJson, CookieJar, detectApiError, detectClientRendered, fetchPage, parseNetscapeCookies } from "./http.js";
import { discoverSources, probeJson, summarizePage } from "./page.js";
import { bullet, pageLines, renderFailure } from "./render.js";
import { presentItem, presentNote, scrub } from "./sanitize.js";
import { selfCheck } from "./selfcheck.js";
import { escalate, fail, FailureClass } from "./failure.js";
import { fillUrl, urlPlaceholders } from "./urlparams.js";

const COOKIE_DESC =
  "登录 cookie，格式 name=value; name2=value2（从浏览器 F12 → Application → Cookies 整条复制）。" +
  "不提供则匿名抓取：能访问的页面变少，单页可见的数据也可能大幅减少。";

const COOKIE_FILE_DESC = "从文件读 cookie，支持 Netscape cookies.txt 格式。cookie 很长时用这个。";

/** 五个工具共用的网络参数。 */
const NET_PARAMS = {
  cookie: { type: "string", description: COOKIE_DESC },
  cookieFile: { type: "string", description: COOKIE_FILE_DESC },
};

/** 统一输出声明：execute 给对象，render 给模型可读文本。 */
export function textOutput(render) {
  return { schema: { type: "object", additionalProperties: true }, render };
}

/**
 * 一次抓取最多往上下文里回显多少条条目。
 *
 * 为什么要上限：条目会随每一轮请求重复进入上下文。抓 1 万条就回显 1 万行，
 * 上下文直接爆掉 —— 而完整数据已经落进数据集，模型不需要逐条读。
 * 想细看用 `crawlkit_dataset` 的 view / search 分段取。
 *
 * 注意：这只影响**回显**，落盘的数据集始终是全部条目。
 */
const RUN_PREVIEW = 20;

/** 构造一个统一的 cookie 罐：优先用文件，其次用内联串。 */
function buildJar({ cookie, cookieFile }, defaults, hostHint) {
  const jar = new CookieJar();
  const inline = cookie || defaults.cookie || "";
  if (inline) jar.setForHost(hostHint, inline);

  if (cookieFile) {
    try {
      const text = readFileSync(String(cookieFile), "utf8");
      const entries = parseNetscapeCookies(text);
      if (entries.length) {
        for (const e of entries) jar.setForHost(e.domain || hostHint, [{ name: e.name, value: e.value, path: e.path }]);
      } else {
        jar.setForHost(hostHint, text);
      }
    } catch (e) {
      return { jar: null, problem: `cookie 文件读不了：${e?.code ?? e?.message}` };
    }
  }
  return { jar, problem: null };
}

/**
 * 取一个地址的内容：优先用响应快照（replay），否则走网络。
 *
 * 为什么要快照：生成适配器要试错很多次。每次都真打目标站既慢又无礼，
 * 还可能把站点惹到限流 —— 一旦限流，后续试错就全在噪声里进行。
 * 存下那一次响应后，"改规则 → 重放 → 看结果"可以完全离线。
 *
 * 约定：`replay` 为真但没有快照时，明确说出来并照常走网络 ——
 * 静默联网会让人以为自己在离线测试。
 */
async function fetchContent(url, { store, replay = false, snapshot = false, ...options }) {
  if (replay) {
    const hit = store.fixtures.read(url);
    if (hit?.ok) return hit;
    const live = await fetchPage(url, options);
    if (live.ok) live.replayMissed = true;
    return live;
  }

  const res = await fetchPage(url, options);
  if (snapshot && res.ok) {
    const saved = store.fixtures.save(url, res);
    if (saved.ok) res.snapshotSaved = saved;
  }
  return res;
}

// ------------------------------------------------------------ 各工具

export function buildTools({ store, cfg, build }) {
  const { textLimit, timeoutMs, delayMs } = cfg;

  /**
   * 每次执行前按当前会话重新定位数据目录。
   *
   * 为什么必须在调用时做：数据要落在**会话工作区**，而插件激活时还没有会话
   * —— 桌面版的进程工作目录是 profile 目录，拿它当工作区会把数据写错地方。
   */
  const at = (exec) => store.forExec(exec);

  return [
    // -------------------------------------------------------- selfcheck
    {
      name: "crawlkit_selfcheck",
      description:
        "自检 crawlkit 的运行环境：运行时版本、内置抓取能力、数据目录是否可写、已存了多少适配器与数据。" +
        "插件刚安装、或抓取反复失败需要排查时先跑它。",
      parameters: {
        note: { type: "string", description: "可选备注，会写进自检结果，便于区分多次自检。" },
      },
      output: textOutput((_args, v) => {
        const lines = [`crawlkit 自检：${v.verdict}`];
        if (v.summary) lines.push("", v.summary);
        lines.push("", "逐项：");
        for (const c of v.checks ?? []) lines.push(`  ${c.ok ? "OK  " : "FAIL"} ${c.label} —— ${c.detail}`);
        if (v.library) {
          lines.push(
            "",
            `已有：${v.library.adapters} 个适配器、${v.library.datasets} 个数据集、共 ${v.library.totalItems} 条数据` +
              (v.library.brokenAdapters ? `（另有 ${v.library.brokenAdapters} 个适配器文件读不出来）` : ""),
          );
        }
        if (v.error) lines.push("", "—— 出了什么问题 ——", String(v.error), "", "—— 怎么办 ——", String(v.fix ?? ""));
        return [{ type: "text", text: lines.join("\n") }];
      }),
      async execute(args, exec) {
        at(exec);
        return selfCheck({ config: { ...cfg, workspace: store.workspaceOf(exec) }, note: args?.note, build, store, exec });
      },
    },

    // ----------------------------------------------------------- read
    {
      name: "crawlkit_read",
      description:
        "读一个网页，返回结构摘要：标题、各级标题、重复出现的列表结构（含可用选择器与条数）、表格、" +
        "链接样本、正文节选。用于判断这一页有什么、以及为适配器定选择器。" +
        "返回摘要而不是原始 HTML，避免几万字的页面占用上下文。\n" +
        "加 snapshot=true 会把这次的原始响应存成快照 —— 之后用 crawlkit_adapter test 的 replay=true " +
        "离线反复调规则，不必再打这个站点。",
      parameters: {
        url: { type: "string", required: true, description: "要读的页面地址（http/https）" },
        limit: { type: "number", description: `正文最多返回多少字符（默认 ${textLimit}）` },
        snapshot: {
          type: "boolean",
          description: "把这个地址的原始响应存成快照，供之后离线调规则。抓一次就够，别重复存。",
        },
        ...NET_PARAMS,
      },
      output: textOutput((_args, v) => {
        const lines = [];
        if (!v.ok) {
          renderFailure(lines, v);
          return [{ type: "text", text: lines.join("\n") }];
        }
        lines.push(`页面：${v.url}`, `标题：${v.title || "(无)"}`);
        if (v.metaDescription) lines.push(`描述：${v.metaDescription}`);
        if (v.note) lines.push("", `⚠ ${v.note}`);
        bullet(lines, "标题结构", (v.headings ?? []).map((h) => `h${h.level} × ${h.count}：${h.samples.join(" / ")}`));
        bullet(
          lines,
          "疑似列表结构（第一列可直接用作 extract.items）",
          (v.containers ?? []).map((c) => {
            const head = `${c.selector} —— ${c.itemCount} 条`;
            const fields = c.itemFields?.length
              ? `\n      子结构：${c.itemFields.map((f) => `${f.selector} = ${scrub(f.sample).text}`).join(" ｜ ")}`
              : "";
            return `${head}${fields}\n      示例：${scrub(c.sampleText).text}`;
          }),
        );
        bullet(lines, "表格", (v.tables ?? []).map((t) => `${t.rows} 行，表头：${t.header.join(" | ") || "(无)"}`));
        bullet(lines, "链接样本", (v.links ?? []).map((l) => `${l.text} → ${l.href}`));
        lines.push("", `—— 正文（${v.textLength} 字，已截断）——`, scrub(v.text || "(无可读正文)").text);
        if (v.snapshotSaved) lines.push("", `已存快照（${v.snapshotSaved.bytes} 字节）：之后可用 replay=true 离线调规则。`);
        if (v.hint) lines.push("", `提示：${v.hint}`);
        return [{ type: "text", text: lines.join("\n") }];
      }),
      async execute(args, exec) {
        at(exec);
        const url = String(args.url ?? "");
        const { jar, problem } = buildJar(args, cfg, safeHost(url));
        if (problem) {
          return fail(FailureClass.INPUT, safeHost(url), problem, { fix: "检查 cookieFile 路径是否存在、是否可读。" });
        }
        const res = await fetchContent(url, {
          store,
          snapshot: args.snapshot === true,
          timeoutMs,
          jar,
          signal: exec?.signal,
        });
        if (!res.ok) return res;

        const { root } = parseHtml(res.text);
        const summary = summarizePage(root, { url: res.url, limit: args.limit ?? textLimit });
        return {
          ok: true,
          ...summary,
          status: res.status,
          encoding: res.encoding,
          note: res.note ?? "",
          snapshotSaved: res.snapshotSaved ?? null,
        };
      },
    },

    // ---------------------------------------------------------- probe
    {
      name: "crawlkit_probe",
      description:
        "探测一个地址的数据在哪里。对网页：报内嵌 JSON（如 __NEXT_DATA__）、JSON-LD、脚本里的接口地址、" +
        "分页线索；对接口返回的 JSON：报顶层字段、有没有错误码、以及哪些路径是数据列表（含条数与字段名）。" +
        "生成适配器之前应该先跑它 —— 用它决定走 HTML 还是走接口。\n" +
        "对接口地址加 snapshot=true 可把这次响应存成快照，之后离线调规则。",
      parameters: {
        url: { type: "string", required: true, description: "要探测的地址（网页或接口都行）" },
        snapshot: {
          type: "boolean",
          description: "把这个地址的原始响应存成快照，供之后离线调规则。抓一次就够，别重复存。",
        },
        ...NET_PARAMS,
      },
      output: textOutput((_args, v) => {
        const lines = [];
        if (!v.ok) {
          renderFailure(lines, v);
          return [{ type: "text", text: lines.join("\n") }];
        }
        lines.push(`探测：${v.url}`, "", `结论：${v.verdict}`);
        if (v.snapshotSaved) lines.push("", `已存快照（${v.snapshotSaved.bytes} 字节）：之后可用 replay=true 离线调规则。`);
        if (v.problem) lines.push("", `⚠ ${v.problem}`);
        if (v.json) {
          lines.push("", "—— 这是一个 JSON 接口 ——");
          lines.push(`顶层字段：${v.json.topLevelKeys.join(", ") || "(无)"}`);
          if (v.json.code !== null && v.json.code !== undefined) lines.push(`接口 code：${v.json.code}`);
          bullet(
            lines,
            "可作为 extract.items 的路径（按条数排序）",
            (v.json.candidates ?? []).map(
              (c) => `${c.path} —— ${c.count} 条，元素是 ${c.itemKind}` + (c.fields.length ? `\n      字段：${c.fields.join(", ")}` : ""),
            ),
          );
          if (!v.json.candidates?.length) {
            lines.push("", "没有找到长度 ≥2 的数组 —— 这个接口可能不是列表型，或数据在更深处。");
          }
          lines.push("", "写适配器时：extract.type = \"json\"，extract.items 用上面的路径，字段用它的字段名（如 owner.name）。");
        }

        bullet(lines, "内嵌数据", (v.embedded ?? []).map((e) => `${e.name} —— ${e.bytes} 字节，${e.kind}${e.length ? ` × ${e.length}` : ""}，字段：${e.sampleKeys.join(", ") || "(无)"}`));
        bullet(lines, "结构化数据 (JSON-LD)", (v.jsonLd ?? []).map((j) => `${j.type} —— ${j.keys.join(", ")}`));
        bullet(lines, "疑似接口", v.endpoints ?? []);
        bullet(lines, "分页线索", (v.pagination ?? []).map((p) => `${p.text} → ${p.href}`));
        if (v.relNext) lines.push("", `rel=next：${v.relNext}`);
        return [{ type: "text", text: lines.join("\n") }];
      }),
      async execute(args, exec) {
        at(exec);
        const url = String(args.url ?? "");
        const { jar, problem } = buildJar(args, cfg, safeHost(url));
        if (problem) return fail(FailureClass.INPUT, safeHost(url), problem, { fix: "检查 cookieFile 是否可读。" });

        const res = await fetchContent(url, {
          store,
          snapshot: args.snapshot === true,
          timeoutMs,
          jar,
          signal: exec?.signal,
        });
        if (!res.ok) return res;

        // 接口地址：走 JSON 探测
        const json = asJson(res);
        if (json !== null) {
          const probed = probeJson(json);
          const apiError = detectApiError(json);
          return {
            ok: true,
            url: res.url,
            json: probed,
            snapshotSaved: res.snapshotSaved ?? null,
            verdict: apiError
              ? `这是 JSON 接口，但它返回了错误码 ${apiError.code} —— 请求被拒（通常是签名或风控），不是数据。`
              : probed.candidates.length
                ? `这是 JSON 接口，数据列表在 ${probed.candidates[0].path}（${probed.candidates[0].count} 条）。`
                : "这是 JSON 接口，但没有找到像数据列表的数组。",
            problem: apiError ? `接口错误码 ${apiError.code}${apiError.message ? `：${apiError.message}` : ""}` : "",
            ...(apiError ? { apiCode: apiError.code } : {}),
          };
        }

        // 网页：先判是不是空壳，否则会让 agent 白改选择器
        const { root } = parseHtml(res.text);
        const shell = detectClientRendered(res.text);
        const found = discoverSources(root, res.text);
        return {
          ok: true,
          url: res.url,
          encoding: res.encoding,
          note: res.note ?? "",
          snapshotSaved: res.snapshotSaved ?? null,
          verdict: shell
            ? `这一页的 HTML 里没有数据（可见正文 ${shell.visibleChars} 字，靠 JavaScript 渲染）。${found.endpoints.length ? `脚本里出现了 ${found.endpoints.length} 个疑似接口地址，改抓接口。` : "没有找到接口线索。"}`
            : found.verdict,
          problem: shell ? shell.note : "",
          ...found,
        };
      },
    },

    // ------------------------------------------------------------ run
    {
      name: "crawlkit_run",
      description:
        "按已保存的适配器抓取数据，返回结构化条目。同一个站点第二次抓取时用它 —— " +
        "不必重新生成规则。没有 url 时用适配器自带的地址。\n" +
        "填了 saveAs 时会记住抓到哪，下次同样填 saveAs、不填 url 就自动接着抓，不会重复。",
      parameters: {
        adapter: { type: "string", required: true, description: "适配器 id（先用 crawlkit_adapter 列出）" },
        params: {
          type: "object",
          additionalProperties: true,
          description:
            "填适配器地址里需要的查询条件（搜索词之类）。适配器要哪些，用 crawlkit_adapter 的 list 或 get 都会报出来。" +
            '例如 { "keyword": "示例关键词" }。这些不是分页参数 —— 分页由适配器自己管。',
        },
        url: { type: "string", description: "从这个地址开始抓（默认用适配器里配置的地址；给了它就按它开始，不自动续抓）" },
        limit: { type: "number", description: "最多返回多少条（默认 50）" },
        maxPages: { type: "number", description: "最多翻多少页（默认取适配器里的设置）" },
        saveAs: {
          type: "string",
          description:
            "把结果存成数据集（同名会追加，不会覆盖）。填了它就会记住续抓位置，便于分多批抓大量数据。",
        },
        replay: {
          type: "boolean",
          description: "只从已存的响应快照读，不打网络 —— 用于离线复算同一份数据。没有快照的页会明确提示并联网。",
        },
        ...NET_PARAMS,
      },
      output: textOutput((_args, v) => {
        const lines = [];
        if (!v.ok) {
          renderFailure(lines, v);
          return [{ type: "text", text: lines.join("\n") }];
        }
        lines.push(`适配器 ${v.adapterId}：取到 ${v.count} 条（匹配 ${v.totalMatched} 条，翻了 ${v.pagesFetched} 页）`);
        if (v.resumeNote) lines.push(`接着上次继续：${v.resumeNote}`);
        if (v.duplicatesDropped) lines.push(`去重丢弃：${v.duplicatesDropped} 条`);
        if (v.warning) lines.push("", `⚠ ${v.warning}`);
        if (v.saved) {
          lines.push(
            "",
            `已存入数据集「${v.saved.name}」，现有 ${v.saved.count} 条` +
              (v.netGain !== undefined ? `（本次新增 ${v.netGain} 条）。` : "。"),
          );
        }
        bullet(lines, "抓取过程", pageLines(v.pages));
        lines.push("", `—— 前 ${(v.items ?? []).length} 条（完整数据在数据集里）——`);
        // 展示层才裁剪与清注入：落盘的数据必须保持原文
        let scrubbed = 0;
        let clipped = 0;
        for (const item of v.items ?? []) {
          const shown = presentItem(item, 240);
          scrubbed += shown.scrubbed;
          clipped += shown.clipped;
          lines.push(shown.text);
        }
        if (v.omitted) lines.push(`…… 另有 ${v.omitted} 条未在这里展开；用 crawlkit_dataset 检索或分页查看。`);
        const note = presentNote({ scrubbed, clipped });
        if (note) lines.push("", note);
        return [{ type: "text", text: lines.join("\n") }];
      }),
      async execute(args, exec) {
        at(exec);
        const adapter = store.readAdapter(String(args.adapter ?? ""));
        if (!adapter) {
          return fail(FailureClass.INPUT, String(args.adapter ?? ""), `没有这个适配器：${args.adapter}`, {
            fix: "先用 crawlkit_adapter action=list 看看已有哪些适配器；没有就需要为这个站生成一个。",
          });
        }
        const startUrl = args.url ? String(args.url) : adapter.fetch.url;
        const { jar, problem } = buildJar(args, cfg, safeHost(startUrl));
        if (problem) return fail(FailureClass.INPUT, safeHost(startUrl), problem, { fix: "检查 cookieFile 是否可读。" });

        // ---- 续抓：同一个数据集记得上次抓到哪，这一次接着来
        const saveName = args.saveAs ? String(args.saveAs) : "";
        let resumeFrom = null;
        let resumeNote = "";
        if (saveName && args.url === undefined) {
          // 只在调用方没指定地址时才自动续抓 —— 指定了地址就是明确要从那里开始，不该被覆盖
          const state = store.readCursor(saveName);
          if (state.known && state.cursor === null) {
            // 上次已经翻到底。这里必须停下并说清，否则"继续抓"会静默地从头再来一遍
            return {
              ok: false,
              failureClass: FailureClass.INPUT,
              error: `数据集「${saveName}」上次已经抓到列表末尾，没有更多了。`,
              fix:
                "同一次抓取不要反复执行 —— 这个站点已经没有下一页。\n" +
                "如果站点后来更新了内容，可以传 url 指定从第一页重新抓（会与已有数据去重）。",
            };
          }
          if (state.known) {
            resumeFrom = state.cursor;
            resumeNote = `从上次的位置接着抓（${String(state.cursor)}）`;
          }
        }

        const result = await runAdapter(adapter, {
          limit: args.limit ?? 50,
          maxPages: args.maxPages,
          timeoutMs,
          delayMs,
          jar,
          startUrl,
          signal: exec?.signal,
          replay: args.replay === true,
          fixtures: store.fixtures,
          resumeFrom,
          params: args.params && typeof args.params === "object" ? args.params : {},
        });
        // 失败升级：同一类失败在同一个站上连续出现到阈值后，就不再给"换个参数再试"的
        // 普通建议，而是明确说"别再在这个方向试了"。
        //
        // 为什么必须跨调用记住：单次失败给不出"这个方向走不通"的结论 ——
        // 一次超时可能只是偶发。只有累计到阈值才有资格下这个判断。
        // （这套机制此前定义了却从未接线，于是 stopRetrying 永远不会出现，实测发现。）
        const failureTarget = safeHost(startUrl);
        if (!result.ok) {
          const cls = result.failureClass ?? FailureClass.INTERNAL;
          const count = store.failures.record(cls, failureTarget);
          if (store.failures.shouldEscalate(cls, count)) {
            return { ...escalate(cls, failureTarget), detail: result.detail ?? result.error, pages: result.pages };
          }
          return result;
        }
        // 成功一次就清零：否则偶发失败的历史会一直累着，后面某次无关的失败被误判成"反复失败"
        store.failures.reset();
        if (resumeNote) result.resumeNote = resumeNote;

        if (saveName) {
          // 追加前先跟数据集里已有的比对。
          //
          // 为什么必须在这里比：引擎的去重只管本次这批的**内部**重复，
          // 管不了"和上次抓到的重复"。少了这一步，一个每次都给同一页的站点
          // 会把同样的数据反复堆进去 —— 用户看到条数在涨，实际全是副本
          // （实测踩过：50 条的数据集再抓一次变 60 条，多出来的是第一页的副本）。
          const uniqueBy = adapter.extract.uniqueBy ?? [];
          const before = store.datasetInfo(saveName).count;
          const seenKeys = new Set();
          if (uniqueBy.length) {
            // readDataset 在数据集不存在时返回的是失败对象（没有 items），所以要判一下
            const existing = store.readDataset(saveName, { limit: Number.MAX_SAFE_INTEGER });
            for (const row of existing.items ?? []) {
              const k = dedupeKey(row, uniqueBy);
              if (k !== null) seenKeys.add(k);
            }
          }
          const fresh = [];
          let alreadyHad = 0;
          for (const item of result.items) {
            if (!uniqueBy.length) {
              fresh.push(item);
              continue;
            }
            const k = dedupeKey(item, uniqueBy);
            if (k !== null && seenKeys.has(k)) {
              alreadyHad += 1;
              continue;
            }
            if (k !== null) seenKeys.add(k);
            fresh.push(item);
          }

          const saved = store.saveDataset(saveName, fresh, {
            adapterId: adapter.id,
            source: startUrl,
            nextCursor: result.nextCursor,
          });
          result.saved = saved;
          result.alreadyHad = alreadyHad;
          result.netGain = saved.count - before;

          // 一条新数据都没进来：这一批等于白跑，不能报成功。
          //
          // 报成功会让调用方以为"又抓到了 10 条"，而实际上库里的数字一点没变。
          // 必须说清是"内容都是已有的"，并指出最可能的原因（分页没生效/已经到底）。
          if (result.netGain === 0 && (result.count > 0 || alreadyHad > 0)) {
            return {
              ok: false,
              failureClass: FailureClass.INPUT,
              error:
                alreadyHad > 0
                  ? `这一批取到的 ${alreadyHad} 条，数据集「${saveName}」里都已经有了（现有仍是 ${saved.count} 条）。`
                  : `这一批没有取到新数据，数据集「${saveName}」现有仍是 ${saved.count} 条。`,
              fix:
                "先确认这个站点是不是还有下一页：\n" +
                "· 如果适配器声明了分页，检查分页参数是否真的生效（每次可能都取到同一页）；\n" +
                "· 如果没有分页规则，这个地址就只有这一页，重复执行不会带来新数据；\n" +
                "· 若确实要重新抓，传 url 指定一个不同的地址，或换一个数据来源。",
              detail: `本次取到 ${result.count} 条，其中 ${alreadyHad} 条与已有数据重复；数据集共 ${saved.count} 条。`,
              pages: result.pages,
            };
          }
        }

        // 只把少量条目交给渲染层：条目会随每轮请求重复进上下文，抓上万条会把它塞爆。
        // 注意顺序 —— 上面入库用的是【未裁剪的 result.items】，所以落盘内容不受影响。
        if (result.items.length > RUN_PREVIEW) {
          result.omitted = result.items.length - RUN_PREVIEW;
          result.items = result.items.slice(0, RUN_PREVIEW);
        }
        return result;
      },
    },

    // -------------------------------------------------------- adapter
    {
      name: "crawlkit_adapter",
      description:
        "管理站点适配器（纯数据的抓取规则，不是代码）。\n" +
        "action=list 列出全部；template 取一份可直接改的骨架（写新规则前先看它）；" +
        "get 看详情；save 保存（会先校验，不通过不写入）；" +
        "test 用当前地址试跑、核对是否真的提取到内容；delete 删除。\n" +
        "规则外形：{ id, match:[域名], fetch:{ tier, url, headers?, params?, paginate? }, extract:{ type, items, fields, uniqueBy? } }。\n" +
        "fetch.url 里可以写 {名字} 占位符表示【调用方要填的查询条件】（如 {keyword}），" +
        "这样同一套规则能服务任意关键词，不必每换一个词就新建一个适配器；" +
        "填的值默认做 URL 编码，要原样拼接就写 {!名字}。分页的 {page}/{offset}/{cursor} 由分页设置自己填，不用传。\n" +
        "extract.type 省略或 \"html\" 时 items 是 CSS 选择器、字段用 { sel, take?, name?, abs?, parse? }；" +
        "extract.type 为 \"json\" 时 items 是路径（如 data.list）、字段是路径（如 owner.name）或 { path, deep?, parse? }。",
      parameters: {
        action: {
          type: "string",
          required: true,
          enum: ["list", "template", "get", "save", "test", "delete"],
          description: "要做的操作",
        },
        id: { type: "string", description: "适配器 id（get / test / delete 需要）" },
        adapter: { type: "json", description: "适配器内容（save 需要）。写之前先取 action=template 看骨架" },
        params: {
          type: "object",
          additionalProperties: true,
          description: 'test 时需要填的查询条件，例如 { "keyword": "示例关键词" }。适配器要哪些用 action=get 能看到',
        },
        url: { type: "string", description: "试跑用的地址（test 可选，默认用适配器里的地址）" },
        maxItems: { type: "number", description: "试跑最多取几条（默认 5）" },
        replay: {
          type: "boolean",
          description:
            "test 时用已存的响应快照离线重放，不打网络 —— 反复调规则时用它。" +
            "没有快照时会明确提示并照常联网。先用 crawlkit_read 的 snapshot=true 存一次。",
        },
        ...NET_PARAMS,
      },
      output: textOutput((_args, v) => {
        const lines = [];
        if (!v.ok) {
          renderFailure(lines, v);
          if (v.problems?.length) {
            lines.push("", "—— 规则里的问题 ——");
            for (const p of v.problems) lines.push(`  · ${p}`);
          }
          return [{ type: "text", text: lines.join("\n") }];
        }
        if (v.action === "list") {
          if (!v.adapters.length) {
            lines.push("还没有任何适配器。", "", "为某个站点生成一个：先用 crawlkit_probe 看清数据在哪，再用 crawlkit_adapter action=save 保存规则。");
          } else {
            lines.push(`已有 ${v.adapters.length} 个适配器：`);
            for (const a of v.adapters) {
              // 需要调用方填的查询条件要显式列出来 —— 不列的话，调用方不知道要传什么，
              // 只能去读适配器文件猜（而"换个词就得新建一个适配器"正是这么来的）。
              const needs = a.params?.length ? `｜需要提供：${a.params.map((p) => `"${p}"`).join("、")}` : "";
              lines.push(`  · ${a.id} —— 适用：${a.match.join(", ")}${needs}${a.note ? `｜${a.note}` : ""}`);
            }
          }
          // 字段名与 store.overview() 保持一致：以前这里读的是 v.broken（不存在），
          // 于是"有规则文件读不出来"这个提示从来没显示过 —— 坏了也看不出来。
          if (v.brokenAdapters?.length) {
            lines.push("", "⚠ 有规则文件读不出来（已跳过）：");
            for (const b of v.brokenAdapters) lines.push(`  · ${b.file}：${b.problems.join("；")}`);
          }
          if (v.datasets?.length) lines.push("", `数据集 ${v.datasets.length} 个，共 ${v.totalItems} 条。`);
          lines.push("", `数据目录：${v.dataRoot}`);
        } else if (v.action === "template") {
          lines.push("适配器骨架（改掉里面的选择器/路径即可保存）：");
          for (const [label, tpl] of [
            ["① 数据在 HTML 里", v.html],
            ["② 数据在 JSON 接口里", v.json],
          ]) {
            lines.push("", `—— ${label} ——`, JSON.stringify(tpl, null, 2));
          }
          lines.push(
            "",
            "填写要点：",
            "  · id 只能用小写字母、数字、点、下划线、连字符；match 写域名（api 接口要写接口的域名）；",
            "  · fetch.url 里用 {page} 表示页码占位符，并在 fetch.paginate 里声明 param（如 pn/page）；",
            "  · html 通道的字段选择器要【相对“每一条”】写（写 h3，不要写 body > div > h3）；",
            "  · json 通道的字段用路径（owner.name / stat.view），时间戳加 parse:\"date\"，相对地址加 abs:true；",
            "  · uniqueBy 写去重键的字段名，翻页时用它避免重复；",
            "  · 保存后一定用 action=test 试跑，确认命中条数与字段非空。",
          );
        } else if (v.action === "get") {
          lines.push(`适配器 ${v.adapter.id}`);
          lines.push(JSON.stringify(v.adapter, null, 2));
        } else if (v.action === "save") {
          lines.push(`${v.replaced ? "已更新" : "已保存"}适配器 ${v.adapter.id}（版本 ${v.adapter.version}）`);
          lines.push("", "确认它真的能取到数据：crawlkit_adapter action=test id=" + v.adapter.id);
        } else if (v.action === "delete") {
          lines.push(`已删除适配器 ${v.id}`);
        } else if (v.action === "test") {
          lines.push(`试跑适配器 ${v.adapterId}：匹配到 ${v.matched} 条元素，取到 ${v.sample.length} 条样本`);
          if (v.hintText) lines.push("", v.hintText);
          if (!v.matched) {
            lines.push("", "⚠ 一条都没匹配到 —— 规则与页面结构不匹配。先看 crawlkit_read 的列表结构候选。");
          }
          bullet(lines, "抓取过程", pageLines(v.pages));
          if (v.emptyFields?.length) {
            lines.push("", `⚠ 这些字段在所有样本里都是空的，选择器很可能不对：${v.emptyFields.join(", ")}`);
          }
          lines.push("", "—— 样本 ——");
          let scrubbedN = 0;
          let clippedN = 0;
          for (const item of v.sample) {
            const shown = presentItem(item, 240);
            scrubbedN += shown.scrubbed;
            clippedN += shown.clipped;
            lines.push(shown.text);
          }
          const note = presentNote({ scrubbed: scrubbedN, clipped: clippedN });
          if (note) lines.push("", note);
        }
        return [{ type: "text", text: lines.join("\n") }];
      }),
      async execute(args, exec) {
        at(exec);
        const action = String(args.action ?? "");

        if (action === "list") return { ok: true, action, ...store.overview() };

        if (action === "template") return { ok: true, action, ...adapterTemplates() };

        if (action === "get") {
          const adapter = store.readAdapter(String(args.id ?? ""));
          if (!adapter) return fail(FailureClass.INPUT, String(args.id ?? ""), `没有这个适配器：${args.id ?? "(未给 id)"}`, { fix: "先用 action=list 看看有哪些。" });
          return { ok: true, action, adapter };
        }

        if (action === "save") {
          const result = store.saveAdapter(args.adapter);
          if (!result.ok) {
            return fail(FailureClass.INPUT, "adapter", "规则没有通过校验，未写入。", { problems: result.problems });
          }
          return { ok: true, action, adapter: result.adapter, replaced: result.replaced };
        }

        if (action === "delete") {
          const result = store.deleteAdapter(String(args.id ?? ""));
          if (!result.ok) return fail(FailureClass.INPUT, String(args.id ?? ""), "删除失败。", { problems: result.problems });
          return { ok: true, action, id: result.id };
        }

        if (action === "test") {
          const adapter = store.readAdapter(String(args.id ?? ""));
          if (!adapter) return fail(FailureClass.INPUT, String(args.id ?? ""), `没有这个适配器：${args.id ?? "(未给 id)"}`, { fix: "先用 action=list 看看有哪些。" });

          // 试跑也要把查询条件填上：留着 `{keyword}` 会去请求一个字面量地址，
          // 结果既不是 404 也不是数据，最难判断（看着像站点变了）。
          const params = args.params && typeof args.params === "object" ? args.params : {};
          const raw = args.url ? String(args.url) : adapter.fetch.url;
          const missing = urlPlaceholders(raw);
          if (!args.url && missing.length && !missing.every((n) => params[n] !== undefined && params[n] !== null && String(params[n]) !== "")) {
            const lack = missing.filter((n) => params[n] === undefined || params[n] === null || String(params[n]) === "");
            return fail(FailureClass.INPUT, adapter.id, `试跑前需要提供 ${lack.map((n) => `"${n}"`).join("、")}。`, {
              fix: `用 params 传进来，例如 params: { ${lack.map((n) => `"${n}": "你的值"`).join(", ")} }。`,
              detail: `fetch.url = ${raw}`,
            });
          }

          // 试跑用的地址必须和正式抓取【同一套构造逻辑】。
          // 曾经这里只填了查询参数、没填分页占位符，于是试跑请求的是字面量
          // `?page={page}` —— 服务端按非数字处理，返回空页，
          // 表现就是"试跑 ok 但 matched=0"，把人引向"选择器写错了"（实测踩过）。
          const startCursor = adapter.fetch.paginate && adapter.fetch.paginate.kind !== "nextLink"
            ? { value: adapter.fetch.paginate.start }
            : { link: undefined };
          const url = args.url ? raw : pageUrl(adapter, startCursor, params);
          const { jar, problem } = buildJar(args, cfg, safeHost(url));
          if (problem) return fail(FailureClass.INPUT, safeHost(url), problem, { fix: "检查 cookieFile 是否可读。" });

          const res = await fetchContent(url, {
            store,
            replay: args.replay === true,
            timeoutMs,
            jar,
            signal: exec?.signal,
            // 必须带上适配器声明的 headers —— 很多接口（含 B站）缺 referer/origin 会直接
            // 返回 400，于是试跑永远失败、而正式抓取正常。
            // 以前这里漏了，表现为"试跑必 400"，逼得调用方只能跳过试跑直接正式抓（实测踩过）。
            extraHeaders: { ...adapter.fetch.headers },
            // POST 适配器必须真发 POST —— 校验允许它，就得真做到（见 http.js 的说明）
            method: adapter.fetch.method,
            body: adapter.fetch.body,
          });
          if (!res.ok) return res;

          const { items: all, matched } = extractItems(adapter, res.text, res.url);
          const sample = all.slice(0, Math.max(1, args.maxItems ?? 5));

          // 全空字段说明选择器不对 —— 这是 agent 自我校准的关键信号
          const emptyFields = Object.keys(adapter.extract.fields).filter((key) =>
            sample.length > 0 && sample.every((row) => row[key] === "" || row[key] === null || row[key] === undefined),
          );

          let hintText = "";
          if (res.fromFixture) hintText = `用的是快照（存于 ${res.savedAt ?? "早前"}），没有联网。`;
          else if (res.replayMissed) hintText = `没有这个地址的快照，已照常联网抓取 —— 想离线重放就先 crawlkit_read snapshot=true 存一份。`;

          return {
            ok: true,
            action,
            hintText,
            fromFixture: Boolean(res.fromFixture),
            adapterId: adapter.id,
            matched,
            total: all.length,
            sample,
            emptyFields,
            pages: [{ url: res.url, ok: true, matched }],
          };
        }

        return fail(FailureClass.INPUT, action, `不认识的 action：${action}`, {
          fix: "action 只能是 list / get / save / test / delete。",
        });
      },
    },

    // -------------------------------------------------------- dataset
    {
      name: "crawlkit_dataset",
      description:
        "管理已抓取的数据。action 取值：list 列出全部；view 看某一段；search 按关键词检索；" +
        "delete 删除。数据量大时先存后用 search 检索，避免把全部内容读进上下文。",
      parameters: {
        action: { type: "string", required: true, enum: ["list", "view", "search", "delete"], description: "要做的操作" },
        name: { type: "string", description: "数据集名字（view / search / delete 需要）" },
        query: { type: "string", description: "检索词，多个词用空格分隔（search 需要），需同时命中" },
        offset: { type: "number", description: "从第几条开始（view，默认 0）" },
        limit: { type: "number", description: "最多返回几条（默认 20）" },
      },
      output: textOutput((_args, v) => {
        const lines = [];
        if (!v.ok) {
          renderFailure(lines, v);
          return [{ type: "text", text: lines.join("\n") }];
        }
        if (v.action === "list") {
          if (!v.datasets.length) lines.push("还没有任何数据集。用 crawlkit_run 的 saveAs 参数存一批数据。");
          else {
            lines.push(`共 ${v.datasets.length} 个数据集，合计 ${v.totalItems} 条：`);
            for (const d of v.datasets) {
              lines.push(`  · ${d.name} —— ${d.count} 条｜来源适配器 ${d.adapterId ?? "(未记录)"}｜更新于 ${d.updatedAt ?? "(未知)"}`);
            }
          }
          lines.push("", `数据目录：${v.dataRoot}`);
        } else if (v.action === "view") {
          lines.push(`数据集 ${v.name}：共 ${v.total} 条，本次显示第 ${v.offset + 1}–${v.offset + v.items.length} 条`);
          for (const item of v.items) lines.push(presentItem(item, 240).text);
        } else if (v.action === "search") {
          lines.push(`在 ${v.name} 里检索「${v.query}」：扫描 ${v.scanned} 条，命中 ${v.hits.length} 条${v.truncated ? "（已到上限）" : ""}`);
          for (const item of v.hits) lines.push(presentItem(item, 240).text);
        } else if (v.action === "delete") {
          lines.push(`已删除数据集 ${v.name}`);
        }
        return [{ type: "text", text: lines.join("\n") }];
      }),
      async execute(args, exec) {
        at(exec);
        const action = String(args.action ?? "");
        if (action === "list") {
          const datasets = store.listDatasets();
          return { ok: true, action, datasets, totalItems: datasets.reduce((n, d) => n + d.count, 0), dataRoot: store.root };
        }
        const name = String(args.name ?? "");
        if (!name) return fail(FailureClass.INPUT, action, "需要 name 参数。", { fix: "先用 action=list 看看有哪些数据集。" });

        try {
          if (action === "view") {
            const r = store.readDataset(name, { offset: args.offset ?? 0, limit: args.limit ?? 20 });
            return r.ok ? { ok: true, action, ...r } : fail(FailureClass.INPUT, name, r.problems.join("；"), { fix: "先用 action=list 确认名字。" });
          }
          if (action === "search") {
            const query = String(args.query ?? "");
            if (!query) return fail(FailureClass.INPUT, name, "search 需要 query 参数。", { fix: "给一个关键词。" });
            const r = store.searchDataset(name, query, { limit: args.limit ?? 20 });
            return r.ok ? { ok: true, action, ...r } : fail(FailureClass.INPUT, name, r.problems.join("；"));
          }
          if (action === "delete") {
            const r = store.deleteDataset(name);
            return r.ok ? { ok: true, action, name } : fail(FailureClass.INPUT, name, r.problems.join("；"));
          }
        } catch (e) {
          return fail(FailureClass.INPUT, name, String(e?.message ?? e), { fix: "数据集名字只能用字母、数字、点、下划线、连字符。" });
        }
        return fail(FailureClass.INPUT, action, `不认识的 action：${action}`, { fix: "action 只能是 list / view / search / delete。" });
      },
    },
  ];
}

/** 从地址里取 host，取不到就返回空串（绝不抛）。 */
function safeHost(url) {
  try {
    return new URL(String(url)).hostname;
  } catch {
    return "";
  }
}

/**
 * 两份可直接改的适配器骨架。
 *
 * 为什么要有它：真实使用中，模型为了写对规则**去翻了插件源码** ——
 * 说明只靠工具描述不足以自描述规范。给一份能直接改的骨架，
 * 比让调用方猜字段名便宜得多。
 */
function adapterTemplates() {
  return {
    html: {
      id: "example-list",
      match: ["www.example.com"],
      note: "一句话说明这规则抓什么",
      fetch: {
        tier: "http",
        url: "https://www.example.com/list?page={page}",
        headers: { referer: "https://www.example.com/" },
        paginate: { kind: "page", param: "page", start: 1, step: 1, max: 3 },
      },
      extract: {
        type: "html",
        items: "ul.list > li.item",
        fields: {
          title: { sel: "h3", take: "text" },
          url: { sel: "a", take: "attr", name: "href", abs: true },
          time: { sel: ".time", parse: "date" },
          tags: { sel: ".tag", take: "all" },
        },
        uniqueBy: ["url"],
      },
    },
    htmlWithParam: {
      id: "example-search",
      match: ["www.example.com"],
      note: "搜索页：关键词由调用方提供，同一套规则服务任意关键词",
      fetch: {
        tier: "http",
        url: "https://www.example.com/search?q={keyword}&page={page}",
        headers: { referer: "https://www.example.com/" },
        paginate: { kind: "page", param: "page", start: 1, step: 1, max: 3 },
      },
      extract: {
        type: "html",
        items: "div.result",
        fields: {
          title: { sel: "h3", take: "text" },
          url: { sel: "a", take: "attr", name: "href", abs: true },
        },
        uniqueBy: ["url"],
      },
    },
    json: {
      id: "example-api",
      match: ["api.example.com"],
      note: "一句话说明这规则抓什么",
      fetch: {
        tier: "api",
        url: "https://api.example.com/v1/list?pn={page}",
        headers: { referer: "https://www.example.com/" },
        paginate: { kind: "page", param: "pn", start: 1, step: 1, max: 3 },
      },
      extract: {
        type: "json",
        items: "data.list",
        fields: {
          title: "title",
          author: "owner.name",
          play: { path: "stat.view", parse: "number" },
          time: { path: "pubdate", parse: "date" },
          url: { path: "short_link", abs: true },
        },
        uniqueBy: ["title"],
      },
    },
  };
}
