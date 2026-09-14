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

let server: Server;
let baseUrl: string;
let mode = "ok";
let lastAuthorization: string | undefined;
let lastPath: string | undefined;

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
