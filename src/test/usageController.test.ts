import assert from "node:assert/strict";
import { test } from "node:test";

import type { AppConfig } from "../config";
import { UsageController } from "../usageController";
import type { UsageView } from "../render";

/**
 * 控制器的门槛与 gate 逻辑全部可注入，所以这里能在纯 Node 下直接测——
 * 不需要 vscode 桩。它管的是「什么时候**不**发请求」，那几条恰恰是最容易写错、
 * 也最不容易在手工走查里发现的（多打一次私有接口没人看得出来）。
 */

const CONFIG: AppConfig = {
  baseUrl: "https://api.deepseek.com",
  refreshInterval: 5,
  currency: "AUTO",
  lowBalanceThreshold: 10,
  statusBarAlignment: "right",
  usageRange: "today",
};

const CANARY = "tok-CANARY1234567890";

// 这两个全局量在本文件里被每个用例替换，用完必须还原——否则一个用例的假 fetch
// 会漏进下一个用例，且 Date.now 不还原会污染同进程的其它测试文件。
const REAL_FETCH = globalThis.fetch;
const REAL_NOW = Date.now;

test.afterEach(() => {
  globalThis.fetch = REAL_FETCH;
  Date.now = REAL_NOW;
});

interface Harness {
  controller: UsageController;
  views: UsageView[];
  requests: string[];
  /** 每个请求带的 authorization 头，用来验证「用量打的是 userToken」。 */
  auths: string[];
  warnings: string[];
  setConfig: (overrides: Partial<AppConfig>) => void;
  /** 拨动假时钟，用来跨过陈旧门槛。只影响 Date.now()。 */
  setNow: (epochMs: number) => void;
}

function harness(
  options: {
    hasApiKey?: boolean;
    /** 显式传 undefined 表示「没有 Token」；不传则给一个 canary。 */
    token?: string | undefined;
    respond?: (url: string) => Response | Promise<Response>;
  } = {},
): Harness {
  let config = { ...CONFIG };
  let now = REAL_NOW();
  const views: UsageView[] = [];
  const requests: string[] = [];
  const auths: string[] = [];
  const warnings: string[] = [];

  Date.now = () => now;

  // 用 `typeof fetch` 标注、让参数走上下文推断：本仓库 tsconfig 的 lib 只有
  // ES2022（不带 DOM），RequestInfo/RequestInit 这些名字在这里不可见。
  const stub: typeof fetch = async (input, init) => {
    const url = String(input);
    requests.push(url);
    auths.push(String((init?.headers as Record<string, string> | undefined)?.authorization));
    return options.respond === undefined ? okResponse(url) : await options.respond(url);
  };
  globalThis.fetch = stub;

  const controller = new UsageController({
    getUsageToken: async () => ("token" in options ? options.token : CANARY),
    hasApiKey: async () => options.hasApiKey ?? true,
    getConfig: () => config,
    baseUrl: "http://127.0.0.1:8787",
    onView: (view) => views.push(view),
    debug: () => {},
    warn: (message) => warnings.push(message),
  });

  return {
    controller,
    views,
    requests,
    auths,
    warnings,
    setConfig: (overrides) => {
      config = { ...config, ...overrides };
    },
    setNow: (epochMs) => {
      now = epochMs;
    },
  };
}

function okResponse(url: string): Response {
  const bizData = url.includes("/cost?")
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
  return new Response(JSON.stringify({ code: 0, data: { biz_code: 0, biz_data: bizData } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** 信封里的鉴权失败：HTTP 200，错误码在 body.code。 */
function expiredResponse(): Response {
  return new Response(JSON.stringify({ code: 40002, msg: "Missing Token", data: null }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const last = (views: UsageView[]): UsageView => {
  const view = views.at(-1);
  assert.ok(view !== undefined, "没有任何视图被 emit");
  return view;
};

/** 等到微任务与宏任务都排空，给 void this.refresh(...) 那种不返回的调用用。 */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

test("未配置 API Key：一个请求都不发", async () => {
  // 这是隐私边界：no-key 态下 tooltip 不渲染用量段，此时轮询等于白打第三方主机。
  const h = harness({ hasApiKey: false });
  await h.controller.refresh("startup");
  assert.deepEqual(h.requests, []);
  assert.equal(last(h.views).kind, "unconfigured");
});

test("配了 API Key 但没配 Token：不发请求，显示未配置", async () => {
  const h = harness({ token: undefined });
  await h.controller.refresh("startup");
  assert.deepEqual(h.requests, []);
  assert.equal(last(h.views).kind, "unconfigured");
});

test("成功路径：cost 与 amount 各发一次，视图带上快照", async () => {
  const h = harness();
  await h.controller.refresh("startup");
  assert.equal(h.requests.length, 2);
  assert.ok(h.requests.some((url) => url.includes("/cost?")));
  assert.ok(h.requests.some((url) => url.includes("/amount?")));

  const view = last(h.views);
  assert.equal(view.kind, "ok");
  if (view.kind !== "ok") return;
  assert.equal(view.snapshot.cost, 1.25);
  assert.equal(view.snapshot.currency, "CNY");
  assert.equal(view.snapshot.requests, 3);
  assert.equal(view.snapshot.cacheHitTokens, 10);
  assert.equal(view.snapshot.cacheMissTokens, 20);
  assert.equal(view.snapshot.outputTokens, 40);
  assert.equal(view.snapshot.range, "today");
});

test("用量请求带的是 userToken，不是 API Key", async () => {
  // 两个凭据串用是这类扩展最严重的失误（把 API Key 发到控制台接口，或反过来），
  // 这里钉死用量侧发的是哪一个。
  const h = harness();
  await h.controller.refresh("startup");
  assert.equal(h.auths.length, 2);
  for (const auth of h.auths) assert.equal(auth, `Bearer ${CANARY}`);
});

test("timer / focus 触发在阈值内不重复发请求，过了阈值才重查", async () => {
  const h = harness();
  await h.controller.refresh("startup");
  assert.equal(h.requests.length, 2);

  // 刚查过，心跳与聚焦都该被陈旧门槛挡住（阈值 = max(2×5, 5) = 10 分钟）。
  await h.controller.refresh("timer");
  await h.controller.refresh("focus");
  assert.equal(h.requests.length, 2, "阈值内不该再打接口");

  // 门槛必须真的会开，否则就成了「只在启动查一次」的假轮询。
  h.setNow(Date.now() + 11 * 60_000);
  await h.controller.refresh("timer");
  assert.equal(h.requests.length, 4, "过了阈值该重查");
});

test("manual 触发一定重查（用户明确要新数据）", async () => {
  const h = harness();
  await h.controller.refresh("startup");
  await h.controller.refresh("manual");
  assert.equal(h.requests.length, 4);
});

test("refreshInterval 为 0：心跳与聚焦都不查，但启动那次照查", async () => {
  // 初版计划里写的 max(refreshInterval, 15) 就是在这里出错的：用户明确关掉后台
  // 刷新之后，仍然每 15 分钟被我们打一次私有接口。
  const h = harness();
  h.setConfig({ refreshInterval: 0 });
  await h.controller.refresh("startup");
  assert.equal(h.requests.length, 2, "启动要查一次，否则永远停在「正在获取」");

  // 拨很久也不该有事——0 的语义是关闭，不是「间隔很长」。
  h.setNow(Date.now() + 30 * 24 * 60 * 60_000);
  await h.controller.refresh("timer");
  await h.controller.refresh("focus");
  assert.equal(h.requests.length, 2, "关掉自动刷新后不该再有后台请求");

  // 但用户主动要的那几种仍然要生效。
  await h.controller.refresh("manual");
  assert.equal(h.requests.length, 4);
});

test("首次请求失败后，聚焦不会反复重打（门槛按「上次尝试」算）", async () => {
  const h = harness({
    respond: () => {
      throw new TypeError("fetch failed");
    },
  });
  await h.controller.refresh("startup");
  assert.equal(h.requests.length, 2);
  assert.equal(last(h.views).kind, "error");

  // 聚焦是高频动作。门槛若按「上次成功」算，这里 lastAttemptAt 恒为 0，
  // 每次聚焦都会判定过期 → 对着一个已知连不上的地址反复打。
  await h.controller.refresh("focus");
  await h.controller.refresh("focus");
  assert.equal(h.requests.length, 2, "失败后也不能每次聚焦都重打");
});

test("切换时间范围一定重查，且新窗口进了 URL", async () => {
  const h = harness();
  await h.controller.refresh("startup");
  const before = [...h.requests];

  h.setConfig({ usageRange: "month" });
  await h.controller.refresh("timer");
  assert.equal(h.requests.length, 4, "范围变了必须重查，哪怕没到陈旧阈值");

  const after = h.requests.slice(before.length);
  assert.ok(
    after.some((url) => !before.includes(url)),
    "新范围的窗口参数应当与旧的不同",
  );
  assert.notDeepEqual(after, before);
});

test("Token 过期：视图标成 expired，余额那边不受影响地照样成功", async () => {
  const h = harness({
    respond: (url) => (url.includes("/cost?") ? expiredResponse() : okResponse(url)),
  });
  await h.controller.refresh("startup");
  const view = last(h.views);
  assert.equal(view.kind, "error");
  if (view.kind !== "error") return;
  assert.equal(view.expired, true);
  assert.match(view.message, /已失效/);
  assert.deepEqual(h.warnings, [], "后台轮询遇到过期应当安静");
});

test("信封第二处的过期码也能认出来", async () => {
  const h = harness({
    respond: () =>
      new Response(JSON.stringify({ code: 0, data: { biz_code: 40003 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  });
  await h.controller.refresh("startup");
  const view = last(h.views);
  assert.equal(view.kind, "error");
  if (view.kind !== "error") return;
  assert.equal(view.expired, true);
});

test("只有手动刷新遇到 Token 过期时才提示，且同一枚 Token 只提示一次", async () => {
  const h = harness({ respond: () => expiredResponse() });

  await h.controller.refresh("startup");
  assert.deepEqual(h.warnings, [], "后台轮询不该弹提示");

  await h.controller.refresh("manual");
  assert.equal(h.warnings.length, 1, "手动刷新要告诉用户去换 Token");

  await h.controller.refresh("manual");
  assert.equal(h.warnings.length, 1, "同一枚 Token 不重复打扰");
});

test("普通网络错误连手动刷新也不弹提示", async () => {
  // 键盘上只有「过期」值得打扰用户；网络抖动弹窗会很快变成噪音，然后被无视。
  const h = harness({
    respond: () => {
      throw new TypeError("fetch failed");
    },
  });
  await h.controller.refresh("manual");
  assert.deepEqual(h.warnings, []);
  assert.equal(last(h.views).kind, "error");
});

test("解析失败也不会弹提示", async () => {
  const h = harness({
    respond: () =>
      new Response(JSON.stringify({ code: 0, data: { biz_code: 0, biz_data: { total: "nope" } } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  });
  await h.controller.refresh("manual");
  assert.deepEqual(h.warnings, []);
  const view = last(h.views);
  assert.equal(view.kind, "error");
  if (view.kind !== "error") return;
  assert.equal(view.expired, false);
});

test("在途时再次触发不会重复发请求（合流）", async () => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const h = harness({
    respond: async (url) => {
      await gate;
      return okResponse(url);
    },
  });

  const first = h.controller.refresh("startup");
  const second = h.controller.refresh("manual");
  release?.();
  await Promise.all([first, second]);

  assert.equal(h.requests.length, 2, "两次触发应当合成一次查询（cost + amount）");
});

test("dispose 后不再发请求、不再 emit", async () => {
  const h = harness();
  await h.controller.refresh("startup");
  const before = h.views.length;
  h.controller.dispose();
  await h.controller.refresh("manual");
  assert.equal(h.requests.length, 2);
  assert.equal(h.views.length, before);
});

test("dispose 落在请求在途时不会冒出一条用户可见的错误", async () => {
  // 这条是 client.ts:110-130「超时 vs 调用方取消」区分的回归点：漏掉的话
  // 关闭扩展/重新加载窗口会顺手甩一个红色提示出来。
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const h = harness({
    respond: async (url) => {
      await gate;
      return okResponse(url);
    },
  });

  const pending = h.controller.refresh("startup");
  h.controller.dispose();
  release?.();
  await pending;

  for (const view of h.views) {
    assert.notEqual(view.kind, "error", "取消不该被报成错误");
  }
});

test("真的被 abort 时也是静默的（走 abort 而非 disposed 分支）", async () => {
  const h = harness({
    respond: (_url) =>
      new Promise<Response>((_resolve, reject) => {
        // 不自己 abort 的话，假 fetch 永远不会结束；真实 fetch 会因 signal 抛错。
        setTimeout(() => reject(new DOMException("aborted", "AbortError")), 0);
      }),
  });
  const pending = h.controller.refresh("startup");
  h.controller.dispose();
  await pending;

  for (const view of h.views) {
    assert.notEqual(view.kind, "error");
  }
});

test("Token 变更后立刻重查，且不等陈旧门槛", async () => {
  const h = harness();
  await h.controller.refresh("startup");
  assert.equal(h.requests.length, 2);

  h.controller.onTokenChanged();
  await settle();
  assert.equal(h.requests.length, 4, "换了 Token 必须立刻重查");
});

test("Token 变更不会重复提示过期", async () => {
  const h = harness({ respond: () => expiredResponse() });
  await h.controller.refresh("manual");
  assert.equal(h.warnings.length, 1);

  // 换了一枚新 Token：如果它也是坏的，值得再提醒一次。
  h.controller.onTokenChanged();
  await settle();
  await h.controller.refresh("manual");
  assert.equal(h.warnings.length, 2, "换了 Token 之后应当重新允许提醒");
});

test("canary：任何视图与提示里都不出现 Token", async () => {
  const cases: Array<() => Response> = [
    okResponse.bind(null, "http://127.0.0.1:8787/api/v0/usage/by_api_key/cost?x=1"),
    expiredResponse,
    () =>
      new Response("<html>login</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    () => new Response("", { status: 500 }),
    () => new Response(JSON.stringify({ code: 0, data: null }), { status: 200 }),
  ];

  for (const respond of cases) {
    const h = harness({ respond });
    await h.controller.refresh("manual");
    const { controller, views, warnings } = h;
    const serialized = JSON.stringify({ views, warnings, view: controller.getView() });
    assert.ok(!serialized.includes(CANARY), `Token 泄漏进了 ${serialized}`);
  }
});

test("Token 是纯空白（storeUsageToken 已 trim，正常进不来）：不发请求，报错而非假装有数据", async () => {
  const h = harness({ token: "   " });
  await h.controller.refresh("startup");
  // 控制器只按 undefined 判「未配置」，纯空白会落到 fetchUsage，由它返回 no-token。
  // 关键是它**没有**打接口——空凭据发出去只会换回一个 40002，白留一条痕迹。
  assert.deepEqual(h.requests, []);
  assert.equal(last(h.views).kind, "error");
});
