/**
 * DSH DSL → JSON Schema 编译。
 *
 * 为什么要自己编译（实测确认）：官方 `defineTool` 在 `@deepseek-ai/dsh-tools` 里，
 * 而该包【不随插件安装】—— 从插件的安装位置
 * `createRequire(...).resolve('@deepseek-ai/dsh-tools')` 直接 MODULE_NOT_FOUND
 * （profile 的 node_modules 里只有插件自己）。绕过编译把 DSL 原样注册，
 * 会被模型 API 拒为：
 *   schema must be a JSON Schema of type: "object", got "type: null"
 * 所以这里按官方 `ValueSchemaSpec` 的语义复刻编译规则，保持零依赖。
 * 想核对官方定义时，在本机 dsh CLI 安装目录下的 `@deepseek-ai/dsh-tools` 包内
 * 可以读到它的类型声明（`lib/types/`）。
 */

/** 注解类关键字：不参与校验，只进 schema 供模型参考。 */
const ANNOTATIONS = ["description", "title", "default", "examples"];

function annotate(out, spec) {
  for (const key of ANNOTATIONS) {
    if (spec[key] !== undefined) out[key] = spec[key];
  }
  if (spec.const !== undefined) out.const = spec.const;
  return out;
}

/** 编译任意 JSON 值根节点。 */
function compileValue(spec) {
  if (!spec || typeof spec !== "object") return { type: "string" };

  // `json` 是作者专用的"任意 JSON"节点，编译成无 type 的注解式 schema
  if (spec.type === "json") return annotate({}, spec);

  // oneOf：至少两个分支
  if (Array.isArray(spec.oneOf)) return annotate({ oneOf: spec.oneOf.map(compileValue) }, spec);

  if (Array.isArray(spec.enum) && spec.enum.length) {
    return annotate({ type: spec.type ?? "string", enum: [...spec.enum] }, spec);
  }

  const out = annotate({ type: spec.type ?? "string" }, spec);

  if (spec.type === "array") out.items = compileValue(spec.items ?? { type: "json" });

  if (spec.type === "object") {
    // 官方规定：显式 object 节点必须声明 openness，否则会意外继承 JSON Schema 默认值
    out.additionalProperties = spec.additionalProperties === true;
    if (spec.properties) Object.assign(out, compileProperties(spec.properties));
  }

  return out;
}

/** 逐属性编译，并把 `required: true` 收集成顶层 required 数组。 */
function compileProperties(spec) {
  const properties = {};
  const required = [];
  for (const [key, value] of Object.entries(spec || {})) {
    properties[key] = compileValue(value);
    if (value && value.required === true) required.push(key);
  }
  return required.length ? { properties, required } : { properties };
}

/**
 * 工具参数 DSL → 顶层 JSON Schema。
 *
 * 刻意不带 `additionalProperties`：官方管这叫"隐式开放 object 根"
 * （`ParameterJsonSchema` 是 `ObjectJsonSchema`，但编译结果不带该键）。
 * 给根加上它会让根变成另一种形状，与官方编译结果不一致。
 */
export function compileParameters(spec) {
  return { type: "object", ...compileProperties(spec) };
}

/** 输出 DSL → JSON Schema。 */
export function compileOutputSchema(spec) {
  return compileValue(spec);
}

/**
 * 参数根的额外约束（官方"隐式开放 object 根"的定义）。
 *
 * 这两条踩过：
 *   · 根不能带 `additionalProperties` —— 带了就不是官方那种隐式开放根；
 *   · **没有必填项时绝不能留下 `required` 键** —— DSH 会因它拒绝加载整个插件，
 *     报 `unsupported JSON schema: schema.required must be an array of strings`。
 *     写成 `required: undefined` 也一样致命，因为那个键存在。
 */
export function assertParameterRoot(schema, where) {
  if ("additionalProperties" in schema) {
    throw new Error(`工具 schema 不受支持（${where}）：参数根必须是隐式开放 object 根，不能带 additionalProperties`);
  }
  if ("required" in schema && !Array.isArray(schema.required)) {
    throw new Error(`工具 schema 不受支持（${where}）：参数根的 required 必须是数组，不能是 ${JSON.stringify(schema.required)}`);
  }
  return schema;
}

/**
 * 注册前的本地守卫：把"作者写错了"变成加载期的明确报错。
 *
 * 为什么值得做：DSH 对不受支持的 schema 是【拒绝加载】而不是忽略，
 * 而错误出现在注册那一刻、指向的是编译结果而非原始定义，很难查。
 *
 * 作用范围要留意：只检查**嵌套** object 是否声明 openness ——
 * 参数根是官方定义的隐式开放根，对根做这项检查会误伤每一个合法工具（实测踩过）。
 */
export function assertSupportedSchema(schema, where) {
  const problems = [];

  const walk = (node, at, isRoot) => {
    if (node === null || typeof node !== "object" || Array.isArray(node)) {
      problems.push(`${at} 必须是对象`);
      return;
    }
    if ("required" in node && !(Array.isArray(node.required) && node.required.every((k) => typeof k === "string"))) {
      problems.push(`${at}.required 必须是字符串数组`);
    }
    if (Array.isArray(node.required) && node.properties) {
      for (const k of node.required) {
        if (!(k in node.properties)) problems.push(`${at}.required 里的 "${k}" 不在 properties 中`);
      }
    }
    if (!isRoot && node.type === "object" && typeof node.additionalProperties !== "boolean") {
      problems.push(`${at} 是嵌套 object，必须显式声明 additionalProperties`);
    }
    if (node.properties) {
      for (const [k, v] of Object.entries(node.properties)) walk(v, `${at}.properties.${k}`, false);
    }
    if (node.items) walk(node.items, `${at}.items`, false);
    if (Array.isArray(node.oneOf)) {
      if (node.oneOf.length < 2) problems.push(`${at}.oneOf 至少需要两个分支`);
      node.oneOf.forEach((v, i) => walk(v, `${at}.oneOf[${i}]`, false));
    }
  };

  walk(schema, where, true);
  if (problems.length) throw new Error(`工具 schema 不受支持（${where}）：\n  - ${problems.join("\n  - ")}`);
  return schema;
}

/** 手写的 Standard Schema —— 参数校验，与官方 defineTool 的语义对齐。 */
function validateParameters(schema, args) {
  const problems = [];
  const value = args === null || typeof args !== "object" || Array.isArray(args) ? {} : args;

  for (const key of schema.required ?? []) {
    if (value[key] === undefined) problems.push(`${key} 是必填参数`);
  }
  for (const [key, spec] of Object.entries(schema.properties ?? {})) {
    const given = value[key];
    if (given === undefined) continue;
    const type = spec.type;
    const actual = Array.isArray(given) ? "array" : given === null ? "null" : typeof given;
    if (type === "string" && actual !== "string") problems.push(`${key} 应为 string，收到 ${actual}`);
    else if (type === "number" && (actual !== "number" || !Number.isFinite(given))) problems.push(`${key} 应为 number`);
    else if (type === "integer" && !(Number.isInteger(given))) problems.push(`${key} 应为 integer`);
    else if (type === "boolean" && actual !== "boolean") problems.push(`${key} 应为 boolean`);
    else if (type === "array" && actual !== "array") problems.push(`${key} 应为 array`);
    else if (type === "object" && actual !== "object") problems.push(`${key} 应为 object`);
    else if (Array.isArray(spec.enum) && !spec.enum.includes(given)) {
      problems.push(`${key} 只能是 ${spec.enum.map((v) => JSON.stringify(v)).join(" / ")}`);
    }
  }
  return problems;
}

/**
 * 工具定义 → DSH 期望的形状，并在注册前自查。
 *
 * 参数侧额外做两件官方行为必须对齐的事：
 *   · 声明 `required: true` 的属性要收集进顶层 required（漏了会让必填参数变成可选）；
 *   · 没有必填项时**绝不能留下 `required` 键**（DSH 会因它而拒绝加载整个插件）。
 */
export function compileTool(tool) {
  const parameters = compileParameters(tool.parameters);
  const output = { ...tool.output, schema: compileOutputSchema(tool.output.schema) };
  assertParameterRoot(parameters, `${tool.name}.parameters`);
  assertSupportedSchema(parameters, `${tool.name}.parameters`);
  assertSupportedSchema(output.schema, `${tool.name}.output.schema`);

  const execute = tool.execute;
  return {
    ...tool,
    parameters,
    output,
    async execute(args, exec) {
      const problems = validateParameters(parameters, args);
      if (problems.length) throw new Error(`参数不合法：${problems.join("；")}`);
      return execute(args ?? {}, exec);
    },
  };
}
