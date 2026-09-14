import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildBalanceUrl,
  classifyHttpStatus,
  fetchBalance,
  redactSecrets,
} from "../deepseek/client";
import type { BalanceResult } from "../deepseek/types";

/** 这个假密钥会出现在所有错误路径的输入里；断言它不出现在任何输出中。 */
const CANARY = "sk-CANARY1234567890";

async function withFetch<T>(
  impl: typeof fetch,
  run: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * 一个「一直挂着、只在 abort 时 reject」的假响应，用来观察取消行为。
 *
 * 那个 hold 定时器是必需的，不是保险起见：`AbortSignal.timeout` 内部的定时器是
 * **unref** 的（实测：注册后进程 1ms 就退出了，普通 setTimeout 则撑满 300ms），
 * 它不会自己把事件循环撑住。真 fetch 挂着 socket，所以没这个问题；而这个假 fetch
 * 不做任何 I/O —— 少了 hold，循环会直接空掉，那个 unref 定时器再没机会触发。
 * 后果不只是本用例失败：node:test 会以
 * "Promise resolution is still pending but the event loop has already resolved"
 * 把它连同同文件后续用例一起 cancel 掉。
 *
 * 这在 Node 22 上必现（CI 锁的版本），Node 24 上侥幸不触发 —— 所以别删。
 */
function pendingUntilAborted(
  init: RequestInit | undefined,
  onSetup?: () => void,
): Promise<Response> {
  const signal = init?.signal;
  return new Promise<Response>((_resolve, reject) => {
    const hold = setTimeout(() => {}, 60_000); // 顶替真 fetch 持有的那个 socket
    signal?.addEventListener("abort", () => {
      clearTimeout(hold);
      reject(new DOMException("aborted", "AbortError"));
    });
    onSetup?.();
  });
}

const OK_BODY = {
  is_available: true,
  balance_infos: [
    {
      currency: "CNY",
      total_balance: "110.00",
      granted_balance: "10.00",
      topped_up_balance: "100.00",
    },
  ],
};

const call = (overrides: Partial<Parameters<typeof fetchBalance>[0]> = {}) =>
  fetchBalance({
    apiKey: CANARY,
    baseUrl: "https://api.deepseek.com",
    ...overrides,
  });

function assertNoSecret(result: BalanceResult): void {
  assert.ok(
    !JSON.stringify(result).includes("CANARY"),
    `结果里泄漏了密钥：${JSON.stringify(result)}`,
  );
}

test("classifyHttpStatus：401 是 unauthorized", () => {
  assert.equal(classifyHttpStatus(401), "unauthorized");
});

test("classifyHttpStatus：403 是 forbidden", () => {
  assert.equal(classifyHttpStatus(403), "forbidden");
});

test("classifyHttpStatus：其余非 2xx 归为 http", () => {
  assert.equal(classifyHttpStatus(429), "http");
  assert.equal(classifyHttpStatus(500), "http");
});

test("buildBalanceUrl：baseUrl 结尾的斜杠不会产生双斜杠", () => {
  assert.equal(
    buildBalanceUrl("https://api.deepseek.com/"),
    "https://api.deepseek.com/user/balance",
  );
  assert.equal(
    buildBalanceUrl("https://api.deepseek.com///"),
    "https://api.deepseek.com/user/balance",
  );
});

test("成功路径：解析出快照与生效地址", async () => {
  const result = await withFetch(
    async () => jsonResponse(OK_BODY),
    async () => call(),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.snapshot.isAvailable, true);
  assert.equal(result.snapshot.infos.length, 1);
  assert.equal(result.snapshot.endpoint, "https://api.deepseek.com/user/balance");
  assert.ok(result.snapshot.fetchedAt > 0);
  assertNoSecret(result);
});

test("成功路径：baseUrl 可指向代理", async () => {
  const result = await withFetch(
    async () => jsonResponse(OK_BODY),
    async () => call({ baseUrl: "http://127.0.0.1:8787" }),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.snapshot.endpoint, "http://127.0.0.1:8787/user/balance");
});

test("请求带上 Bearer 头与 Accept", async () => {
  let captured: RequestInit | undefined;
  await withFetch(
    async (_input, init) => {
      captured = init;
      return jsonResponse(OK_BODY);
    },
    async () => call(),
  );
  const headers = captured?.headers as Record<string, string>;
  assert.equal(headers.Authorization, `Bearer ${CANARY}`);
  assert.equal(headers.Accept, "application/json");
});

test("401 映射为 unauthorized 且不泄漏密钥", async () => {
  const result = await withFetch(
    async () => new Response("unauthorized", { status: 401 }),
    async () => call(),
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.kind, "unauthorized");
  assert.equal(result.error.httpStatus, 401);
  assertNoSecret(result);
});

test("403 映射为 forbidden", async () => {
  const result = await withFetch(
    async () => new Response("forbidden", { status: 403 }),
    async () => call(),
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.kind, "forbidden");
});

test("500 映射为 http 并保留状态码", async () => {
  const result = await withFetch(
    async () => new Response("boom", { status: 500 }),
    async () => call(),
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.kind, "http");
  assert.equal(result.error.httpStatus, 500);
});

test("网络异常映射为 network 且不泄漏密钥", async () => {
  const result = await withFetch(
    async () => {
      throw new TypeError("fetch failed");
    },
    async () => call(),
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.kind, "network");
  assertNoSecret(result);
});

test("超时映射为 timeout", async () => {
  const result = await withFetch(
    async (_input, init) => pendingUntilAborted(init),
    async () => call({ timeoutMs: 20 }),
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.kind, "timeout");
  assertNoSecret(result);
});

test("调用方取消映射为 network（静默取消）", async () => {
  const controller = new AbortController();
  const result = await withFetch(
    async (_input, init) => pendingUntilAborted(init, () => controller.abort()),
    async () => call({ signal: controller.signal }),
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.kind, "network");
});

test("响应不是合法 JSON 时判为 malformed", async () => {
  const result = await withFetch(
    async () => new Response("<html>portal</html>", { status: 200 }),
    async () => call(),
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.kind, "malformed");
  assertNoSecret(result);
});

test("is_available 缺失或类型错误时判为 malformed", async () => {
  const result = await withFetch(
    async () => jsonResponse({ is_available: "true", balance_infos: [] }),
    async () => call(),
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.kind, "malformed");
});

test("balance_infos 缺失时按空数组处理（对齐 dsh-balance 的 ?? []）", async () => {
  const result = await withFetch(
    async () => jsonResponse({ is_available: true }),
    async () => call(),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.snapshot.infos, []);
});

test("balance_infos 不是数组时判为 malformed", async () => {
  const result = await withFetch(
    async () => jsonResponse({ is_available: true, balance_infos: "nope" }),
    async () => call(),
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.kind, "malformed");
});

test("balance_infos 元素结构不对时判为 malformed", async () => {
  const result = await withFetch(
    async () => jsonResponse({ is_available: true, balance_infos: [{ currency: 1 }] }),
    async () => call(),
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.kind, "malformed");
});

test("is_available 为 false 不算错误，仍然返回快照", async () => {
  const result = await withFetch(
    async () => jsonResponse({ ...OK_BODY, is_available: false }),
    async () => call(),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.snapshot.isAvailable, false);
  assert.equal(result.snapshot.infos.length, 1);
});

test("接口地址非法时判为 malformed", async () => {
  const result = await call({ baseUrl: "not a url" });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.kind, "malformed");
  assertNoSecret(result);
});

test("redactSecrets：抹掉 sk- 形式的密钥", () => {
  assert.equal(
    redactSecrets(`failed with ${CANARY} while connecting`),
    "failed with sk-*** while connecting",
  );
});

test("redactSecrets：没有密钥时原样返回", () => {
  assert.equal(redactSecrets("plain message"), "plain message");
});
