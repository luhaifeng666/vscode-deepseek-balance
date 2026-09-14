// 冒烟测试：在纯 Node 下加载**发布产物**并跑一遍 activate()。
//
// 它和 src/test/** 的分工是刻意划清的：
//   src/test/**  —— 测源码逻辑（解析、格式化、状态机、HTTP 客户端）
//   scripts/smoke —— 测「装进 VS Code 之后会怎样」，加载的是 dist/extension.js
//                    或 .vsix 里解出来的那份，不经过 esbuild 重新打包
//
// 所以这个文件**不能**放进 src/test/：那里会被 esbuild 打进 out-test/，
// 于是测的又变成源码的一份拷贝，而打包产物里的 .vscodeignore 配错、main 路径
// 写错、activate 期崩溃，全都会漏过去。
//
//   pnpm run smoke        测 dist/extension.js（开发循环，快）
//   pnpm run smoke:vsix   测 .vsix 里的那份（CI 用，还顺带验打包内容）
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const TARGET = process.env.SMOKE_TARGET ?? "dist";

/** 这个假密钥会走完整个激活流程；断言它不出现在日志或状态栏里。 */
const API_KEY = "sk-smoke-abcdefghijklmnop";

/** 用量侧的第二枚凭据。两个都不许出现在日志/悬停里。 */
const USAGE_TOKEN = "ut-smoke-abcdefghijklmnop";
const USAGE_TOKEN_SECRET = "deepseekBalance.usageToken";
const API_KEY_SECRET = "deepseekBalance.apiKey";

const stub = require("./vscode-stub.cjs");

// 扩展宿主的 `vscode` 由 VS Code 注入，纯 Node 下没有这个模块。
// 拦 Module._load 把它指到桩上 —— 必须在 require 产物之前装好。
const Module = require("node:module");
const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === "vscode") return stub;
  return originalLoad.call(this, request, ...rest);
};

/** 把 .vsix 解到临时目录，返回扩展根目录（vsix 内部固定是 extension/ 一层）。 */
function extractVsix(vsixPath) {
  const dir = mkdtempSync(path.join(tmpdir(), "dsb-smoke-"));
  execFileSync("unzip", ["-q", "-o", vsixPath, "-d", dir]);
  return { dir, root: path.join(dir, "extension") };
}

/** 递归列出扩展根目录下的所有相对路径。 */
function listFiles(root) {
  const out = [];
  const walk = (rel) => {
    for (const name of readdirSync(path.join(root, rel))) {
      const relPath = rel ? `${rel}/${name}` : name;
      if (statSync(path.join(root, relPath)).isDirectory()) walk(relPath);
      else out.push(relPath);
    }
  };
  walk("");
  return out;
}

const state = {
  root: undefined,
  entry: undefined,
  cleanup: undefined,
  server: undefined,
  context: undefined,
  ext: undefined,
  stored: new Map([[API_KEY_SECRET, API_KEY]]),
  fakeFetch: undefined,
};

/** 等异步续体落地。真时间是这里的唯一选项：要等的是扩展内部的 promise 链。 */
const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  assert.ok(
    TARGET === "dist" || TARGET === "vsix",
    `SMOKE_TARGET 只能是 dist 或 vsix，收到 ${TARGET}`,
  );

  if (TARGET === "dist") {
    state.root = repoRoot;
    state.entry = path.join(repoRoot, "dist", "extension.js");
    assert.ok(existsSync(state.entry), `没找到 ${state.entry} —— 先跑 pnpm run compile`);
  } else {
    const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
    const vsix = path.join(repoRoot, `${pkg.name}-${pkg.version}.vsix`);
    assert.ok(existsSync(vsix), `没找到 ${vsix} —— 先跑 pnpm run package`);
    const { dir, root } = extractVsix(vsix);
    state.root = root;
    state.cleanup = () => rmSync(dir, { recursive: true, force: true });
    // main 从**打包进去的** package.json 读 —— VS Code 读的就是它
    const packaged = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
    const relMain = String(packaged.main).replace(/^\.\//, "");
    state.entry = path.join(root, relMain);
    assert.ok(
      existsSync(state.entry),
      `vsix 里没有 ${relMain} —— package.json 的 main 或 .vscodeignore 有问题`,
    );
  }

  state.pkg = JSON.parse(readFileSync(path.join(state.root, "package.json"), "utf8"));

  // ---- 本地 mock 接口 ----
  //
  // 每条请求都记下来（路径 + 凭据 + 头），因为最有价值的断言恰恰是**两个凭据
  // 各自发往正确端点、没有串用**：余额带 API Key、用量带 userToken。这个假服务器
  // 是唯一能同时看见两条链路的地方。
  state.requests = [];
  state.server = createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const auth = req.headers.authorization;
    state.requests.push({
      path: url.pathname,
      auth,
      referer: req.headers.referer,
      userAgent: req.headers["user-agent"],
      search: url.search,
    });

    // 余额：只认 API Key
    if (url.pathname === "/user/balance") {
      if (auth !== `Bearer ${API_KEY}`) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "bad key" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          is_available: true,
          balance_infos: [
            {
              currency: "CNY",
              total_balance: "34.53",
              granted_balance: "0.00",
              topped_up_balance: "34.53",
            },
            {
              currency: "USD",
              total_balance: "20.00",
              granted_balance: "0.00",
              topped_up_balance: "20.00",
            },
          ],
        }),
      );
      return;
    }

    // 用量：只认 userToken。凭据不对时按真实接口的行为返回 **HTTP 200 + 40002**
    // ——只看状态码的实现会误判成功，这条路径必须在冒烟里也走一遍。
    if (url.pathname.startsWith("/api/v0/usage/by_api_key/")) {
      const token = state.stored.get("deepseekBalance.usageToken");
      if (token === undefined || auth !== `Bearer ${token}`) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ code: 40002, msg: "Missing Token", data: null }));
        return;
      }
      const kind = url.pathname.endsWith("/cost") ? "cost" : "amount";
      const bizData =
        kind === "cost"
          ? [{ currency: "CNY", series: [{ buckets: [{ cost: "1.25" }] }] }]
          : {
              series: [
                {
                  buckets: [
                    {
                      usage: {
                        REQUEST: 3,
                        RESPONSE_TOKEN: 40,
                        PROMPT_CACHE_HIT_TOKEN: 10,
                        PROMPT_CACHE_MISS_TOKEN: 20,
                      },
                    },
                  ],
                },
              ],
            };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ code: 0, data: { biz_code: 0, biz_data: bizData } }));
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise((r) => state.server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${state.server.address().port}`;
  stub.__configStore["deepseekBalance.baseUrl"] = origin;
  // 用量地址不是配置项，只从环境变量读。resolveUsageBaseUrl 结构上只放行
  // 回环地址，所以这里能指过去、而恶意配置指不出去。
  process.env.DEEPSEEK_USAGE_BASE_URL = origin;

  // ---- 假 context ----
  state.context = {
    subscriptions: [],
    extension: { packageJSON: state.pkg },
    secrets: {
      async get(key) {
        return state.stored.get(key);
      },
      async store(key, value) {
        state.stored.set(key, value);
      },
      async delete(key) {
        state.stored.delete(key);
      },
      onDidChange() {
        return new stub.Disposable(() => {});
      },
    },
  };

  state.ext = require(state.entry);
  state.ext.activate(state.context);

  // 状态栏项是懒创建的：等启动那次拉取落地
  await settle(600);
});

after(async () => {
  for (const d of state.context?.subscriptions ?? []) {
    try {
      d.dispose();
    } catch {
      // 释放期的异常由专门的用例断言，这里只做兜底清理
    }
  }
  try {
    state.ext?.deactivate();
  } catch {
    // 同上
  }
  await new Promise((r) => state.server?.close(r));
  state.cleanup?.();
});

test("activate() 不抛异常，且注册了 package.json 里声明的全部命令", () => {
  const declared = (state.pkg.contributes?.commands ?? []).map((c) => c.command);
  assert.ok(declared.length > 0, "package.json 没声明任何命令");

  const missing = declared.filter((id) => !stub.commands.registered.has(id));
  assert.deepEqual(missing, [], `这些命令声明了但没注册：${missing.join(", ")}`);
});

test("activate() 建立了输出通道", () => {
  assert.ok(stub.__created.outputChannels.length > 0, "没有创建输出通道");
});

test("状态栏出现且显示 mock 接口返回的余额", () => {
  assert.equal(stub.__created.statusBarItems.length, 1, "状态栏项数量不是 1");
  const item = stub.__created.statusBarItems[0];
  assert.match(item.text, /\$\(credit-card\)/, `状态栏文本没有图标：${item.text}`);
  assert.match(item.text, /CNY 34\.53/, `状态栏文本没有金额：${item.text}`);
});

test("tooltip 是 MarkdownString，且命令链接走 enabledCommands 白名单", () => {
  const item = stub.__created.statusBarItems[0];
  assert.ok(item.tooltip instanceof stub.MarkdownString, "tooltip 不是 MarkdownString");
  assert.equal(
    item.tooltip.supportThemeIcons,
    true,
    "supportThemeIcons 没开，$(...) 会原样显示成文本",
  );
  // 白名单形式，绝不能是 true —— true 会放行 tooltip 里任意命令 URI
  const trusted = item.tooltip.isTrusted;
  assert.ok(Array.isArray(trusted?.enabledCommands), `isTrusted 不是白名单形式：${trusted}`);
  assert.ok(trusted.enabledCommands.length > 0, "白名单是空的");

  const declared = (state.pkg.contributes?.commands ?? []).map((c) => c.command);
  const unknown = trusted.enabledCommands.filter((c) => !declared.includes(c));
  assert.deepEqual(unknown, [], `白名单里有未声明的命令：${unknown.join(", ")}`);
});

test("「刷新余额」命令可执行", async () => {
  await stub.commands.registered.get("deepseekBalance.refresh")();
  await settle();
  assert.match(stub.__created.statusBarItems[0].text, /CNY 34\.53/);
});

test("「查看余额详情」弹出 QuickPick", async () => {
  const before = stub.__created.quickPicks.length;
  await stub.commands.registered.get("deepseekBalance.showDetails")();
  assert.ok(stub.__created.quickPicks.length > before, "没有弹出 QuickPick");
});

test("配置变更不会抛异常", async () => {
  stub.__configListeners.emit("change", { affectsConfiguration: () => true });
  await settle(200);
});

// ---- 用量 ----

const usageRequests = () =>
  state.requests.filter((r) => r.path.startsWith("/api/v0/usage/by_api_key/"));
const tooltipText = () => String(stub.__created.statusBarItems[0].tooltip?.value ?? "");

test("没配用量 Token 时一个用量请求都不发，悬停如实说「未配置」", async () => {
  assert.equal(state.stored.has(USAGE_TOKEN_SECRET), false, "前提：此时不该有 Token");
  assert.deepEqual(usageRequests(), [], "没配 Token 却打了用量接口");
  assert.match(tooltipText(), /未配置/, "悬停没有说明用量未配置");
});

test("「设置用量 Token」之后悬停出现用量数字，且两个凭据各发往正确端点", async () => {
  const before = usageRequests().length;

  // 模拟用户在密码框里真的粘贴了 Token。
  const original = stub.window.showInputBox;
  stub.window.showInputBox = async (options) => {
    stub.__created.inputBox = options;
    return USAGE_TOKEN;
  };
  try {
    await stub.commands.registered.get("deepseekBalance.setUsageToken")();
  } finally {
    stub.window.showInputBox = original;
  }
  await settle();

  assert.equal(stub.__created.inputBox?.password, true, "Token 输入框没有设成密码框");
  assert.equal(state.stored.get(USAGE_TOKEN_SECRET), USAGE_TOKEN, "Token 没进 SecretStorage");

  const fresh = usageRequests().slice(before);
  assert.ok(fresh.length >= 2, `设置 Token 后没有发起用量查询：${fresh.length} 条`);

  // 这是这个假服务器唯一能验的事：**两个凭据没有串用**。
  assert.deepEqual(
    [...new Set(fresh.map((r) => r.auth))],
    [`Bearer ${USAGE_TOKEN}`],
    "用量请求带的不是 userToken",
  );
  const balanceAuths = [
    ...new Set(state.requests.filter((r) => r.path === "/user/balance").map((r) => r.auth)),
  ];
  assert.deepEqual(balanceAuths, [`Bearer ${API_KEY}`], "余额请求带的不是 API Key");

  const text = tooltipText();
  assert.match(text, /用量/, `悬停里没有用量段：${text}`);
  assert.match(text, /CNY 1\.25/, `悬停里没有消耗金额：${text}`);
  assert.match(text, /请求 3 次/, `悬停里没有请求次数：${text}`);
  assert.match(text, /缓存命中 10/, `悬停里没有缓存命中：${text}`);

  // 用量接手渲染之后，状态栏项不能被重建（两个生产者各调一次 update 就会打架）
  assert.equal(stub.__created.statusBarItems.length, 1, "状态栏项被重建了");
});

test("用量请求带上了 referer / user-agent（Electron 上可能被吞，先钉住行为）", async () => {
  // 本机 Node 会原样转发这两个头，但 VS Code 1.95 是 Electron 32 → Node 20，
  // undici 对 forbidden header 的处理跨版本改过。这里失败就先知道，别等上线。
  const sample = usageRequests().at(-1);
  assert.ok(sample !== undefined, "没有可检查的用量请求");
  assert.equal(sample.referer, "https://platform.deepseek.com/usage");
  assert.match(String(sample.userAgent), /Mozilla\/5\.0/);
  assert.match(sample.search, /[?&]tz=0(&|$)/, `窗口参数里没有 tz=0：${sample.search}`);
});

test("执行时间范围命令：写进 Global，并触发用量重查与重渲染", async () => {
  const before = usageRequests().length;

  await stub.commands.registered.get("deepseekBalance.usageRangeMonth")();
  await settle();

  assert.equal(
    stub.__configScopes.global["deepseekBalance.usageRange"],
    "month",
    "范围没写进全局设置",
  );
  assert.equal(
    stub.__configScopes.workspace["deepseekBalance.usageRange"],
    undefined,
    "范围被写进了工作区层，而不是全局",
  );

  const fresh = usageRequests().slice(before);
  assert.ok(fresh.length >= 2, "切范围没有触发用量重查");

  const text = tooltipText();
  assert.match(text, /\*\*用量 · 本月\*\*/, `悬停标题没跟着切：${text}`);
  // 当前范围是粗体、不做成链接；另外两个才是链接。
  assert.ok(
    !text.includes("command:deepseekBalance.usageRangeMonth"),
    "当前范围不该是可点链接（它已经是当前值了）",
  );
  assert.ok(
    text.includes("command:deepseekBalance.usageRangeToday"),
    "其它范围应当是命令链接",
  );
});

test("工作区层盖住 Global 时如实提示，而不是静默失败", async () => {
  // 这是这套方案自己带来的失败模式：写 Global，工作区有同名设置就被盖住，
  // 表现是「点了链接数字纹丝不动」且毫无报错。
  stub.__configScopes.workspace["deepseekBalance.usageRange"] = "week";
  const before = stub.__created.messages.length;

  await stub.commands.registered.get("deepseekBalance.usageRangeToday")();
  await settle();

  // 写还是写了 Global，只是没生效
  assert.equal(stub.__configScopes.global["deepseekBalance.usageRange"], "today");

  const fresh = stub.__created.messages.slice(before).map(([, message]) => String(message));
  assert.ok(
    fresh.some((m) => m.includes("工作区") && m.includes("覆盖")),
    `被工作区设置覆盖时没有提示：${JSON.stringify(fresh)}`,
  );

  delete stub.__configScopes.workspace["deepseekBalance.usageRange"];
  await settle(200);
});

test("「清除用量 Token」回到未配置态，余额不受影响", async () => {
  const before = usageRequests().length;
  await stub.commands.registered.get("deepseekBalance.clearUsageToken")();
  await settle();

  assert.equal(state.stored.has(USAGE_TOKEN_SECRET), false, "Token 仍在 SecretStorage 里");
  const text = tooltipText();
  assert.match(text, /未配置/, `清除 Token 后悬停没回到未配置：${text}`);
  assert.match(text, /CNY 34\.53/, "清除用量 Token 把余额也弄没了");

  // 未配置就不该再轮询（gate）。
  stub.__configListeners.emit("change", { affectsConfiguration: () => true });
  await settle();
  assert.equal(usageRequests().length, before, "未配 Token 时仍在打用量接口");
});

test("「清除 API Key」回到未配置态，且密钥真的从 SecretStorage 删掉了", async () => {
  await stub.commands.registered.get("deepseekBalance.clearApiKey")();
  await settle();
  assert.equal(state.stored.has("deepseekBalance.apiKey"), false, "密钥仍在 SecretStorage 里");
  const { text } = stub.__created.statusBarItems[0];
  assert.ok(!/\d/.test(text), `清除密钥后状态栏仍显示数字：${text}`);
  assert.match(text, /DeepSeek/, `清除密钥后状态栏文案不符：${text}`);
});

test("没有 API Key 时，用量轮询彻底停掉（哪怕 Token 还在）", async () => {
  // 隐私边界：no-key 态下悬停根本不渲染用量段，此时还去轮询就是一个从没配过
  // API Key 的用户每隔几分钟被我们打一次 platform.deepseek.com，换回一份永不
  // 展示的数据。整个设计里唯一「用户看不到收益却打了第三方主机」的路径。
  state.stored.set(USAGE_TOKEN_SECRET, USAGE_TOKEN);
  const before = state.requests.length;

  // 把能触发刷新的口子都捅一遍：配置变更 + 手动刷新 + 窗口聚焦。
  stub.__configListeners.emit("change", { affectsConfiguration: () => true });
  await stub.commands.registered.get("deepseekBalance.refresh")();
  stub.window._windowState?.({ focused: true });
  await settle();

  assert.deepEqual(
    state.requests.slice(before).filter((r) => r.path.startsWith("/api/v0/")),
    [],
    "没有 API Key 却打了用量接口",
  );

  state.stored.delete(USAGE_TOKEN_SECRET);
});

test("日志与状态栏里都没有出现过任何一枚凭据", () => {
  const logs = stub.__created.outputChannels.flatMap((c) => c.lines.map(([, m]) => String(m)));
  assert.ok(logs.length > 0, "输出通道一行日志都没有");

  // 两枚都要查。API Key 有 `sk-` 前缀，脱敏 pattern 天然盯着它；控制台 Token
  // 不是那个形状——它能被兜住靠的是扩过的 JWT / Bearer 规则，所以必须单独断言，
  // 否则「没泄漏」可能只是因为压根没走到脱敏函数。
  for (const [label, secret] of [
    ["API Key", API_KEY],
    ["用量 Token", USAGE_TOKEN],
  ]) {
    assert.deepEqual(
      logs.filter((l) => l.includes(secret)),
      [],
      `日志里泄漏了${label}`,
    );
  }

  const surfaces = stub.__created.statusBarItems.map((i) =>
    JSON.stringify([i.text, i.tooltip?.value, i.accessibilityInformation]),
  );
  for (const [label, secret] of [
    ["API Key", API_KEY],
    ["用量 Token", USAGE_TOKEN],
  ]) {
    assert.deepEqual(
      surfaces.filter((s) => s.includes(secret)),
      [],
      `状态栏/tooltip 里泄漏了${label}`,
    );
  }
});

test("所有 subscription 可释放，deactivate() 不抛异常", () => {
  // 放在最后：释放之后状态就回不去了
  for (const d of state.context.subscriptions) {
    assert.doesNotThrow(() => d.dispose(), "dispose() 抛出异常");
  }
  assert.doesNotThrow(() => state.ext.deactivate(), "deactivate() 抛出异常");
});

// ---- 只有测 .vsix 时才有意义的打包内容检查 ----
// 这一段才是「.vscodeignore 配错了」的唯一防线：单测和 dist 模式都看不见它。
test("打包内容符合 .vscodeignore 的意图", { skip: TARGET !== "vsix" }, () => {
  const files = listFiles(state.root);

  const mustHave = ["package.json", "dist/extension.js", "images/icon.png"];
  const missing = mustHave.filter((f) => !files.includes(f));

  // 这三个 vsce 会改名，所以按 basename 大小写不敏感地找：
  // README.md → extension/readme.md、CHANGELOG.md → changelog.md、LICENSE → LICENSE.txt。
  // 它们是 Marketplace 页面正文/更新日志/许可证的渲染来源，缺了页面就是空的。
  const requiredByBasename = [
    [/^readme\.md$/i, "README.md"],
    [/^changelog\.md$/i, "CHANGELOG.md"],
    [/^license(\.txt|\.md)?$/i, "LICENSE"],
  ];
  for (const [pattern, label] of requiredByBasename) {
    const found = files.some((f) => pattern.test(path.basename(f)));
    if (!found) missing.push(`${label}（vsce 改名后也没找到）`);
  }

  assert.deepEqual(missing, [], `vsix 里缺这些文件：${missing.join(", ")}`);

  const forbiddenDirs = ["src", "out-test", "out", "node_modules", "scripts", ".vscode", ".git"];
  const strays = files.filter((f) => {
    const segments = f.split("/");
    if (segments.some((s) => forbiddenDirs.includes(s))) return true;
    if (f.endsWith(".map")) return true;
    if (f.endsWith(".ts") && !f.endsWith(".d.ts")) return true;
    return false;
  });
  assert.deepEqual(strays, [], `vsix 里混进了不该发布的文件：${strays.join(", ")}`);
});
