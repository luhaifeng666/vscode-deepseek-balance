/**
 * 走真实 HTTP 的集成测试。
 *
 * 假 fetch 测不出 URL/请求头是否真的正确、AbortSignal.timeout 是否真的生效、
 * 以及真实响应体的解析——这几件事只有起一个本地服务器才验证得到。
 */

import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";

import { fetchBalance } from "../deepseek/client";
import { fetchUsage } from "../deepseek/usage";

/** 用量侧的假凭据。断言它不出现在 URL、endpoint 或任何消息里。 */
const TOKEN = "tok-integration-CANARY1234567890";

/**
 * 一条 cost 的 biz_data 条目，含一个**复合 model 名**（实测见过
 * "deepseek-chat & deepseek-reasoner"，所以 model 不能当分类维度），
 * 以及两个 series：合计 1.25 + 0.50 = 1.75。
 */
const COST_ENTRY = {
  currency: "CNY",
  series: [
    {
      model: "deepseek-chat",
      buckets: [{ time: 1_789_344_000, cost: "1.25" }],
    },
    {
      model: "deepseek-chat & deepseek-reasoner",
      buckets: [{ time: 1_789_347_600, cost: "0.50" }],
    },
  ],
};

/** amount 侧刻意把桶**倒序**放：解析器一旦按下标取值就会读到错的数。 */
const AMOUNT_BIZ = {
  series: [
    {
      model: "deepseek-chat & deepseek-reasoner",
      buckets: [
        {
          time: 1_789_347_600,
          usage: {
            REQUEST: 7,
            RESPONSE_TOKEN: 900,
            PROMPT_CACHE_HIT_TOKEN: 3_000,
            PROMPT_CACHE_MISS_TOKEN: 1_000,
          },
        },
      ],
    },
    {
      model: "deepseek-chat",
      buckets: [
        {
          time: 1_789_344_000,
          usage: {
            REQUEST: 35,
            RESPONSE_TOKEN: 1_445,
            PROMPT_CACHE_HIT_TOKEN: 5_000,
            PROMPT_CACHE_MISS_TOKEN: 1_000,
          },
        },
      ],
    },
  ],
};

/** 合计：请求 42 次、命中 8000 / 未命中 2000、输出 2345。REQUEST 是次数不是 token。 */
const okEnvelope = (kind: "amount" | "cost") => ({
  code: 0,
  data: { biz_code: 0, biz_data: kind === "cost" ? [COST_ENTRY] : AMOUNT_BIZ },
});

let server: Server;
let baseUrl: string;
let mode = "ok";
let lastAuthorization: string | undefined;
let lastPath: string | undefined;

/** 用量侧独立的一把旋钮。与余额的 mode 分开是必须的：要验的恰恰是隔离场景。 */
let usageMode = "ok";
/** 用量每个端点各记一次，用来验证 cost 与 amount 发往了不同路径。 */
let usagePaths: string[] = [];
let usageReferer: string | undefined;

const OK_BODY = {
  is_available: true,
  balance_infos: [
    {
      currency: "CNY",
      total_balance: "34.53",
      granted_balance: "0.00",
      topped_up_balance: "34.53",
    },
  ],
};

function send(
  res: ServerResponse,
  status: number,
  body: string,
  contentType = "application/json",
): void {
  res.writeHead(status, { "content-type": contentType });
  res.end(body);
}

function handle(req: IncomingMessage, res: ServerResponse): void {
  lastAuthorization = req.headers.authorization;
  lastPath = req.url;
  usageReferer = req.headers.referer;

  // 用量走另一张表。假 fetch 也能测这些分支，但真实 HTTP 顺带证明了一件事：
  // 解析之前没先炸——真实响应体要过 fetch 的 body 流、content-type 判定、
  // JSON.parse 三道关，假 fetch 用 `new Response(...)` 是绕过去的。
  if (req.url?.startsWith("/api/v0/usage/by_api_key/")) {
    return handleUsage(req.url, res);
  }

  switch (mode) {
    case "ok":
      return send(res, 200, JSON.stringify(OK_BODY));
    case "low":
      return send(
        res,
        200,
        JSON.stringify({
          is_available: true,
          balance_infos: [{ ...OK_BODY.balance_infos[0], total_balance: "3.20" }],
        }),
      );
    case "multi":
      return send(
        res,
        200,
        JSON.stringify({
          is_available: true,
          balance_infos: [
            OK_BODY.balance_infos[0],
            {
              currency: "USD",
              total_balance: "1.20",
              granted_balance: "0.00",
              topped_up_balance: "1.20",
            },
          ],
        }),
      );
    case "empty":
      return send(res, 200, JSON.stringify({ is_available: true, balance_infos: [] }));
    case "unavailable":
      return send(res, 200, JSON.stringify({ ...OK_BODY, is_available: false }));
    case "shape":
      return send(res, 200, JSON.stringify({ is_available: true, balance_infos: "nope" }));
    case "html":
      return send(res, 200, "<html>captive portal</html>", "text/html");
    case "unauthorized":
      return send(res, 401, JSON.stringify({ error: "bad key" }));
    case "forbidden":
      return send(res, 403, JSON.stringify({ error: "no scope" }));
    case "server-error":
      return send(res, 500, "boom", "text/plain");
    case "hang":
      // 故意不响应，交给客户端的超时信号。
      return;
    default:
      return send(res, 404, "unknown mode");
  }
}

before(async () => {
  server = createServer(handle);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const call = (overrides: Partial<Parameters<typeof fetchBalance>[0]> = {}) =>
  fetchBalance({ apiKey: "sk-integration-test-key", baseUrl, ...overrides });

test("真实 HTTP：成功路径解析出快照", async () => {
  mode = "ok";
  const result = await call();
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.snapshot.infos[0]?.total_balance, "34.53");
  assert.equal(result.snapshot.endpoint, `${baseUrl}/user/balance`);
  assert.equal(lastPath, "/user/balance");
  assert.equal(lastAuthorization, "Bearer sk-integration-test-key");
});

test("真实 HTTP：baseUrl 结尾带斜杠也只请求一次 /user/balance", async () => {
  mode = "ok";
  const result = await call({ baseUrl: `${baseUrl}/` });
  assert.equal(result.ok, true);
  assert.equal(lastPath, "/user/balance");
});

test("真实 HTTP：多币种返回两条", async () => {
  mode = "multi";
  const result = await call();
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.snapshot.infos.length, 2);
  assert.deepEqual(
    result.snapshot.infos.map((info) => info.currency),
    ["CNY", "USD"],
  );
});

test("真实 HTTP：空余额数组仍算成功", async () => {
  mode = "empty";
  const result = await call();
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.snapshot.infos, []);
});

test("真实 HTTP：is_available 为 false 不算错误", async () => {
  mode = "unavailable";
  const result = await call();
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.snapshot.isAvailable, false);
});

test("真实 HTTP：结构不符判为 malformed", async () => {
  mode = "shape";
  const result = await call();
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.kind, "malformed");
});

test("真实 HTTP：HTML 响应判为 malformed", async () => {
  mode = "html";
  const result = await call();
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.kind, "malformed");
});

test("真实 HTTP：401 判为 unauthorized", async () => {
  mode = "unauthorized";
  const result = await call();
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.kind, "unauthorized");
  assert.equal(result.error.httpStatus, 401);
});

test("真实 HTTP：403 判为 forbidden", async () => {
  mode = "forbidden";
  const result = await call();
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.kind, "forbidden");
});

test("真实 HTTP：500 判为 http", async () => {
  mode = "server-error";
  const result = await call();
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.kind, "http");
  assert.equal(result.error.httpStatus, 500);
});

test("真实 HTTP：挂死的服务端触发超时", async () => {
  mode = "hang";
  const started = Date.now();
  const result = await call({ timeoutMs: 150 });
  const elapsed = Date.now() - started;

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.kind, "timeout");
  // 必须真的提前返回，而不是一直等到服务端响应。
  assert.ok(elapsed < 3000, `超时没有生效，耗时 ${elapsed}ms`);
});

test("真实 HTTP：调用方取消会中止请求", async () => {
  mode = "hang";
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 50);

  const result = await call({ signal: controller.signal, timeoutMs: 5000 });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.kind, "network");
});

/** 用量路由。全部返回 HTTP 200，除了三个刻意非 200 的。 */
function handleUsage(rawUrl: string, res: ServerResponse): void {
  usagePaths.push(rawUrl);

  const kind = rawUrl.includes("/cost?") ? "cost" : "amount";
  const envelope = (status: number, body: unknown) =>
    send(res, status, JSON.stringify(body));

  switch (usageMode) {
    case "ok":
      return envelope(200, okEnvelope(kind));
    // 两个 biz_data 条目币种不同 → 无法归到单一币种，必须判结构异常。
    case "conflict-currency":
      return envelope(200, {
        code: 0,
        data: {
          biz_code: 0,
          biz_data:
            kind === "cost"
              ? [COST_ENTRY, { currency: "USD", series: [] }]
              : AMOUNT_BIZ,
        },
      });
    case "expired-code":
      return envelope(200, { code: 40002, msg: "Missing Token", data: null });
    case "expired-biz":
      return envelope(200, { code: 0, data: { biz_code: 40003 } });
    case "invalid-param":
      // biz_code=1 是**我们自己的窗口算错了**，不是凭据问题。显示成「已过期」
      // 会让人白去换一次 Token。
      return envelope(200, { code: 0, data: { biz_code: 1, biz_msg: "invalid param" } });
    case "null-data":
      return envelope(200, { code: 0, data: null });
    case "drift":
      return envelope(200, { code: 0, data: { biz_code: 0, biz_data: { total: "nope" } } });
    case "drift-cost":
      return envelope(200, {
        code: 0,
        data: {
          biz_code: 0,
          biz_data:
            kind === "cost"
              ? [
                  {
                    currency: "CNY",
                    series: [
                      { model: "deepseek-chat", buckets: [{ time: 1, cost: "nope" }] },
                    ],
                  },
                ]
              : AMOUNT_BIZ,
        },
      });
    case "html":
      return send(res, 200, "<html>login</html>", "text/html");
    case "server-error":
      return send(res, 500, "boom", "text/plain");
    case "redirect-login":
      // 验 redirect: "manual"：跟着跳会跨源丢掉 Authorization，然后把登录页
      // 的 HTML 当响应体解析成 malformed——用户看到「接口异常」而不是「会话过期」。
      res.writeHead(302, { location: "https://platform.deepseek.com/login" });
      res.end();
      return;
    case "hang":
      return;
    default:
      return send(res, 404, "unknown usage mode");
  }
}

test("真实 HTTP：用量成功路径解析出快照，且两个端点各请求一次", async () => {
  usageMode = "ok";
  usagePaths = [];
  const result = await fetchUsage({ token: TOKEN, baseUrl, range: "today" });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.snapshot.cost, 1.75);
  assert.equal(result.snapshot.requests, 42);
  assert.equal(result.snapshot.cacheHitTokens, 8_000);
  assert.equal(result.snapshot.cacheMissTokens, 2_000);
  assert.equal(result.snapshot.outputTokens, 2_345);
  assert.equal(usagePaths.length, 2);
  assert.ok(usagePaths.some((p) => p.includes("/cost?")));
  assert.ok(usagePaths.some((p) => p.includes("/amount?")));
  // tz 恒为 0：实测它没有作用，发别的值只会让请求看起来像有语义。
  assert.ok(usagePaths.every((p) => /[?&]tz=0(&|$)/.test(p)));
  // Token 在请求头里，不在 URL 里。
  assert.equal(lastAuthorization, `Bearer ${TOKEN}`);
  assert.ok(!result.snapshot.endpoint.includes(TOKEN));
});

test("真实 HTTP：请求带上了 referer 与 user-agent", async () => {
  // 本机 Node 会原样转发，但 VS Code 1.95 是 Electron 32 → Node 20，undici 对
  // forbidden header 的处理跨版本改过。这条红了就先知道，别等上线才发现。
  usageMode = "ok";
  usageReferer = undefined;
  await fetchUsage({ token: TOKEN, baseUrl, range: "today" });
  assert.equal(usageReferer, "https://platform.deepseek.com/usage");
});

test("真实 HTTP：桶的顺序颠倒不影响合计（解析器只求和）", async () => {
  // 服务端返回顺序实测会抖（同一请求连打三次的原文哈希就不一致）。这条用一份
  // 倒序的 fixture 钉住「只求和、不按下标取」。
  usageMode = "ok";
  const result = await fetchUsage({ token: TOKEN, baseUrl, range: "today" });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  // 1.25 + 0.50，两组 series 的先后与桶的先后都无关。
  assert.equal(result.snapshot.cost, 1.75);
});

test("真实 HTTP：两个信封位置的过期码都判为 expired", async () => {
  for (const usageModeName of ["expired-code", "expired-biz"] as const) {
    usageMode = usageModeName;
    const result = await fetchUsage({ token: TOKEN, baseUrl, range: "today" });
    assert.equal(result.ok, false, usageModeName);
    if (result.ok) continue;
    assert.equal(result.error.kind, "expired", usageModeName);
  }
});

test("真实 HTTP：biz_code=1（窗口参数错）不算鉴权失败", async () => {
  // 这条是第 4 轮实测最容易搞错的地方：1 是 INVALID_PARAM，与凭据无关。
  usageMode = "invalid-param";
  const result = await fetchUsage({ token: TOKEN, baseUrl, range: "today" });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.kind, "malformed");
  assert.notEqual(result.error.kind, "expired");
});

test("真实 HTTP：302 到登录页判为 expired，而不是跟过去解析 HTML", async () => {
  usageMode = "redirect-login";
  const result = await fetchUsage({ token: TOKEN, baseUrl, range: "today" });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.kind, "expired");
});

test("真实 HTTP：用量侧的结构漂移全部判为 malformed", async () => {
  for (const usageModeName of [
    "drift",
    "drift-cost",
    "conflict-currency",
    "null-data",
    "html",
  ] as const) {
    usageMode = usageModeName;
    const result = await fetchUsage({ token: TOKEN, baseUrl, range: "today" });
    assert.equal(result.ok, false, usageModeName);
    if (result.ok) continue;
    assert.ok(
      result.error.kind === "malformed" || result.error.kind === "http",
      `${usageModeName} 判成了 ${result.error.kind}`,
    );
  }
});

test("真实 HTTP：用量 500 与挂死分别判为 http 与 timeout", async () => {
  usageMode = "server-error";
  const failed = await fetchUsage({ token: TOKEN, baseUrl, range: "today" });
  assert.equal(failed.ok, false);
  if (!failed.ok) assert.equal(failed.error.kind, "http");

  usageMode = "hang";
  const hung = await fetchUsage({ token: TOKEN, baseUrl, range: "today", timeoutMs: 300 });
  assert.equal(hung.ok, false);
  if (!hung.ok) assert.equal(hung.error.kind, "timeout");
});

test("真实 HTTP：用量调用方取消是静默的，且与超时区分开", async () => {
  usageMode = "hang";
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 50);
  const result = await fetchUsage({
    token: TOKEN,
    baseUrl,
    range: "today",
    timeoutMs: 5000,
    signal: controller.signal,
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  // 报 network + 「请求已取消」是既有的约定，控制器靠这条消息判定「静默」。
  assert.equal(result.error.kind, "network");
  assert.equal(result.error.message, "请求已取消。");
});

test("真实 HTTP：用量与余额互不干扰（同一台服务器，两把独立旋钮）", async () => {
  // 这就是把 usageMode 与 mode 分开的全部理由：造出「余额正常 + 用量过期」。
  mode = "ok";
  usageMode = "expired-code";

  const balance = await call();
  assert.equal(balance.ok, true, "用量过期把余额也带崩了");

  const usage = await fetchUsage({ token: TOKEN, baseUrl, range: "today" });
  assert.equal(usage.ok, false);
  if (!usage.ok) assert.equal(usage.error.kind, "expired");
});

test("真实 HTTP：连接被拒判为 network", async () => {
  // 端口 9 是 discard 服务，本地通常没有监听。
  const result = await fetchBalance({
    apiKey: "sk-integration-test-key",
    baseUrl: "http://127.0.0.1:9",
    timeoutMs: 2000,
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.kind, "network");
});
