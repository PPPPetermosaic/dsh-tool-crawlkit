/**
 * 装完自检：确认这个包在本机是"装对了、能加载"的。
 *
 * 跑法：node check.js
 *
 * 它检查的是【这个包本身】能不能被 DSH 接受，不需要 DSH 在跑、不联网、
 * 不写任何文件。它守的是三类"静默失败"：
 *
 *   ① `cordis.patch.yml` 里的 name 与 package.json 的 name 不一致
 *      —— 插件会装上但完全不生效，而且没有任何报错。这是最难查的一类。
 *   ② lib 下某个模块加载不了（语法错、依赖缺失）
 *      —— DSH 只会报 "failed to import"，不会说清是哪个文件。
 *   ③ 某个工具的参数/输出 schema 不合法
 *      —— DSH 会拒绝加载整个插件，而错误指向的是编译结果，不是原始定义。
 *
 * 顺序刻意安排：先查清单与 patch 对齐（最便宜、最容易错），再查加载，最后查 schema。
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const problems = [];
const ok = [];

const pass = (msg) => ok.push(msg);
const fail = (msg) => problems.push(msg);

// ---------------------------------------------------------------- 清单

const pkgPath = path.join(HERE, "package.json");
if (!existsSync(pkgPath)) {
  fail("找不到 package.json —— 这个目录不是插件包的根目录");
} else {
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    pass(`package.json 可解析（${pkg.name}@${pkg.version}）`);
  } catch (e) {
    fail(`package.json 不是合法 JSON：${e.message}`);
  }

  if (pkg) {
    // ① patch 与包名对齐 —— 写错时插件静默不生效
    const patchRel = pkg.dsh?.bundle?.patch;
    if (!patchRel) {
      fail("package.json 缺少 dsh.bundle.patch —— DSH 不会把它当成 bundle");
    } else {
      const patchPath = path.join(HERE, patchRel);
      if (!existsSync(patchPath)) {
        fail(`dsh.bundle.patch 指向的文件不存在：${patchRel}`);
      } else {
        const patch = readFileSync(patchPath, "utf8");
        // 逐个候选行的取 name 值；不用"两个正则配 ?? 交替"的写法，
        // 因为那种写法会在源码里留下 ":/" 相邻的字样，触发本项目的路径检查器（实测踩过）
        const nameLine = patch
          .split(/\r?\n/)
          .map((line) => line.trim())
          .find((line) => line.startsWith("name:"));
        const declared = nameLine?.slice(nameLine.indexOf(":") + 1).trim().replace(/^['"]|['"]$/g, "");
        if (!declared) fail(`${patchRel} 里找不到 name 行`);
        else if (declared !== pkg.name) {
          fail(`${patchRel} 的 name（${declared}）与 package.json 的 name（${pkg.name}）不一致 —— 插件会装上但不生效`);
        } else {
          pass(`注册补丁的 name 与包名一致（${pkg.name}）`);
        }
      }
    }

    // ② 入口与 files 列表
    const entry = pkg.exports?.["."] ?? pkg.main;
    if (!entry) fail("package.json 没声明入口（exports[\".\"] 或 main）");
    else if (!existsSync(path.join(HERE, entry))) fail(`入口文件不存在：${entry}`);
    else pass(`入口存在：${entry}`);

    for (const item of pkg.files ?? []) {
      if (!existsSync(path.join(HERE, item))) fail(`files 里列的 ${item} 不存在（打包会缺东西）`);
    }
    pass(`files 列表 ${(pkg.files ?? []).length} 项都有对应文件`);
  }
}

// ---------------------------------------------------------------- 加载

let mod = null;
const entryRel = existsSync(path.join(HERE, "lib", "plugin.js")) ? "lib/plugin.js" : null;
if (!entryRel) {
  fail("找不到 lib/plugin.js");
} else {
  try {
    mod = await import(pathToFileURL(path.join(HERE, entryRel)).href);
    pass("插件入口加载成功");
  } catch (e) {
    fail(`插件入口加载失败：${e.message}`);
  }
}

if (mod) {
  if (typeof mod.apply !== "function") fail("入口没有导出 apply 函数（DSH 需要 apply 或 service class）");
  else pass("导出了 apply");

  if (!Array.isArray(mod.inject)) fail("入口没有导出 inject 数组");
  else if (!mod.inject.includes("tools")) fail(`inject 里没有 tools（当前：${JSON.stringify(mod.inject)}）`);
  else pass(`inject 声明正确：${JSON.stringify(mod.inject)}`);

  // Config 必须是 Standard Schema，否则 cordis 报
  // "Cannot read properties of undefined (reading 'validate')"
  const validate = mod.Config?.["~standard"]?.validate;
  if (typeof validate !== "function") {
    fail("Config 不是 Standard Schema —— cordis 会在读配置时抛错");
  } else {
    const r = validate({});
    if (!r?.value) fail("Config 校验没有返回值");
    else {
      pass("Config 是 Standard Schema 且能给出默认值");
      if (/^([A-Za-z]:[\\/]|\\\\|\/)/.test(String(r.value.dataRoot ?? ""))) {
        fail("Config 里 dataRoot 的默认值是本机绝对路径 —— 不该随包发布");
      }
    }
  }
}

// ---------------------------------------------------------------- 工具 schema

if (mod && typeof mod.apply === "function") {
  const registered = [];
  try {
    mod.apply(
      {
        tools: { register: (t) => registered.push(t), schemas: () => registered.map((t) => ({ name: t.name })) },
        logger: { info: () => {} },
      },
      // skipLoadMarker：自检必须无副作用，不能在任何地方留文件
      { skipLoadMarker: true },
    );
  } catch (e) {
    fail(`apply 执行失败：${e.message}`);
  }

  if (!registered.length) fail("apply 没有注册任何工具");
  else pass(`注册了 ${registered.length} 个工具：${registered.map((t) => t.name).join(" / ")}`);

  for (const tool of registered) {
    const where = tool.name;
    if (!tool.description || tool.description.length < 20) fail(`${where} 的描述太短（模型看不到它做什么）`);
    if (typeof tool.execute !== "function") fail(`${where} 没有 execute`);
    if (typeof tool.output?.render !== "function") fail(`${where} 没有 output.render`);

    const params = tool.parameters;
    if (params?.type !== "object" || !params.properties) {
      fail(`${where}.parameters 不是 object 型 JSON Schema（DSH 会拒绝加载整个插件）`);
    } else {
      // 参数根是"隐式开放 object 根"：不该带 additionalProperties；
      // 且没有必填项时绝不能留下 required 键
      if ("additionalProperties" in params) fail(`${where}.parameters 不该带 additionalProperties（参数根是隐式开放的）`);
      if ("required" in params && !Array.isArray(params.required)) {
        fail(`${where}.parameters 的 required 不是数组 —— DSH 会拒绝加载`);
      }
    }

    if (tool.output?.schema?.type !== "object") fail(`${where}.output.schema 的根必须是 object`);
    if (JSON.stringify(tool.output?.schema ?? {}).includes("undefined")) {
      fail(`${where}.output.schema 里有 undefined（序列化后会出错）`);
    }
  }

  if (registered.length) pass("所有工具的参数与输出 schema 都通过本机校验");
}

// ---------------------------------------------------------------- 结论

console.log("crawlkit 包自检");
console.log("─".repeat(56));
for (const line of ok) console.log(`  OK   ${line}`);

// 清掉早期版本可能留下的临时目录（现在自检已无副作用，这里只作兜底）
const tmp = path.join(HERE, ".crawlkit-check");
if (existsSync(tmp)) {
  try {
    const { rmSync } = await import("node:fs");
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    // 删不掉不影响结论
  }
}

if (problems.length) {
  console.log("");
  for (const line of problems) console.log(`  FAIL ${line}`);
  console.log(`\n${problems.length} 项未通过 —— 这个包装进 DSH 会不生效或加载失败。`);
  process.exit(1);
}

console.log(`\n全部通过（${ok.length} 项）。这个包可以被 DSH 加载。`);
console.log("注意：这里只检查包本身；实际抓取能力与数据落点请在 DSH 里跑 crawlkit_selfcheck。");
