import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildUsageUrl,
  classifyEnvelope,
  fetchUsage,
  parseAmountTotals,
  parseCostTotals,
  usageWindow,
} from "../deepseek/usage";
import type { UsageResult } from "../deepseek/types";

/** 这个假 token 会出现在所有错误路径的输入里；断言它不出现在任何输出中。 */
const CANARY = "tok-CANARY1234567890";

const BASE = "http://127.0.0.1:8787";

async function withFetch<T>(impl: typeof fetch, run: () => Promise<T>): Promise<T> {
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
 * hold 定时器是必需的，不是保险起见：`AbortSignal.timeout` 内部的定时器是 unref
 * 的，它不会自己把事件循环撑住；真 fetch 挂着 socket 所以没这个问题，而这个假
 * fetch 不做任何 I/O——少了 hold，循环会直接空掉，那个定时器再没机会触发。后果
 * 不只是本用例失败：node:test 会以 "Promise resolution is still pending but the
 * event loop has already resolved" 把它连同同文件后续用例一起 cancel 掉。
 * Node 22（CI 锁的版本）上必现，Node 24 上侥幸不触发——别删。详见 client.test.ts。
 *
 * ⚠️ 与 client.test.ts 那份的关键差别：**必须先查 signal.aborted**。用量一次发
 * 两个请求、共用调用方同一个 signal，于是「第一个请求触发 abort」之后，第二个
 * 请求拿到的是一个**已经 aborted** 的 signal——此时 addEventListener 永远不会
 * 触发（事件早就派发完了），promise 会一直挂到 hold 超时。真 fetch 对已取消的
 * signal 是立即 reject 的，假 fetch 不模拟这一点就会假死。
 */
function pendingUntilAborted(
  init: RequestInit | undefined,
  onSetup?: () => void,
): Promise<Response> {
  const signal = init?.signal;
  return new Promise<Response>((_resolve, reject) => {
    const hold = setTimeout(() => {}, 60_000);
    const abort = () => {
      clearTimeout(hold);
      reject(new DOMException("aborted", "AbortError"));
    };
    if (signal?.aborted === true) {
      abort();
      return;
    }
    signal?.addEventListener("abort", abort);
    onSetup?.();
  });
}

function okEnvelope(bizData: unknown): unknown {
  return { code: 0, msg: "ok", data: { biz_code: 0, biz_msg: "", biz_data: bizData } };
}

const COST_BIZ = [
  {
    currency: "CNY",
    series: [
      {
        model: "deepseek-chat",
        // cost 是**字符串**，实测就是这样。
        buckets: [
          { time: 1789344000, cost: "1.5" },
          { time: 1789347600, cost: "2.25" },
        ],
      },
    ],
  },
];

const AMOUNT_BIZ = {
  bucket: 3600,
  series: [
    {
      model: "deepseek-chat & deepseek-reasoner",
      buckets: [
        {
          time: 1789344000,
          usage: {
            REQUEST: 3,
            RESPONSE_TOKEN: 100,
            PROMPT_CACHE_HIT_TOKEN: 40,
            PROMPT_CACHE_MISS_TOKEN: 60,
          },
        },
        {
          time: 1789347600,
          usage: {
            REQUEST: 2,
            RESPONSE_TOKEN: 50,
            PROMPT_CACHE_HIT_TOKEN: 10,
            PROMPT_CACHE_MISS_TOKEN: 20,
          },
        },
      ],
    },
  ],
};

/** 按 URL 分派 cost / amount 两个端点。任意一端缺失即视为 404。 */
function routeFetch(
  routes: { cost?: () => Response | Promise<Response>; amount?: () => Response | Promise<Response> },
): typeof fetch {
  return async (input) => {
    const url = String(input);
    const handler = url.includes("/cost?") ? routes.cost : routes.amount;
    if (handler === undefined) return new Response("not found", { status: 404 });
    return await handler();
  };
}

const call = (overrides: Partial<Parameters<typeof fetchUsage>[0]> = {}) =>
  fetchUsage({ token: CANARY, baseUrl: BASE, range: "today", ...overrides });

function assertNoSecret(result: UsageResult): void {
  assert.ok(
    !JSON.stringify(result).includes("CANARY"),
    `结果里泄漏了凭据：${JSON.stringify(result)}`,
  );
}

// ── URL 构造 ────────────────────────────────────────────────────────

test("buildUsageUrl：路径正确、tz 固定为 0、结尾斜杠不产生双斜杠", () => {
  assert.equal(
    buildUsageUrl("https://platform.deepseek.com", "cost", 100, 200),
    "https://platform.deepseek.com/api/v0/usage/by_api_key/cost?start=100&end=200&tz=0",
  );
  assert.equal(
    buildUsageUrl("https://platform.deepseek.com///", "amount", 100, 200),
    "https://platform.deepseek.com/api/v0/usage/by_api_key/amount?start=100&end=200&tz=0",
  );
});

// ── 窗口计算 ────────────────────────────────────────────────────────
//
// 周/月全部按 **UTC** 锚定，所以这些断言在任意本机时区下结果都一样——
// 这正是它们能当回归用的原因。

const SEC = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);

test("usageWindow/week：7 个 UTC 日，两端都是 UTC 零点", () => {
  const { start, end } = usageWindow("week", new Date("2026-09-14T15:32:10Z"));
  assert.equal(start, SEC("2026-09-08T00:00:00Z"));
  assert.equal(end, SEC("2026-09-15T00:00:00Z"));
  assert.equal((end - start) / 86400, 7);
  assert.equal(start % 86400, 0, "start 必须落在 UTC 零点");
  assert.equal(end % 86400, 0, "end 必须落在 UTC 零点");
});

test("usageWindow/week：跨月（近 7 天最常见的边界）", () => {
  const { start, end } = usageWindow("week", new Date("2026-10-03T12:00:00Z"));
  assert.equal(start, SEC("2026-09-27T00:00:00Z"), "跨月后 start 落在 9 月");
  assert.equal(end, SEC("2026-10-04T00:00:00Z"));
  assert.equal((end - start) / 86400, 7);
});

test("usageWindow/month：整月，两端都是 UTC 零点", () => {
  const { start, end } = usageWindow("month", new Date("2026-09-14T15:32:10Z"));
  assert.equal(start, SEC("2026-09-01T00:00:00Z"));
  assert.equal(end, SEC("2026-10-01T00:00:00Z"));
});

test("usageWindow/month：跨年（12 月）", () => {
  const { start, end } = usageWindow("month", new Date("2026-12-31T23:59:59Z"));
  assert.equal(start, SEC("2026-12-01T00:00:00Z"));
  assert.equal(end, SEC("2027-01-01T00:00:00Z"));
});

test("usageWindow/month：1 月（月界两侧）", () => {
  const first = usageWindow("month", new Date("2026-01-01T00:00:00Z"));
  assert.equal(first.start, SEC("2026-01-01T00:00:00Z"));
  assert.equal(first.end, SEC("2026-02-01T00:00:00Z"));

  const last = usageWindow("month", new Date("2026-01-31T23:00:00Z"));
  assert.equal(last.start, SEC("2026-01-01T00:00:00Z"));
  assert.equal(last.end, SEC("2026-02-01T00:00:00Z"));
});

/**
 * ⚠️ 这一条专门锁「锚点必须用 UTC 分量」。
 *
 * 这个 now 在 UTC+8 下是本地 10-01 03:00、而 UTC 还停在 09-30 19:00。若锚点写成
 * now.getMonth()/getDate()（本地分量 + Date.UTC 构造），算出来的零点会跑到
 * 10-01T00:00Z —— **比 now 还晚**，整个本月窗口落在未来、恒显示 0；近 7 天则丢掉
 * 窗口里最老的一天换成一整天未来的空桶。用 UTC 分量就不会。
 *
 * 在 UTC 本机时区下这条断言恒真（抓不到回归），但在 UTC+8/+9 等时区会红。
 */
test("usageWindow：本地日期已跨月但 UTC 还没跨时，锚点取 UTC 的那一天", () => {
  const now = new Date("2026-10-01T03:00:00+08:00");
  assert.equal(now.toISOString(), "2026-09-30T19:00:00.000Z", "前置：这个 now 确实跨了 UTC 日界");

  const month = usageWindow("month", now);
  assert.equal(month.start, SEC("2026-09-01T00:00:00Z"));
  assert.equal(month.end, SEC("2026-10-01T00:00:00Z"));
  assert.ok(month.start < now.getTime() / 1000, "窗口起点必须在过去");
  assert.ok(month.end > now.getTime() / 1000, "窗口终点必须在未来，否则「本月」是空的");

  const week = usageWindow("week", now);
  assert.equal(week.start, SEC("2026-09-24T00:00:00Z"));
  assert.equal(week.end, SEC("2026-10-01T00:00:00Z"));
  assert.ok(week.start < now.getTime() / 1000, "近 7 天的起点必须在过去");
});

test("usageWindow/today：整点、含 now、至少 1 小时、不超过 24 小时", () => {
  // 「今天」用本地日边界，所以不钉死具体值，改成断言在任何时区都必须成立的性质。
  // 这些样本刻意挑在日界与夏令时切换附近——整套用例要在多个 TZ 下各跑一遍才有意义
  // （见下方「跨时区」注释），单在 UTC 下跑等于没测。
  const samples = [
    "2026-01-01T00:00:00Z", // 恰好整点：窗口合法地以此刻收尾
    "2026-03-08T07:30:00Z", // 美国 DST 切换日附近
    "2026-06-15T23:59:59Z",
    "2026-09-14T15:32:10Z",
    "2026-10-25T01:30:00Z", // 欧洲 DST 回拨当日
    "2026-10-25T22:30:00Z", // 欧洲回拨日**最后一个小时**：这条会踩到 24h clamp
    "2026-12-31T23:30:00Z",
  ];
  for (const iso of samples) {
    const now = new Date(iso);
    const nowSec = Math.floor(now.getTime() / 1000);
    const { start, end } = usageWindow("today", now);
    const label = `${iso} → [${start}, ${end}]`;

    assert.equal(start % 3600, 0, `start 必须是整点：${label}`);
    assert.equal(end % 3600, 0, `end 必须是整点：${label}`);
    assert.ok(start <= nowSec, `start 不能在未来：${label}`);
    assert.ok(end - start >= 3600, `窗口至少 1 小时：${label}`);
    // 关键上界：>24h 的窗口要求两端对齐 UTC 零点，本地零点不满足，会被接口拒。
    // 夏令时回拨那天本地日有 25 小时，这条就是那个 clamp 的回归。
    assert.ok(end - start <= 86400, `窗口不能超过 24 小时：${label}`);

    // 窗口要覆盖此刻——**除非** 24h clamp 生效。回拨日最后那一小时会被主动砍掉
    // （代价换的是那一天不整个请求失败），所以这里只在「end 落在现在之前」时
    // 要求它必须恰好是 clamp 的结果，不给别的解释留口子。
    if (end < nowSec) {
      assert.equal(end, start + 86400, `只有 24h clamp 才允许窗口不覆盖此刻：${label}`);
    }
  }
});

test("usageWindow/today：恰好落在本地零点时，窗口仍有 1 小时", () => {
  const now = new Date(2026, 8, 14, 0, 0, 0, 0); // 本地时间的当月 14 日零点整
  const { start, end } = usageWindow("today", now);
  assert.equal(end - start, 3600);
  assert.ok(end > Math.floor(now.getTime() / 1000), "刚过零点也不能返回空窗口");
});

test("usageWindow/today：窗口起点不晚于本地零点（半时区最多前移 45 分钟）", () => {
  const now = new Date(2026, 8, 14, 15, 32, 10);
  const localMidnight = Math.floor(
    new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000,
  );
  const { start } = usageWindow("today", now);
  assert.ok(start <= localMidnight, "起点不能晚于本地零点，否则今日会少算");
  assert.ok(localMidnight - start < 3600, "为对齐整点最多前移不到 1 小时");
});

// ── 信封错误 ────────────────────────────────────────────────────────

test("classifyEnvelope：顶层 code 40002/40003 判为 expired", () => {
  for (const code of [40002, 40003]) {
    const error = classifyEnvelope({ code, msg: "Missing Token", data: null });
    assert.equal(error?.kind, "expired", `code=${code}`);
  }
});

test("classifyEnvelope：data.biz_code 40002/40003 同样判为 expired（信封第二处）", () => {
  for (const bizCode of [40002, 40003]) {
    const error = classifyEnvelope({ code: 0, data: { biz_code: bizCode } });
    assert.equal(error?.kind, "expired", `biz_code=${bizCode}`);
  }
});

test("classifyEnvelope：biz_code=1 是 INVALID_PARAM，不是鉴权失败", () => {
  // 这条是整轮探测最容易搞反的地方：1 是「我们把窗口算错了」，不是凭据问题。
  const error = classifyEnvelope({ code: 0, data: { biz_code: 1, biz_msg: "invalid param" } });
  assert.equal(error?.kind, "malformed");
  assert.ok(error?.message.includes("1"), "消息里要带上错误码，便于定位");
});

test("classifyEnvelope：正常信封返回 undefined", () => {
  assert.equal(classifyEnvelope({ code: 0, data: { biz_code: 0, biz_data: [] } }), undefined);
});

test("classifyEnvelope：data 为 null / 非对象 / 顶层非对象 → malformed", () => {
  assert.equal(classifyEnvelope({ code: 0, data: null })?.kind, "malformed");
  assert.equal(classifyEnvelope({ code: 0, data: "nope" })?.kind, "malformed");
  assert.equal(classifyEnvelope("nope")?.kind, "malformed");
  assert.equal(classifyEnvelope(null)?.kind, "malformed");
  assert.equal(classifyEnvelope([{ code: 0, data: {} }])?.kind, "malformed");
});

// ── 解析 ────────────────────────────────────────────────────────────

test("parseCostTotals：cost 是字符串，求和后转数字", () => {
  assert.deepEqual(parseCostTotals(COST_BIZ), { cost: 3.75, currency: "CNY" });
});

test("parseCostTotals：空数组 = 确实零消耗，不是结构错误", () => {
  assert.deepEqual(parseCostTotals([]), { cost: 0, currency: "CNY" });
});

test("parseCostTotals：currency 缺失时回退 CNY", () => {
  const totals = parseCostTotals([{ series: [{ buckets: [{ cost: 1 }] }] }]);
  assert.deepEqual(totals, { cost: 1, currency: "CNY" });
});

test("parseCostTotals：数组里有多个条目时全部累加，不只读 [0]", () => {
  // 只读 [0] 会静默漏掉后面的消耗——这是最难发现的一类错（数字看着正常，只是偏小）。
  const totals = parseCostTotals([
    { currency: "CNY", series: [{ buckets: [{ cost: "1" }] }] },
    { currency: "CNY", series: [{ buckets: [{ cost: "2" }] }] },
  ]);
  assert.deepEqual(totals, { cost: 3, currency: "CNY" });
});

test("parseCostTotals：条目之间币种不一致 → 结构不符，不给混合数字", () => {
  assert.equal(
    parseCostTotals([
      { currency: "CNY", series: [{ buckets: [{ cost: "1" }] }] },
      { currency: "USD", series: [{ buckets: [{ cost: "2" }] }] },
    ]),
    undefined,
  );
});

test("parseCostTotals：只有后面那条带 currency 也能取到", () => {
  assert.deepEqual(
    parseCostTotals([
      { series: [{ buckets: [{ cost: "1" }] }] },
      { currency: "USD", series: [{ buckets: [{ cost: "2" }] }] },
    ]),
    { cost: 3, currency: "USD" },
  );
});

test("parseCostTotals：cost 非数字判为结构不符，不静默当 0", () => {
  // ⚠️ 参考实现的 toFloat 会静默返回 0，于是「字段是 nope」与「真的零消耗」
  // 在下游完全不可区分——结构漂移会伪装成一份正常的零账单。这里必须能分辨。
  assert.equal(parseCostTotals([{ series: [{ buckets: [{ cost: "nope" }] }] }]), undefined);
  assert.equal(parseCostTotals([{ series: [{ buckets: [{ cost: "" }] }] }]), undefined);
  assert.equal(parseCostTotals([{ series: [{ buckets: [{}] }] }]), undefined);
  assert.equal(parseCostTotals([{ series: "nope" }]), undefined);
  assert.equal(parseCostTotals("nope"), undefined);
});

test("parseAmountTotals：四类分别累加，REQUEST 是请求次数不是 token", () => {
  assert.deepEqual(parseAmountTotals(AMOUNT_BIZ), {
    requests: 5,
    outputTokens: 150,
    cacheHitTokens: 50,
    cacheMissTokens: 80,
  });
});

test("parseAmountTotals：跨 series、跨 bucket 累加", () => {
  const biz = {
    series: [
      { buckets: [{ usage: { REQUEST: 1, RESPONSE_TOKEN: 2, PROMPT_CACHE_HIT_TOKEN: 3, PROMPT_CACHE_MISS_TOKEN: 4 } }] },
      { buckets: [{ usage: { REQUEST: 10, RESPONSE_TOKEN: 20, PROMPT_CACHE_HIT_TOKEN: 30, PROMPT_CACHE_MISS_TOKEN: 40 } }] },
    ],
  };
  assert.deepEqual(parseAmountTotals(biz), {
    requests: 11,
    outputTokens: 22,
    cacheHitTokens: 33,
    cacheMissTokens: 44,
  });
});

test("parseAmountTotals：空 series = 零用量", () => {
  assert.deepEqual(parseAmountTotals({ series: [] }), {
    requests: 0,
    outputTokens: 0,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
  });
});

test("parseAmountTotals：任意一个字段非数字 → 结构不符", () => {
  const fields = ["REQUEST", "RESPONSE_TOKEN", "PROMPT_CACHE_HIT_TOKEN", "PROMPT_CACHE_MISS_TOKEN"];
  for (const broken of fields) {
    const usage: Record<string, unknown> = {
      REQUEST: 1,
      RESPONSE_TOKEN: 2,
      PROMPT_CACHE_HIT_TOKEN: 3,
      PROMPT_CACHE_MISS_TOKEN: 4,
    };
    usage[broken] = "nope";
    assert.equal(
      parseAmountTotals({ series: [{ buckets: [{ usage }] }] }),
      undefined,
      `${broken} 非数字却没被拦下`,
    );
  }
});

test("parseAmountTotals：amount 没有 cost 那层 data[]/currency 包装", () => {
  // 实测两边形状不一致：cost 是数组且多一层，amount 的 series 直接挂在 biz_data 下。
  assert.equal(parseAmountTotals([{ series: [] }]), undefined);
  assert.equal(parseAmountTotals({ series: "nope" }), undefined);
  assert.equal(parseAmountTotals(null), undefined);
});

test("parseAmountTotals：model 是复合名也不影响累加（不拿 model 当分类维度）", () => {
  const biz = {
    series: [
      {
        model: "deepseek-chat & deepseek-reasoner",
        buckets: [{ usage: { REQUEST: 7, RESPONSE_TOKEN: 0, PROMPT_CACHE_HIT_TOKEN: 0, PROMPT_CACHE_MISS_TOKEN: 0 } }],
      },
    ],
  };
  assert.equal(parseAmountTotals(biz)?.requests, 7);
});

// ── fetchUsage ──────────────────────────────────────────────────────

test("成功路径：两次请求都带上 Bearer 与浏览器头，快照字段齐备", async () => {
  const seen: Array<{ url: string; headers: Record<string, string>; redirect: string | undefined }> = [];
  const result = await withFetch(
    async (input, init) => {
      seen.push({
        url: String(input),
        headers: init?.headers as Record<string, string>,
        redirect: init?.redirect,
      });
      const url = String(input);
      return jsonResponse(okEnvelope(url.includes("/cost?") ? COST_BIZ : AMOUNT_BIZ));
    },
    async () => call({ range: "month", now: new Date("2026-09-14T15:32:10Z") }),
  );

  assert.equal(seen.length, 2, "cost 与 amount 各发一次");
  for (const request of seen) {
    assert.equal(request.headers.authorization, `Bearer ${CANARY}`);
    assert.ok(request.headers["user-agent"]?.includes("Mozilla"), "带上浏览器 UA");
    assert.equal(request.headers.referer, "https://platform.deepseek.com/usage");
    // 会话过期时服务端很可能 302 到登录页；follow 会跨源跟过去丢掉 Authorization，
    // 然后把登录页 HTML 当响应体解析成 malformed——用户就看不到「已过期」了。
    assert.equal(request.redirect, "manual");
  }
  assert.ok(seen.some((r) => r.url.includes("/cost?")), "发了 cost");
  assert.ok(seen.some((r) => r.url.includes("/amount?")), "发了 amount");
  for (const request of seen) {
    assert.ok(request.url.includes(`start=${SEC("2026-09-01T00:00:00Z")}`), `start 是 UTC 月初：${request.url}`);
    assert.ok(request.url.includes(`end=${SEC("2026-10-01T00:00:00Z")}`), `end 是 UTC 下月初：${request.url}`);
    assert.ok(request.url.includes("tz=0"), "tz 恒为 0");
  }

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(
    {
      range: result.snapshot.range,
      start: result.snapshot.start,
      end: result.snapshot.end,
      currency: result.snapshot.currency,
      cost: result.snapshot.cost,
      requests: result.snapshot.requests,
      cacheHitTokens: result.snapshot.cacheHitTokens,
      cacheMissTokens: result.snapshot.cacheMissTokens,
      outputTokens: result.snapshot.outputTokens,
    },
    {
      range: "month",
      start: SEC("2026-09-01T00:00:00Z"),
      end: SEC("2026-10-01T00:00:00Z"),
      currency: "CNY",
      cost: 3.75,
      requests: 5,
      cacheHitTokens: 50,
      cacheMissTokens: 80,
      outputTokens: 150,
    },
  );
  assert.ok(result.snapshot.fetchedAt > 0);
  assert.ok(result.snapshot.endpoint.includes("/cost?"), "endpoint 是 cost 的地址");
  assert.ok(result.snapshot.endpoint.startsWith(BASE), "endpoint 不含凭据、只有 URL");
  assertNoSecret(result);
});

test("数组顺序不同不影响结果（解析器只求和、不按下标取）", async () => {
  // 实测确认服务端返回顺序会抖：同一 tz 连打三次，原文哈希三次都不同。
  // 用两份「同样的桶、相反的排列」各自算一遍，断言结果逐字段相同。
  const amount = (buckets: unknown[]) => ({
    bucket: 3600,
    series: [
      { model: "deepseek-chat", buckets: [buckets[0]] },
      { model: "deepseek-reasoner", buckets: [buckets[1]] },
    ],
  });
  const cost = (buckets: unknown[]) => [
    { currency: "CNY", series: [{ model: "deepseek-chat", buckets: [buckets[0]] }] },
    { currency: "CNY", series: [{ model: "deepseek-reasoner", buckets: [buckets[1]] }] },
  ];
  const costBuckets = [
    { time: 1789344000, cost: "1.5" },
    { time: 1789347600, cost: "2.25" },
  ];
  const amountBuckets = [
    { time: 1789344000, usage: { REQUEST: 3, RESPONSE_TOKEN: 100, PROMPT_CACHE_HIT_TOKEN: 40, PROMPT_CACHE_MISS_TOKEN: 60 } },
    { time: 1789347600, usage: { REQUEST: 2, RESPONSE_TOKEN: 50, PROMPT_CACHE_HIT_TOKEN: 10, PROMPT_CACHE_MISS_TOKEN: 20 } },
  ];

  const run = (order: "normal" | "reversed") =>
    withFetch(
      routeFetch({
        cost: () =>
          jsonResponse(
            okEnvelope(
              order === "normal" ? cost(costBuckets) : cost([...costBuckets].reverse()),
            ),
          ),
        amount: () =>
          jsonResponse(
            okEnvelope(
              order === "normal"
                ? amount(amountBuckets)
                : amount([...amountBuckets].reverse()),
            ),
          ),
      }),
      async () => call(),
    );

  const normal = await run("normal");
  const reversed = await run("reversed");
  assert.equal(normal.ok, true);
  assert.equal(reversed.ok, true);
  if (!normal.ok || !reversed.ok) return;

  const pick = (s: (typeof normal)["snapshot"]) => ({
    cost: s.cost,
    requests: s.requests,
    outputTokens: s.outputTokens,
    cacheHitTokens: s.cacheHitTokens,
    cacheMissTokens: s.cacheMissTokens,
  });
  assert.deepEqual(pick(reversed.snapshot), pick(normal.snapshot));
  assert.deepEqual(pick(normal.snapshot), {
    cost: 3.75,
    requests: 5,
    outputTokens: 150,
    cacheHitTokens: 50,
    cacheMissTokens: 80,
  });
});

test("信封 40002（第一处）→ expired", async () => {
  const result = await withFetch(
    routeFetch({ cost: () => jsonResponse({ code: 40002, msg: "Missing Token", data: null }) }),
    async () => call(),
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.kind, "expired");
  assertNoSecret(result);
});

test("信封 biz_code 40003（第二处）→ expired", async () => {
  const result = await withFetch(
    routeFetch({
      cost: () => jsonResponse(okEnvelope(COST_BIZ)),
      amount: () => jsonResponse({ code: 0, data: { biz_code: 40003 } }),
    }),
    async () => call(),
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.kind, "expired");
});

test("302 到登录页 → expired（redirect: manual 才看得见）", async () => {
  const result = await withFetch(
    routeFetch({
      cost: () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://platform.deepseek.com/sign_in" },
        }),
    }),
    async () => call(),
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.kind, "expired");
  assert.equal(result.error.httpStatus, 302);
});

test("401/403 → expired", async () => {
  for (const status of [401, 403]) {
    const result = await withFetch(
      routeFetch({ cost: () => new Response("nope", { status }) }),
      async () => call(),
    );
    assert.equal(result.ok, false, `HTTP ${status}`);
    if (result.ok) return;
    assert.equal(result.error.kind, "expired", `HTTP ${status}`);
    assert.equal(result.error.httpStatus, status);
  }
});

test("500 → http 并保留状态码", async () => {
  const result = await withFetch(
    routeFetch({
      cost: () => jsonResponse(okEnvelope(COST_BIZ)),
      amount: () => new Response("boom", { status: 500 }),
    }),
    async () => call(),
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.kind, "http");
  assert.equal(result.error.httpStatus, 500);
});

test("任一端失败即整体失败（不返回半份数据）", async () => {
  const result = await withFetch(
    routeFetch({
      cost: () => jsonResponse(okEnvelope(COST_BIZ)),
      amount: () => new Response("boom", { status: 503 }),
    }),
    async () => call(),
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.kind, "http");
  assert.equal(result.error.httpStatus, 503);
});

test("响应不是合法 JSON → malformed", async () => {
  const result = await withFetch(
    routeFetch({ cost: () => new Response("<html>portal</html>", { status: 200 }) }),
    async () => call(),
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.kind, "malformed");
  assertNoSecret(result);
});

test("cost 结构漂移 → malformed（且指明是消耗那一侧）", async () => {
  const result = await withFetch(
    routeFetch({
      cost: () => jsonResponse(okEnvelope([{ currency: "CNY", series: [{ buckets: [{ cost: "nope" }] }] }])),
      amount: () => jsonResponse(okEnvelope(AMOUNT_BIZ)),
    }),
    async () => call(),
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.kind, "malformed");
  assert.ok(result.error.message.includes("消耗"), "要能看出是哪一侧漂了");
});

test("amount 结构漂移 → malformed（且指明是 Token 那一侧）", async () => {
  const result = await withFetch(
    routeFetch({
      cost: () => jsonResponse(okEnvelope(COST_BIZ)),
      amount: () => jsonResponse(okEnvelope({ series: [{ buckets: [{ usage: { REQUEST: "nope" } }] }] })),
    }),
    async () => call(),
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.kind, "malformed");
  assert.ok(result.error.message.includes("Token"), "要能看出是哪一侧漂了");
});

test("biz_data 缺失 → malformed", async () => {
  const result = await withFetch(
    routeFetch({
      // 两端都注册，否则会先撞上 404、测成另一条分支（这条测试第一版就是这么错的）。
      cost: () => jsonResponse({ code: 0, data: { biz_code: 0 } }),
      amount: () => jsonResponse(okEnvelope(AMOUNT_BIZ)),
    }),
    async () => call(),
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.kind, "malformed");
});

test("网络异常 → network", async () => {
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

test("超时 → timeout", async () => {
  const result = await withFetch(
    async (_input, init) => pendingUntilAborted(init),
    async () => call({ timeoutMs: 20 }),
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.kind, "timeout");
  assertNoSecret(result);
});

test("调用方取消 → network（静默取消，不冒成用户可见的错误）", async () => {
  const controller = new AbortController();
  const result = await withFetch(
    async (_input, init) => pendingUntilAborted(init, () => controller.abort()),
    async () => call({ signal: controller.signal }),
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.kind, "network");
  assert.equal(result.error.message, "请求已取消。");
});

test("空 token → no-token，且一个请求都不发", async () => {
  let calls = 0;
  const result = await withFetch(
    async () => {
      calls += 1;
      return jsonResponse(okEnvelope(COST_BIZ));
    },
    async () => call({ token: "   " }),
  );
  assert.equal(calls, 0, "没有 token 就不该打网络");
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.kind, "no-token");
});

test("接口地址非法 → malformed，且不发请求", async () => {
  let calls = 0;
  const result = await withFetch(
    async () => {
      calls += 1;
      return jsonResponse(okEnvelope(COST_BIZ));
    },
    async () => call({ baseUrl: "not a url" }),
  );
  assert.equal(calls, 0);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.kind, "malformed");
  assertNoSecret(result);
});

test("baseUrl 可指向代理（本地 mock 用得上）", async () => {
  const seen: string[] = [];
  const result = await withFetch(
    async (input) => {
      seen.push(String(input));
      return jsonResponse(okEnvelope(String(input).includes("/cost?") ? COST_BIZ : AMOUNT_BIZ));
    },
    async () => call({ baseUrl: "http://127.0.0.1:9999/" }),
  );
  assert.equal(result.ok, true);
  assert.ok(seen.every((url) => url.startsWith("http://127.0.0.1:9999/api/")));
  if (!result.ok) return;
  assert.ok(result.snapshot.endpoint.startsWith("http://127.0.0.1:9999/"));
});

/**
 * canary 扫荡：把假 token 灌进**每一条**错误路径，断言它不出现在结果里。
 *
 * ⚠️ 这条测试单独看会给人假的安全感：它能通过，一半靠的是 usage.ts 里
 * describeThrown 的按值脱敏，另一半靠的是「消息只由固定中文串与数字拼成」。
 * 光扩 client.ts 的 redactSecrets 形状匹配是不够的——控制台 token 不是 sk- 形状，
 * 形状匹配抓不到它。
 */
const ERROR_PATHS: Array<[string, () => Response | Promise<Response>]> = [
  ["40002", () => jsonResponse({ code: 40002, msg: "Missing Token", data: null })],
  ["biz_code 40003", () => jsonResponse({ code: 0, data: { biz_code: 40003 } })],
  ["biz_code 1", () => jsonResponse({ code: 0, data: { biz_code: 1, biz_msg: "invalid param" } })],
  ["401", () => new Response(`unauthorized ${CANARY}`, { status: 401 })],
  ["500", () => new Response(`boom ${CANARY}`, { status: 500 })],
  ["302", () => new Response(null, { status: 302, headers: { location: "/sign_in" } })],
  ["非 JSON", () => new Response(`<html>${CANARY}</html>`, { status: 200 })],
  ["结构漂移", () => jsonResponse(okEnvelope("nope"))],
  [
    "抛出且消息含凭据",
    () => {
      throw new TypeError(`connect failed for Bearer ${CANARY}`);
    },
  ],
];

for (const [name, impl] of ERROR_PATHS) {
  test(`canary：${name} 的错误结果里不含凭据`, async () => {
    const result = await withFetch(
      async (input) => (String(input).includes("/cost?") ? impl() : impl()),
      async () => call(),
    );
    assert.equal(result.ok, false, `${name} 应当是失败`);
    assertNoSecret(result);
  });
}
