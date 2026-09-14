#!/usr/bin/env node
/**
 * 本地 DeepSeek 余额接口的假实现，用于手动走查那些对着真实 API 无法按需复现的分支
 * （余额不可用、空余额、非 JSON、401/403、超时……）。
 *
 *   node scripts/mock-balance.mjs            # 默认 8787 端口
 *   PORT=9000 node scripts/mock-balance.mjs
 *
 * 然后把它当作 baseUrl：
 *   在 VS Code 设置里把 deepseekBalance.baseUrl 改成 http://127.0.0.1:8787
 *
 * 切换模式（curl 一下就生效，无需重启）：
 *   curl http://127.0.0.1:8787/mode/low
 *
 * 可用模式见下面的 MODES。
 */

import { createServer } from "node:http";

const PORT = Number(process.env.PORT ?? 8787);

const CNY = {
  currency: "CNY",
  total_balance: "34.53",
  granted_balance: "0.00",
  topped_up_balance: "34.53",
};

const USD = {
  currency: "USD",
  total_balance: "1.20",
  granted_balance: "0.00",
  topped_up_balance: "1.20",
};

const MODES = {
  ok: { status: 200, body: { is_available: true, balance_infos: [CNY] } },
  low: {
    status: 200,
    body: { is_available: true, balance_infos: [{ ...CNY, total_balance: "3.20" }] },
  },
  multi: { status: 200, body: { is_available: true, balance_infos: [CNY, USD] } },
  empty: { status: 200, body: { is_available: true, balance_infos: [] } },
  unavailable: { status: 200, body: { is_available: false, balance_infos: [CNY] } },
  "malformed-shape": {
    status: 200,
    body: { is_available: true, balance_infos: "nope" },
  },
  "malformed-json": { status: 200, raw: "<html>captive portal</html>", type: "text/html" },
  unauthorized: { status: 401, body: { error: "invalid api key" } },
  forbidden: { status: 403, body: { error: "missing scope" } },
  "server-error": { status: 500, raw: "boom", type: "text/plain" },
  timeout: { hang: true },
};

let mode = process.env.MODE ?? "ok";

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

  if (url.pathname.startsWith("/mode/")) {
    const next = url.pathname.slice("/mode/".length);
    if (!(next in MODES)) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `未知模式：${next}`, available: Object.keys(MODES) }));
      return;
    }
    mode = next;
    console.log(`[mock] 模式切换为 ${mode}`);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ mode }));
    return;
  }

  if (url.pathname !== "/user/balance") {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
    return;
  }

  const preset = MODES[mode] ?? MODES.ok;
  console.log(`[mock] GET /user/balance (${mode})`);

  if (preset.hang) return; // 故意不响应，用于验证客户端超时

  res.writeHead(preset.status, {
    "content-type": preset.type ?? "application/json",
  });
  res.end(preset.raw ?? JSON.stringify(preset.body));
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[mock] DeepSeek 余额假接口已启动：http://127.0.0.1:${PORT}/user/balance`);
  console.log(`[mock] 当前模式：${mode}（可切换到：${Object.keys(MODES).join(", ")}）`);
  console.log(`[mock] 切换示例：curl http://127.0.0.1:${PORT}/mode/low`);
});
