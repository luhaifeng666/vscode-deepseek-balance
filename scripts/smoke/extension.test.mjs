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
  stored: new Map([[`deepseekBalance.apiKey`, API_KEY]]),
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
  state.server = createServer((req, res) => {
    // 顺带验一件事：密钥确实以 Bearer 头发出去了
    if (req.url !== "/user/balance" || req.headers.authorization !== `Bearer ${API_KEY}`) {
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
  });
  await new Promise((r) => state.server.listen(0, "127.0.0.1", r));
  stub.__configStore["deepseekBalance.baseUrl"] =
    `http://127.0.0.1:${state.server.address().port}`;

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

test("「清除 API Key」回到未配置态，且密钥真的从 SecretStorage 删掉了", async () => {
  await stub.commands.registered.get("deepseekBalance.clearApiKey")();
  await settle();
  assert.equal(state.stored.has("deepseekBalance.apiKey"), false, "密钥仍在 SecretStorage 里");
  const { text } = stub.__created.statusBarItems[0];
  assert.ok(!/\d/.test(text), `清除密钥后状态栏仍显示数字：${text}`);
  assert.match(text, /DeepSeek/, `清除密钥后状态栏文案不符：${text}`);
});

test("日志与状态栏里都没有出现过密钥", () => {
  const logs = stub.__created.outputChannels.flatMap((c) => c.lines.map(([, m]) => String(m)));
  assert.ok(logs.length > 0, "输出通道一行日志都没有");
  const leaked = logs.filter((l) => l.includes(API_KEY));
  assert.deepEqual(leaked, [], "日志里泄漏了密钥");

  const surfaces = stub.__created.statusBarItems.map((i) =>
    JSON.stringify([i.text, i.tooltip?.value, i.accessibilityInformation]),
  );
  assert.deepEqual(
    surfaces.filter((s) => s.includes(API_KEY)),
    [],
    "状态栏/tooltip 里泄漏了密钥",
  );
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
