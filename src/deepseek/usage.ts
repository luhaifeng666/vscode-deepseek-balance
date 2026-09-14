/**
 * DeepSeek 控制台用量接口客户端。
 *
 * 与 balance.ts 一样不 import vscode：调用方注入 baseUrl / signal，测试注入假
 * fetch。用扩展宿主自带的全局 fetch（Node 18+），没有运行时依赖。
 *
 * ── 这个接口有多「非官方」 ───────────────────────────────────────────
 *
 * DeepSeek 没有公开的用量接口。本文件打的是 platform.deepseek.com 控制台内部
 * 用的 /api/v0/usage/by_api_key/*，认证靠浏览器 localStorage 里的会话 userToken。
 * 所以它随时可能改结构——下面的解析器全部按「宁可判 malformed 也不要静默给出
 * 错的数字」来写，任何一处对不上都降级成一条错误提示，绝不影响余额显示。
 *
 * ── 参数契约（4 轮实测，scripts/probe-usage.mjs 可复现） ──────────────
 *
 * start/end 必须是**整点**的 epoch 秒。除此之外还有一条按窗口长度分岔的规则：
 *
 *   ≤24h ：两端落在整点即可。
 *   >24h ：两端都**必须落在 UTC 零点**，否则一律 biz_code=1 INVALID_PARAM。
 *
 * 这条规则决定了 usageWindow 的形状，也是「近 7 天/本月按 UTC 日切分」的原因。
 *
 * ⚠️ **已知未测边界**：窗口**恰好** 24h 且两端只是整点（不是 UTC 零点）时走哪条
 * 规则，探测数据区分不了——矩阵里那条 24h 通过的行同时也是 UTC 对齐的。这个组合
 * 每个本地日的最后一小时都会出现（整小时偏移时区下，`hourCeil(now)` 正好是本地
 * 次日零点）。判断是它应当照 ≤24h 处理：对齐要求的根因是**日桶必须切在日界上**，
 * 而 24h 窗口本来就返回小时桶（24 个），不需要对齐。真要证伪，用
 * scripts/probe-usage.mjs 打一发非 UTC 对齐的 24h 窗口即可。
 *
 * tz 参数实测无作用（同一 tz 连打三次的原文哈希就不一致，而 6 个不同 tz 的
 * 规范化哈希全同），所以固定发 0，与参考实现一致。
 */

import { redactSecrets, redactValue } from "./client";
import type {
  UsageError,
  UsageRange,
  UsageResult,
  UsageSnapshot,
} from "./types";

export const DEFAULT_USAGE_BASE_URL = "https://platform.deepseek.com";

/**
 * 解析用量接口地址，只认本地地址，其余一律回退到官方主机。
 *
 * 存在的理由：冒烟测试与本地 mock 需要一个把请求引开的钩子（extension.ts 读
 * `DEEPSEEK_USAGE_BASE_URL`）。但它**不能**是个通用的「改地址」开关——用量请求
 * 头上挂着的是控制台会话凭据，一个能指向任意主机的环境变量就等于一条把凭据送出
 * 去的通道。所以这里只放行 localhost/127.0.0.1/[::1]：这样它作为测试钩子够用，
 * 而作为外泄通道在结构上就不成立。
 */
export function resolveUsageBaseUrl(raw: string | undefined): string {
  const trimmed = raw?.trim();
  if (trimmed === undefined || trimmed === "") return DEFAULT_USAGE_BASE_URL;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return DEFAULT_USAGE_BASE_URL;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return DEFAULT_USAGE_BASE_URL;
  }
  const host = parsed.hostname;
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    return DEFAULT_USAGE_BASE_URL;
  }
  return trimmed.replace(/\/+$/, "");
}

/** 明确写死，不隐式继承余额那边的值。两边的超时是可以各自调的。 */
const DEFAULT_TIMEOUT_MS = 15_000;

const HOUR_SEC = 3_600;
const DAY_SEC = 86_400;

/** 接口不给币种时的回退。实测 cost 响应带 currency，但空账户可能整段为空。 */
const DEFAULT_CURRENCY = "CNY";

/** 非鉴权的非零错误码（实测 INVALID_PARAM 是 1）。 */
const AUTH_CODES = new Set([40002, 40003]);

/**
 * 与参考实现一致：桌面 Chrome 的 UA + usage 页的 referer。
 *
 * ⚠️ 这两条是**照着能跑通的配置抄的，不是已知必需的**——探测时一直带着它们，
 * 所以没有「不带会怎样」的数据。先按已知可用的来，若日后接口报错再考虑去掉。
 */
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
const REFERER = "https://platform.deepseek.com/usage";

/** 空 token 的判定与范围校验要用到，且都是纯逻辑，所以留在无 vscode 依赖的这一侧。 */
export const USAGE_RANGES: readonly UsageRange[] = ["today", "week", "month"];

/**
 * 范围值的窄化校验。
 *
 * 两处都靠它：读配置时挡住手改 settings.json 写错的值，注册切换命令时挡住拼错的
 * 范围——后者不挡的话，一个打错字的命令会把非法值写进配置，而配置读取那边静默
 * 回退成 today，于是表现成「点了链接什么都没发生」，是最难查的那类现象。
 */
export function isUsageRange(value: unknown): value is UsageRange {
  return value === "today" || value === "week" || value === "month";
}

export function buildUsageUrl(
  baseUrl: string,
  kind: "amount" | "cost",
  start: number,
  end: number,
): string {
  const root = baseUrl.replace(/\/+$/, "");
  // tz 固定 0：实测它不影响结果，见文件头。
  return `${root}/api/v0/usage/by_api_key/${kind}?start=${start}&end=${end}&tz=0`;
}

/**
 * 算出某个时间范围的请求窗口（epoch 秒）。
 *
 * 今天用**本地**日边界，近 7 天与本月用 **UTC** 日边界——这不是偷懒，是接口
 * 逼出来的：UTC+8 下本地零点不是 UTC 零点，所以「本地对齐的 7 天/月」必然
 * >24h 且起点不对齐，会被 INVALID_PARAM 直接拒掉。唯一能拿到本地「今天」的
 * 办法就是 ≤24h 的本地窗口，而这恰好是最常看的那个数。
 *
 * 代价要如实告知用户：近 7 天/本月按 UTC 日切分，与本地日界最多差 8 小时。
 * 所以 UsageSnapshot 里带上了 start/end，让这个口径在界面上可见。
 */
export function usageWindow(
  range: UsageRange,
  now: Date,
): { start: number; end: number } {
  const sec = (d: Date): number => Math.floor(d.getTime() / 1000);
  const hourCeil = (s: number): number => Math.ceil(s / HOUR_SEC) * HOUR_SEC;

  if (range === "today") {
    const localMidnight = sec(new Date(now.getFullYear(), now.getMonth(), now.getDate()));
    // 向下取整到整点。整小时偏移的时区（含 UTC+8）下本地零点本就是整点，这行是
    // 空操作；UTC+5:30 / +5:45 那类时区下本地零点落在 :30 / :45，不取整就会因为
    // 「start 非整点」被接口拒掉。代价是那些时区的「今日」会往前多算半小时以内。
    const start = Math.floor(localMidnight / HOUR_SEC) * HOUR_SEC;
    // 至少 1 小时（刚过零点时 now 几乎等于 start），且**必须夹到 24h 以内**：
    // 夏令时回拨那天本地日有 25 小时，而 >24h 的窗口要求两端对齐 UTC 零点，
    // 本地零点不满足——不夹的话那一天会整个请求失败。宁可少算最后一小时。
    //
    // 上界取 24h 而不是 23h：代价不对称。夹到 23h 会让**每个本地日的最后一小时**
    // 的用量永久漏掉（过了零点「今日」就翻篇了，那一小时再也不会以今日的身份出现），
    // 而 24h 只是踩到上面那个未测边界时返回一条会自愈的错误提示。宁可显式报错，
    // 也不要静默少算——与 strictNumber 同一个取舍。
    const end = Math.min(
      Math.max(hourCeil(sec(now)), start + HOUR_SEC),
      start + DAY_SEC,
    );
    return { start, end };
  }

  // ⚠️ 一律用 **UTC 分量**，不要写成 now.getFullYear()/getMonth()/getDate()。
  // 混用本地分量与 Date.UTC 会算出一个**可能落在未来**的零点：UTC+8 下本地
  // 10-01 03:00 时，本地分量给出的「今天」是 10-01，可此刻 UTC 才 09-30 19:00，
  // 于是本月的整个窗口都在未来、恒显示 0；近 7 天则会丢掉窗口里最老的一天，
  // 换成一整天未来的空桶。这不是理论风险——月初/日界各 8 小时的窗口都踩得到。
  const utcMidnightToday = Math.floor(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 1000,
  );

  if (range === "week") {
    // 7 个 UTC 日，含今天（UTC）。end 取「明天零点」而不是 now，
    // 一是必须对齐零点，二是这样才把今天(UTC)整个算进来。
    return { start: utcMidnightToday - 6 * DAY_SEC, end: utcMidnightToday + DAY_SEC };
  }

  return {
    start: Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) / 1000),
    end: Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1) / 1000),
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

/**
 * 严格取数。
 *
 * ⚠️ 这里是**故意不照抄参考实现**的地方：它的 toFloat（:406-407）遇到非数字
 * 静默返回 0，于是「字段是 "nope"」和「本月真的零消耗」在下游完全不可区分——
 * 结构漂移会伪装成一份正常的零账单。本实现取不到数就返回 undefined，
 * 由调用方判 malformed。
 */
function strictNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") {
    // Number("") 是 0、Number("  ") 也是 0，必须先挡掉，否则空串会伪装成零。
    const trimmed = value.trim();
    if (trimmed === "") return undefined;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/**
 * 检查信封错误。
 *
 * 鉴权错误有**两个位置**：顶层 `code` 与 `data.biz_code`。参考实现 :157-163
 * 两处都查，实测也确认过错误码可能只出现在其中一处，所以两处都要覆盖。
 *
 * 消息只由**固定中文串与数字**拼成，不插服务端返回的字符串——沿用 client.ts
 * 的结构性做法，凭据不可能经由错误消息泄漏。
 */
export function classifyEnvelope(payload: unknown): UsageError | undefined {
  const body = asRecord(payload);
  if (body === undefined) {
    return { kind: "malformed", message: "接口返回的数据结构不符合预期。" };
  }
  const data = asRecord(body.data);
  const code = typeof body.code === "number" ? body.code : undefined;
  const bizCode = typeof data?.biz_code === "number" ? data.biz_code : undefined;

  for (const value of [code, bizCode]) {
    if (value === undefined || value === 0) continue;
    if (AUTH_CODES.has(value)) {
      return { kind: "expired", message: "用量 Token 已失效，请重新获取。" };
    }
    // 实测 INVALID_PARAM 是 1。它意味着**我们把窗口算错了**（这是程序缺陷，
    // 不是用户的问题），所以文案如实说是请求被拒，并带上错误码便于定位。
    return { kind: "malformed", message: `接口拒绝了本次请求（错误码 ${value}）。` };
  }

  if (data === undefined) {
    return { kind: "malformed", message: "接口返回的数据结构不符合预期（缺少 data）。" };
  }
  return undefined;
}

/**
 * 遍历 series[].buckets[]，对每个 bucket 取一个字段求和。
 *
 * ⚠️ **只求和，绝不按下标取任何东西。** 实测确认响应里的数组顺序不稳定
 * （同一 tz 连打三次，原文哈希三次都不同），按位置读会随机取到别的 model。
 * 求和是可交换的，所以不受影响。
 */
function sumBuckets(
  series: unknown,
  pick: (bucket: Record<string, unknown>) => unknown,
): number | undefined {
  if (!Array.isArray(series)) return undefined;
  let total = 0;
  for (const item of series) {
    const entry = asRecord(item);
    if (entry === undefined || !Array.isArray(entry.buckets)) return undefined;
    for (const rawBucket of entry.buckets) {
      const bucket = asRecord(rawBucket);
      if (bucket === undefined) return undefined;
      const value = strictNumber(pick(bucket));
      if (value === undefined) return undefined;
      total += value;
    }
  }
  return total;
}

export interface CostTotals {
  cost: number;
  currency: string;
}

/**
 * 解析 cost 响应的 biz_data。
 *
 * 形状：**数组**，元素里有 currency 与 series，series[].buckets[].cost 是
 * **字符串**（实测是 "0" 这种），所以要过一次严格取数。
 *
 * 整个数组都要遍历，**不能只读 [0]**：实测样本里只有一个元素（所有 model 都在
 * 它的 series 里），但「一条一个币种」也是这种形状的自然延伸，只读第一条会静默
 * 漏掉后面的消耗——这正是最难发现的那类错。
 */
export function parseCostTotals(bizData: unknown): CostTotals | undefined {
  if (!Array.isArray(bizData)) return undefined;
  // 空数组 = 该窗口确实没有消耗（全新账户就是这样），不是结构问题。
  if (bizData.length === 0) return { cost: 0, currency: DEFAULT_CURRENCY };

  let cost = 0;
  let currency: string | undefined;

  for (const item of bizData) {
    const entry = asRecord(item);
    if (entry === undefined) return undefined;

    const rawCurrency = entry.currency;
    if (typeof rawCurrency === "string" && rawCurrency.trim() !== "") {
      // 多条目币种不一致时求和就没有意义了——那是我们没理解的结构。宁可判
      // malformed，也不要给出一个把人民币和美元加在一起的数字。
      if (currency !== undefined && currency !== rawCurrency) return undefined;
      currency = rawCurrency;
    }

    const part = sumBuckets(entry.series, (bucket) => bucket.cost);
    if (part === undefined) return undefined;
    cost += part;
  }

  return { cost, currency: currency ?? DEFAULT_CURRENCY };
}

export interface AmountTotals {
  requests: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  outputTokens: number;
}

/** 接口字段名 → 我们的字段名。REQUEST 是**请求次数**，不是 token。 */
const AMOUNT_FIELDS: ReadonlyArray<readonly [keyof AmountTotals, string]> = [
  ["requests", "REQUEST"],
  ["outputTokens", "RESPONSE_TOKEN"],
  ["cacheHitTokens", "PROMPT_CACHE_HIT_TOKEN"],
  ["cacheMissTokens", "PROMPT_CACHE_MISS_TOKEN"],
];

/**
 * 解析 amount 响应的 biz_data。
 *
 * 形状：**对象**，`series` 直接挂在 biz_data 下——注意它**没有** cost 那层
 * `data[] / currency` 包装，两边形状不一致，别照抄。
 * series[].buckets[].usage 是四个字段的对象，值是数字。
 */
export function parseAmountTotals(bizData: unknown): AmountTotals | undefined {
  const root = asRecord(bizData);
  if (root === undefined || !Array.isArray(root.series)) return undefined;

  const totals: AmountTotals = {
    requests: 0,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
    outputTokens: 0,
  };

  for (const item of root.series) {
    const entry = asRecord(item);
    if (entry === undefined || !Array.isArray(entry.buckets)) return undefined;
    for (const rawBucket of entry.buckets) {
      const bucket = asRecord(rawBucket);
      const usage = asRecord(bucket?.usage);
      if (usage === undefined) return undefined;
      for (const [key, field] of AMOUNT_FIELDS) {
        const value = strictNumber(usage[field]);
        // 四个字段实测总是齐全（为 0 也会显式给出），所以缺一个就是结构漂移。
        // 这里同样不静默当 0——那会让 token 数在界面上悄悄变少而不报错。
        if (value === undefined) return undefined;
        totals[key] += value;
      }
    }
  }
  return totals;
}

export interface FetchUsageOptions {
  token: string;
  /** 由调用方注入而非配置项：这样测试与本地 mock 才指得过去。 */
  baseUrl?: string;
  range: UsageRange;
  /** 注入「现在」，让窗口计算可测。 */
  now?: Date;
  timeoutMs?: number;
  /** 调用方的取消信号（例如 token 变更时中止在途请求）。 */
  signal?: AbortSignal;
}

function describeThrown(error: unknown, token: string): string {
  const raw = error instanceof Error ? error.message : String(error);
  // 先按形状抹一遍，再按**值**抹一遍。后者不依赖 token 长什么样，是主防线。
  return redactValue(redactSecrets(raw), token);
}

interface JsonOutcome {
  ok: boolean;
  payload?: unknown;
  error?: UsageError;
}

/**
 * 发一个请求并解析 JSON。任何失败都归一化成 UsageError，绝不抛。
 *
 * `redirect: "manual"` **不是可选项**：会话过期时服务端很可能 302 到登录页，
 * 默认的 `follow` 会跨源跟过去、丢掉 Authorization，然后把登录页的 HTML 当成
 * 响应体解析，用户看到的就是「接口返回异常」而不是「Token 已失效」。
 * 参考实现两条请求路径都带了它（/tmp/dsu-index.js:137,171）。
 */
async function requestJson(
  url: string,
  token: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<JsonOutcome> {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const combined =
    signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal]);

  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json, text/plain, */*",
        "user-agent": USER_AGENT,
        referer: REFERER,
      },
      signal: combined,
      redirect: "manual",
    });
  } catch (error) {
    // 超时与调用方取消要分开：超时要报错，取消是静默的（否则 dispose 落在
    // 请求在途时会冒成一条用户可见的错误）。同 client.ts:110-130。
    if (timeoutSignal.aborted) {
      return {
        ok: false,
        error: {
          kind: "timeout",
          message: `请求超时（${Math.round(timeoutMs / 1000)} 秒）。`,
        },
      };
    }
    if (signal?.aborted === true) {
      return { ok: false, error: { kind: "network", message: "请求已取消。" } };
    }
    return {
      ok: false,
      error: { kind: "network", message: `网络请求失败：${describeThrown(error, token)}` },
    };
  }

  // 302 到登录页 = 会话过期。redirect: "manual" 让我们能看见它。
  if (response.status >= 300 && response.status < 400) {
    return {
      ok: false,
      error: {
        kind: "expired",
        message: "用量 Token 已失效，请重新获取。",
        httpStatus: response.status,
      },
    };
  }

  if (response.status === 401 || response.status === 403) {
    return {
      ok: false,
      error: {
        kind: "expired",
        message: "用量 Token 已失效，请重新获取。",
        httpStatus: response.status,
      },
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      error: {
        kind: "http",
        message: `用量接口返回异常（HTTP ${response.status}）。`,
        httpStatus: response.status,
      },
    };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return {
      ok: false,
      error: { kind: "malformed", message: "接口返回的内容不是合法 JSON。" },
    };
  }

  const envelopeError = classifyEnvelope(payload);
  if (envelopeError !== undefined) return { ok: false, error: envelopeError };

  return { ok: true, payload };
}

/**
 * 查询用量。任何失败都归一化成 { ok: false, error }。
 *
 * cost 与 amount 是两次独立请求，**两个都成功才算成功**：它们的鉴权、会话、
 * 窗口完全一样，失败原因几乎总是同一个，拆成「半份数据」只会让渲染层多一个
 * 状态、让用户看到更含糊的界面。代价是任一请求抖动都会整体降级——下一轮轮询
 * 会自愈。
 */
export async function fetchUsage(options: FetchUsageOptions): Promise<UsageResult> {
  const {
    token,
    baseUrl = DEFAULT_USAGE_BASE_URL,
    range,
    now = new Date(),
    timeoutMs = DEFAULT_TIMEOUT_MS,
    signal,
  } = options;

  if (token.trim() === "") {
    return { ok: false, error: { kind: "no-token", message: "尚未配置用量 Token。" } };
  }

  const { start, end } = usageWindow(range, now);
  const costUrl = buildUsageUrl(baseUrl, "cost", start, end);
  const amountUrl = buildUsageUrl(baseUrl, "amount", start, end);

  try {
    new URL(costUrl);
  } catch {
    return { ok: false, error: { kind: "malformed", message: `接口地址无效：${baseUrl}` } };
  }

  const [costOutcome, amountOutcome] = await Promise.all([
    requestJson(costUrl, token, timeoutMs, signal),
    requestJson(amountUrl, token, timeoutMs, signal),
  ]);

  if (!costOutcome.ok) return { ok: false, error: costOutcome.error! };
  if (!amountOutcome.ok) return { ok: false, error: amountOutcome.error! };

  const body = asRecord(costOutcome.payload);
  const costData = asRecord(body?.data)?.biz_data;
  const totals = parseCostTotals(costData);
  if (totals === undefined) {
    return {
      ok: false,
      error: { kind: "malformed", message: "用量接口返回的数据结构不符合预期（消耗）。" },
    };
  }

  const amountBody = asRecord(amountOutcome.payload);
  const amountData = asRecord(amountBody?.data)?.biz_data;
  const amounts = parseAmountTotals(amountData);
  if (amounts === undefined) {
    return {
      ok: false,
      error: { kind: "malformed", message: "用量接口返回的数据结构不符合预期（Token）。" },
    };
  }

  const snapshot: UsageSnapshot = {
    range,
    start,
    end,
    currency: totals.currency,
    cost: totals.cost,
    requests: amounts.requests,
    cacheHitTokens: amounts.cacheHitTokens,
    cacheMissTokens: amounts.cacheMissTokens,
    outputTokens: amounts.outputTokens,
    fetchedAt: Date.now(),
    endpoint: costUrl,
  };
  return { ok: true, snapshot };
}
