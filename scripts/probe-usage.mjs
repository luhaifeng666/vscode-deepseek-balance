#!/usr/bin/env node
/**
 * platform.deepseek.com 用量接口的**结构探测**脚本（第 4 轮）。
 *
 * DeepSeek 没有官方用量接口，控制台的用量挂在未公开的 /api/v0/* 上。
 * 本扩展的解析器必须照着这个脚本 dump 出来的**真实结构**写。
 *
 * ══ 已确认的事实（第 1–3 轮） ══════════════════════════════════════
 *
 * 【参数】start/end 必须是**整点**（epoch 秒），否则 biz_code=1 INVALID_PARAM。
 *
 * 【鉴权】biz_code=1 ≠ 鉴权失败。鉴权失败是 HTTP 200 信封里的 40002/40003，
 * 出现在 data.code 与 data.data.biz_code **两处**。
 *
 * 【tz：已确证无作用】第 3 轮用「同一 tz 连打三次」做基线 + 顺序无关的规范
 * 化哈希判定：基线三连的 raw 哈希就不一致（服务端返回顺序会抖），而六个不同
 * tz 的 canon 哈希**全部相同**。所以 tz 不影响数据，**恒发 tz=0**（与参考实现
 * 一致）。第 2 轮看到的「tz 似乎有效果」纯粹是顺序噪声 —— 没有基线重复就会
 * 得出错误结论。⚠️ 解析器**绝不能按数组下标取值**，顺序不保证。
 *
 * 【bucket 由服务端按窗口长度选】响应里的 bucket 是**输出**：17h 窗口给
 * bucket=3600（17 个桶），30 天窗口给 bucket=86400（30 个桶）。传 &bucket= 无效。
 * 所以长窗口的体积按**天**增长：本月 cost 仅 14KB、amount 44KB，可以接受。
 *
 * 【路由】
 *   · usage/{amount,cost}?month=&year=      ✅ 按月，JSON，结构已知（对照组）
 *   · usage/export?start=&end=&tz=0         ⚠️ 返回 zip，且窗口约束严；已弃用
 *   · usage/by_api_key/{amount,cost}?start=&end=&tz=
 *        ✅ 首选路径，JSON，无需解 zip
 *
 * 【窗口约束：第 4 轮要钉死的就是它】
 *   观察到的四条（cost）：
 *     ✓ 今日        17h   start 非零点, end 非零点
 *     ✗ 近7天本地   6.7d  start 非零点, end 非零点
 *     ✗ 近7天"UTC"  6.4d  start **零点**, end 非零点   ← 上轮只对齐了 start
 *     ✓ 本月        30d   start 零点,   end 零点
 *   假设：窗口 >24h 时 **两端都必须落在 UTC 零点**；≤24h 则不限。
 *   第 4 轮用「每行只变一个维度」的矩阵验证，不再一次改多个变量。
 *
 * ══ 第 5 轮要回答的（尚未跑，都是实现时新暴露出来的） ═══════════════
 *
 * D. **恰好 24h 且两端只对齐整点、不对齐 UTC 零点**，走 ≤24h 的宽松规则还是
 *    >24h 的严格规则？第 4 轮的矩阵区分不了——W1 那条 24h 通过的行**同时**也是
 *    UTC 对齐的，两个变量没拆开。这个组合每个本地日的最后一小时都会出现
 *    （整小时偏移时区下 hourCeil(now) 正好是本地次日零点），所以要确认。
 *    打法：start = 本地次日零点 - 24h（例如今日 16:00Z），end = 本地次日零点。
 *    预测：按 ≤24h 处理（对齐要求的根因是日桶必须切在日界，而 24h 窗口返回的是
 *    小时桶，不需要对齐）。
 * E. tz 是否影响**桶的时间戳标注**（第 3 轮只比了数值，没比 time 字段本身）。
 *
 * ══ 第 4 轮要回答的 ═══════════════════════════════════════════════
 *
 * A. `amount` 的完整结构（第 3 轮那次是空响应，且我没打印 thrown，无从判断）。
 *    本轮补 thrown + 空响应重试，并在第 2 节用窗口矩阵顺带再拿一份。
 * B. 窗口规则到底是「两端都要对齐」还是「只要 end 对齐」。矩阵见第 2 节。
 * C. 7 天 UTC 对齐窗口能不能用 —— 这是「近 7 天」能否走 by_api_key 的关卡。
 *
 * 用法（token 只从环境变量读，绝不落盘、绝不打印）：
 *
 *     DEEPSEEK_USER_TOKEN="$(pbpaste)" node scripts/probe-usage.mjs
 *
 * userToken 从浏览器剪贴板来：登录 platform.deepseek.com → F12 → Console →
 *
 *     copy(JSON.parse(localStorage.getItem('userToken')).value)
 *
 * 这个脚本**只读**：只发 GET，不写任何文件，不改任何远端状态。
 * scripts/** 已被 .vscodeignore 排除，不会随扩展发布出去。
 */

import { createHash } from "node:crypto";

const BASE = "https://platform.deepseek.com";
const TOKEN = process.env.DEEPSEEK_USER_TOKEN?.trim();

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
const REFERER = "https://platform.deepseek.com/usage";
const TIMEOUT_MS = 15_000;

if (!TOKEN) {
  console.error(
    [
      "缺少 DEEPSEEK_USER_TOKEN。",
      "",
      '  DEEPSEEK_USER_TOKEN="$(pbpaste)" node scripts/probe-usage.mjs',
      "",
      "token 取法：登录 platform.deepseek.com → F12 → Console →",
      "  copy(JSON.parse(localStorage.getItem('userToken')).value)",
    ].join("\n"),
  );
  process.exit(1);
}

const TOKEN_FP = createHash("sha256").update(TOKEN).digest("hex").slice(0, 8);

function scrub(text) {
  let out = String(text);
  if (TOKEN.length >= 8) out = out.split(TOKEN).join("<TOKEN>");
  out = out.replace(/Bearer\s+\S{12,}/gi, "Bearer <TOKEN>");
  out = out.replace(/eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}/g, "<JWT>");
  out = out.replace(/sk-[A-Za-z0-9*]{6,}/g, "sk-<KEY>");
  return out;
}

function headers() {
  return {
    authorization: `Bearer ${TOKEN}`,
    "user-agent": UA,
    referer: REFERER,
    accept: "application/json, text/plain, */*",
  };
}

/** 发一个 GET。空响应自动重试一次（第 3 轮那次空响应就是没重试才没结论）。 */
async function probe(url, { retries = 1 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        headers: headers(),
        signal: controller.signal,
        redirect: "manual",
      });
      const text = await response.text();
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
      const result = {
        status: response.status,
        location: response.headers.get("location") ?? undefined,
        bytes: Buffer.byteLength(text),
        text,
        parsed,
      };
      // 空 body 或非 JSON 一律当抖动重试
      if ((text.length === 0 || parsed === undefined) && attempt < retries) continue;
      return result;
    } catch (error) {
      if (attempt < retries) continue;
      return {
        status: 0,
        bytes: 0,
        text: "",
        parsed: undefined,
        thrown: error instanceof Error ? error.message : String(error),
      };
    } finally {
      clearTimeout(timer);
    }
  }
  return { status: 0, bytes: 0, text: "", parsed: undefined, thrown: "重试后仍无响应" };
}

/** 可读的结构 dump：数组只展开前 2 项。 */
function dump(value, depth = 0) {
  const pad = "  ".repeat(depth);
  if (value === null) return "null";
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const shown = value.slice(0, 2);
    const lines = shown.map((v) => `${pad}  ${dump(v, depth + 1)}`);
    if (value.length > shown.length)
      lines.push(`${pad}  …还有 ${value.length - shown.length} 项`);
    return `[${value.length} 项\n${lines.join("\n")}\n${pad}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length === 0) return "{}";
    return `{\n${entries.map(([k, v]) => `${pad}  ${k}: ${dump(v, depth + 1)}`).join("\n")}\n${pad}}`;
  }
  return JSON.stringify(value);
}

function section(title) {
  console.log(`\n${"─".repeat(72)}\n${title}\n${"─".repeat(72)}`);
}

// ── 窗口 ────────────────────────────────────────────────────────────
const sec = (d) => Math.floor(d.getTime() / 1000);
const hourCeil = (s) => Math.ceil(s / 3600) * 3600;
const DAY = 86_400;

const now = new Date();
const nowSec = sec(now);
const LOCAL_TZ_HOURS = -now.getTimezoneOffset() / 60;
const localMidnight = sec(new Date(now.getFullYear(), now.getMonth(), now.getDate()));
const utcMidnightToday = Math.floor(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / 1000);
const nextHour = Math.max(hourCeil(nowSec), localMidnight + 3600);

const isUtcMidnight = (s) => s % DAY === 0;
const fmt = (s) => `${s}${isUtcMidnight(s) ? "(UTC零点)" : ""}`;

console.log(`token 指纹 ${TOKEN_FP}（只用于确认你换没换 token，不是 token 本身）`);
console.log(`本机时区偏移 UTC${LOCAL_TZ_HOURS >= 0 ? "+" : ""}${LOCAL_TZ_HOURS}`);
console.log(`现在     ${now.toISOString()}（UTC）`);
console.log(`本地零点 ${fmt(localMidnight)} · UTC 零点 ${fmt(utcMidnightToday)} · 下个整点 ${nextHour}`);

const byKey = (kind, start, end, tz = 0) =>
  `${BASE}/api/v0/usage/by_api_key/${kind}?start=${start}&end=${end}&tz=${tz}`;

// ── 1. amount 完整结构（第 3 轮这里是空响应，本轮补 thrown + 重试） ──
section("1. by_api_key/amount 完整结构（今日窗口，数组只展开前 2 项）");
{
  const url = byKey("amount", localMidnight, nextHour);
  const r = await probe(url);
  console.log(`\nURL    ${scrub(url)}`);
  if (r.thrown !== undefined) console.log(`✗ 抛出：${scrub(r.thrown)}`);
  console.log(`HTTP   ${r.status} · ${r.bytes} 字节 · 信封 code=${r.parsed?.code} biz_code=${r.parsed?.data?.biz_code}`);
  const biz = r.parsed?.data?.biz_data;
  if (biz === undefined) {
    console.log(`✗ 无 biz_data。原始响应前 300 字符：\n${scrub(r.text.slice(0, 300))}`);
  } else {
    console.log(scrub(dump(biz)).slice(0, 5000));
    // 把 amount 桶里的键单独拎出来——token 类型的拆分就藏在这里
    const series = Array.isArray(biz.series) ? biz.series : [];
    const bucketKeys = new Set();
    for (const s of series) for (const b of s.buckets ?? []) Object.keys(b).forEach((k) => bucketKeys.add(k));
    console.log(`\n  ⇒ amount 的 bucket 键集合：{${[...bucketKeys].join(", ")}}`);
    console.log(`  ⇒ series 元素键集合：{${[...new Set(series.flatMap((s) => Object.keys(s)))].join(", ")}}`);
  }
}

// ── 2. 窗口规则矩阵：每行只变一个维度 ────────────────────────────────
section("2. 窗口规则矩阵（每行只变一个维度，用 cost 打）");
console.log(
  [
    "假设 H：窗口 >24h 时 **两端都必须落在 UTC 零点**；≤24h 则不限。",
    "每行相对上一行只改一处，避免重蹈「一次改多个变量」的覆辙：",
    "  今日          17h   非零点 / 非零点   已知 ✓",
    "  W1 24h        24h   零点   / 零点     ← 变：两端都对齐",
    "  W2 24h+1h     25h   零点   / 非零点   ← 变：只把 end 挪离零点（>24h）",
    "  W3 48h        48h   零点   / 零点     ← 变：窗口拉长，两端仍对齐",
    "  W4 7天        7d    零点   / 零点     ← ★ 关卡：近 7 天能否走它",
    "  W5 7天(local) 7.3d  非零点 / 零点     ← 变：只把 start 挪离零点",
    "判定：W1/W3/W4 若 ✓ 而 W2/W5 ✗ → H 成立。",
  ].join("\n"),
);

const matrix = [
  ["W1 24h", utcMidnightToday, utcMidnightToday + DAY],
  ["W2 24h+1h", utcMidnightToday, utcMidnightToday + DAY + 3600],
  ["W3 48h", utcMidnightToday - DAY, utcMidnightToday + DAY],
  ["W4 7天", utcMidnightToday - 6 * DAY, utcMidnightToday + DAY],
  ["W5 7天(本地起点)", localMidnight - 6 * DAY, utcMidnightToday + DAY],
];

const results = [];
for (const [label, start, end] of matrix) {
  const url = byKey("cost", start, end);
  const r = await probe(url);
  const ok = r.parsed?.data?.biz_code === 0;
  const hours = ((end - start) / 3600).toFixed(1);
  results.push({ label, ok, hours, bytes: r.bytes });
  console.log(
    `\n▸ ${label}  ${hours}h  start=${fmt(start)}  end=${fmt(end)}` +
      `\n  ${ok ? "✓ 可用" : "✗ 被拒"} · HTTP ${r.status} · ${r.bytes} 字节` +
      (ok
        ? ` · bucket=${r.parsed?.data?.biz_data?.bucket} · series=${r.parsed?.data?.biz_data?.data?.[0]?.series?.length}`
        : ` · biz_msg="${r.parsed?.data?.biz_msg}"`) +
      (r.thrown ? ` · 抛出 ${scrub(r.thrown)}` : ""),
  );
}

// ── 3. 可用的那个 7 天窗口，用 amount 也打一遍 ──────────────────────
section("3. 7 天窗口在 amount 上是否同样可用");
{
  const start = utcMidnightToday - 6 * DAY;
  const end = utcMidnightToday + DAY;
  const url = byKey("amount", start, end);
  const r = await probe(url);
  const ok = r.parsed?.data?.biz_code === 0;
  console.log(`URL    ${scrub(url)}`);
  console.log(`HTTP   ${r.status} · ${r.bytes} 字节 · ${ok ? "✓ 可用" : "✗ 被拒"}`);
  const biz = r.parsed?.data?.biz_data;
  if (ok && biz !== undefined) {
    const series = Array.isArray(biz.series) ? biz.series : [];
    const bucketKeys = new Set();
    for (const s of series) for (const b of s.buckets ?? []) Object.keys(b).forEach((k) => bucketKeys.add(k));
    console.log(`  bucket=${biz.bucket} · series=${series.length} · bucket 键集合 {${[...bucketKeys].join(", ")}}`);
    console.log(`  第一个 bucket：${scrub(JSON.stringify(series[0]?.buckets?.[0]))}`);
    console.log(`  最后一个 bucket：${scrub(JSON.stringify(series[0]?.buckets?.at(-1)))}`);
  } else {
    console.log(`  biz_msg="${r.parsed?.data?.biz_msg}"`);
  }
}

// ── 4. 汇总与判定 ───────────────────────────────────────────────────
section("结论");
console.log("窗口矩阵：");
for (const r of results) console.log(`  ${r.ok ? "✓" : "✗"} ${r.label.padEnd(18)} ${r.hours.padStart(5)}h  ${r.bytes} 字节`);
const w1 = results.find((r) => r.label === "W1 24h")?.ok;
const w2 = results.find((r) => r.label === "W2 24h+1h")?.ok;
const w3 = results.find((r) => r.label === "W3 48h")?.ok;
const w4 = results.find((r) => r.label === "W4 7天")?.ok;
const w5 = results.find((r) => r.label === "W5 7天(本地起点)")?.ok;
console.log(
  [
    "",
    w1 && w3 && w4 && !w2 && !w5
      ? "⇒ 假设 H 成立：>24h 时两端都必须对齐 UTC 零点，≤24h 不限。"
      : "⇒ 与假设 H 不完全一致，按下表逐行读（每行只差一个维度）。",
    "",
    `近 7 天可走 by_api_key？ ${w4 ? "✓ 是 —— 三个时间范围一条代码路径" : "✗ 否 —— 近 7 天需另想办法"}`,
    w4 ? "" : "  备选：今日走 by_api_key（≤24h 本地窗口），近 7 天/本月走月度接口的 days[] 求和。",
    "",
    "把上面全部输出贴回来即可（token 已被抹除，指纹是单向哈希）。",
  ]
    .filter((l) => l !== "")
    .join("\n"),
);
