#!/usr/bin/env node
/**
 * 本地 DeepSeek 假接口：同时服务**余额**与**用量**两条链路，用于手动走查那些对着
 * 真实 API 无法按需复现的分支（余额不可用、401/403、超时、会话过期、结构漂移……）。
 *
 *   node scripts/mock-balance.mjs            # 默认 8787 端口
 *   PORT=9000 node scripts/mock-balance.mjs
 *
 * 两个旋钮**互相独立**，这是刻意的：用量要验的恰恰是「余额正常 + 用量过期」这种
 * **隔离**场景，共用一个 mode 就永远造不出来。
 *
 *   余额：curl http://127.0.0.1:8787/mode/low
 *   用量：curl http://127.0.0.1:8787/usage-mode/usage-expired
 *
 * 接线方式（两条链路的地址来源不同，别只改一个）：
 *   余额 —— VS Code 设置里把 deepseekBalance.baseUrl 改成 http://127.0.0.1:8787
 *   用量 —— 它有**不是配置项**的硬理由（请求头上挂着控制台会话凭据，一个能指向任意
 *          主机的开关就是一条把凭据送出去的通道），所以只能从环境变量注入回环地址。
 *          最省事的办法：用仓库里现成的那个启动配置
 *            .vscode/launch.json → 「运行扩展（用量指向本地 mock）」
 *          它已经把 DEEPSEEK_USAGE_BASE_URL 设成 http://127.0.0.1:8787 了。
 *          命令行等价写法：
 *            DEEPSEEK_USAGE_BASE_URL=http://127.0.0.1:8787 code --extensionDevelopmentPath=...
 *          resolveUsageBaseUrl 只放行 localhost/127.0.0.1/[::1]，填别的会被静默换回
 *          官方地址。
 */

import { createHash } from "node:crypto";
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

// ── 余额 ─────────────────────────────────────────────────────────────

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

// ── 用量 ─────────────────────────────────────────────────────────────
//
// 除 usage-500 / usage-302 / usage-hang 外**全部返回 HTTP 200**，专打
// 「只看 HTTP 状态码就会误判成功」这条路径——真实接口的鉴权失败就是 HTTP 200 +
// 信封里的 40002/40003。

/** 一条 cost 的 biz_data：刻意给两个 series、并让第二个排在前面的桶更小。 */
const COST_BIZ = [
  {
    currency: "CNY",
    series: [
      { model: "deepseek-chat", buckets: [{ time: 1_789_344_000, cost: "1.25" }] },
      // 复合 model 名是实测见过的，不能拿 model 当分类维度。
      {
        model: "deepseek-chat & deepseek-reasoner",
        buckets: [{ time: 1_789_347_600, cost: "0.50" }],
      },
    ],
  },
];

/** 同一条 amount，但把桶的顺序颠倒过来——用来验证解析器只求和、不按下标取。 */
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

const ZERO_COST = [{ currency: "CNY", series: [{ model: "deepseek-chat", buckets: [] }] }];
const ZERO_AMOUNT = { series: [{ model: "deepseek-chat", buckets: [] }] };

/** cost 是字符串类型但内容不是数字：应判「结构异常」，不能静默当成 0。 */
const DRIFT_COST_NUMBERISH = [
  { currency: "CNY", series: [{ model: "deepseek-chat", buckets: [{ time: 1, cost: "nope" }] }] },
];

const USAGE_MODES = {
  /** 正常：cost 合计 1.75，请求 42 次、命中 8000 / 未命中 2000、输出 2345。 */
  ok: { cost: COST_BIZ, amount: AMOUNT_BIZ },

  /** 真的零消耗。与下面的结构漂移必须**看起来不一样**——这正是 toFloat 的坑。 */
  zero: { cost: ZERO_COST, amount: ZERO_AMOUNT },

  /** 结构漂移：biz_data 不是数组。应显示「结构异常」，不是「0」。 */
  drift: {
    cost: { total: "nope" },
    amount: { series: "nope" },
  },

  /** cost 字段存在但是 "nope"。参考实现会静默返回 0，本实现必须判结构异常。 */
  "drift-cost": { cost: DRIFT_COST_NUMBERISH, amount: AMOUNT_BIZ },

  /** 两个 biz_data 条目币种不一致 → 无法给单一币种，应判结构异常。 */
  "drift-currency": {
    cost: [COST_BIZ[0], { currency: "USD", series: [] }],
    amount: AMOUNT_BIZ,
  },

  /** 会话过期，信封第一处（body.code）。 */
  expired: { envelope: { code: 40002, msg: "Missing Token", data: null } },

  /** 会话过期，信封第二处（data.biz_code）。两处都要覆盖。 */
  "expired-biz": { envelope: { code: 0, data: { biz_code: 40003 } } },

  /**
   * biz_code=1 INVALID_PARAM。**这不是鉴权失败**，它是我们自己的窗口参数算错了。
   * 第 4 轮实测就在这儿最容易误判：显示「Token 已过期」会让人白去换一次 Token。
   */
  "invalid-param": {
    envelope: { code: 0, data: { biz_code: 1, biz_msg: "invalid param" } },
  },

  /** data 直接是 null。 */
  "null-data": { envelope: { code: 0, data: null } },

  /** 非 JSON。 */
  html: { raw: "<html>login</html>", type: "text/html", status: 200 },

  /** 服务端错误。 */
  "server-error": { status: 500, raw: "boom", type: "text/plain" },

  /** 302 到登录页：验 redirect: "manual" 是否真的拦住了跨源跳转。 */
  "redirect-login": { status: 302, location: "https://platform.deepseek.com/login" },

  /** 故意不响应，验客户端超时（15 秒，见 usage.ts 的 DEFAULT_TIMEOUT_MS）。 */
  hang: { hang: true },
};

let mode = process.env.MODE ?? "ok";
let usageMode = process.env.USAGE_MODE ?? "ok";

/** 只留前 8 位指纹。走查时要的是「两个请求带的是不是同一枚凭据」，不是凭据本身。 */
function fingerprint(header) {
  if (typeof header !== "string" || header === "") return "(无)";
  return createHash("sha256").update(header).digest("hex").slice(0, 8);
}

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function serveUsage(req, res, url) {
  const kind = url.pathname.endsWith("/cost") ? "cost" : "amount";
  const preset = USAGE_MODES[usageMode] ?? USAGE_MODES.ok;
  console.log(
    `[mock] GET ${url.pathname}${url.search} (usage-mode=${usageMode}) ` +
      `auth=${fingerprint(req.headers.authorization)}`,
  );

  if (preset.hang) return; // 故意不响应

  if (preset.envelope !== undefined) {
    json(res, preset.status ?? 200, preset.envelope);
    return;
  }
  if (preset.raw !== undefined) {
    res.writeHead(preset.status ?? 200, { "content-type": preset.type ?? "application/json" });
    res.end(preset.raw);
    return;
  }

  json(res, 200, {
    code: 0,
    data: {
      biz_code: 0,
      biz_data: kind === "cost" ? preset.cost : preset.amount,
    },
  });
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

  if (url.pathname.startsWith("/usage-mode/")) {
    const next = url.pathname.slice("/usage-mode/".length);
    if (!(next in USAGE_MODES)) {
      json(res, 404, { error: `未知用量模式：${next}`, available: Object.keys(USAGE_MODES) });
      return;
    }
    usageMode = next;
    console.log(`[mock] 用量模式切换为 ${usageMode}`);
    json(res, 200, { usageMode });
    return;
  }

  if (url.pathname.startsWith("/mode/")) {
    const next = url.pathname.slice("/mode/".length);
    if (!(next in MODES)) {
      json(res, 404, { error: `未知模式：${next}`, available: Object.keys(MODES) });
      return;
    }
    mode = next;
    console.log(`[mock] 余额模式切换为 ${mode}`);
    json(res, 200, { mode });
    return;
  }

  if (url.pathname.startsWith("/api/v0/usage/by_api_key/")) {
    // 用量只认 userToken。这里不比对具体值（mock 不该知道真凭据），只把它和余额
    // 请求的头分开记指纹——两个指纹不同，就证明没有串用。
    serveUsage(req, res, url);
    return;
  }

  if (url.pathname !== "/user/balance") {
    json(res, 404, { error: "not found" });
    return;
  }

  const preset = MODES[mode] ?? MODES.ok;
  console.log(
    `[mock] GET /user/balance (mode=${mode}) auth=${fingerprint(req.headers.authorization)}`,
  );

  if (preset.hang) return; // 故意不响应，用于验证客户端超时

  if (preset.raw !== undefined) {
    res.writeHead(preset.status, { "content-type": preset.type ?? "application/json" });
    res.end(preset.raw);
    return;
  }
  json(res, preset.status, preset.body);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[mock] 假接口已启动：http://127.0.0.1:${PORT}`);
  console.log(`[mock]   余额  GET /user/balance`);
  console.log(`[mock]   用量  GET /api/v0/usage/by_api_key/{cost,amount}?start=&end=&tz=0`);
  console.log(`[mock] 余额模式：${mode}（${Object.keys(MODES).join(", ")}）`);
  console.log(`[mock] 用量模式：${usageMode}（${Object.keys(USAGE_MODES).join(", ")}）`);
  console.log(`[mock] 切换示例：`);
  console.log(`[mock]   curl http://127.0.0.1:${PORT}/mode/low`);
  console.log(`[mock]   curl http://127.0.0.1:${PORT}/usage-mode/expired`);
  console.log(
    `[mock] 用量地址不是配置项，要这样接线：` +
      ` DEEPSEEK_USAGE_BASE_URL=http://127.0.0.1:${PORT}`,
  );
});
