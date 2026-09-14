import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ALL_COMMANDS,
  COMMAND_REFRESH,
  COMMAND_SET_API_KEY,
  formatCost,
  formatTime,
  formatTokens,
  render,
  type RenderOptions,
  type StatusState,
  type UsageView,
} from "../render";
import type { BalanceInfo, BalanceSnapshot, UsageSnapshot } from "../deepseek/types";

const CNY: BalanceInfo = {
  currency: "CNY",
  total_balance: "34.53",
  granted_balance: "0.00",
  topped_up_balance: "34.53",
};

const USD: BalanceInfo = {
  currency: "USD",
  total_balance: "1.20",
  granted_balance: "0.00",
  topped_up_balance: "1.20",
};

function snapshot(overrides: Partial<BalanceSnapshot> = {}): BalanceSnapshot {
  return {
    infos: [CNY],
    isAvailable: true,
    fetchedAt: 1_760_000_000_000,
    endpoint: "https://api.deepseek.com/user/balance",
    ...overrides,
  };
}

const OPTIONS: RenderOptions = {
  currency: "AUTO",
  lowBalanceThreshold: 10,
  usageRange: "today",
};

const renderWith = (state: StatusState, options: RenderOptions = OPTIONS) =>
  render(state, options);

test("未配置 Key：提示设置，且不使用警告色", () => {
  const vm = renderWith({ kind: "no-key" });
  assert.equal(vm.text, "$(key) DeepSeek");
  assert.equal(vm.command, COMMAND_SET_API_KEY);
  assert.equal(vm.colorId, undefined);
  assert.equal(vm.backgroundColorId, undefined);
  assert.match(vm.tooltip, /command:deepseekBalance\.setApiKey/);
});

test("加载中且无历史值：只有图标与名称", () => {
  const vm = renderWith({ kind: "loading" });
  assert.equal(vm.text, "$(sync~spin) DeepSeek");
  assert.equal(vm.command, COMMAND_REFRESH);
  assert.equal(vm.colorId, undefined);
});

test("加载中且已有历史值：保留旧数字避免闪烁", () => {
  const vm = renderWith({ kind: "loading", previous: snapshot() });
  assert.equal(vm.text, "$(sync~spin) CNY 34.53");
});

test("正常：信用卡图标、默认前景色", () => {
  const vm = renderWith({ kind: "ok", snapshot: snapshot(), stale: false });
  assert.equal(vm.text, "$(credit-card) CNY 34.53");
  assert.equal(vm.colorId, undefined);
  assert.equal(vm.backgroundColorId, undefined);
  assert.equal(vm.command, COMMAND_REFRESH);
});

test("正常：tooltip 列出全部币种并给出接口地址", () => {
  const vm = renderWith({
    kind: "ok",
    snapshot: snapshot({ infos: [CNY, USD] }),
    stale: false,
  });
  assert.match(vm.tooltip, /CNY 34\.53（赠送 0\.00 \/ 充值 34\.53）/);
  assert.match(vm.tooltip, /USD 1\.20（赠送 0\.00 \/ 充值 1\.20）/);
  assert.match(vm.tooltip, /接口地址：https:\/\/api\.deepseek\.com\/user\/balance/);
  assert.match(vm.tooltip, new RegExp(formatTime(1_760_000_000_000)));
});

test("正常：状态栏只显示选中币种，即使返回多个", () => {
  const vm = renderWith(
    {
      kind: "ok",
      snapshot: snapshot({ infos: [{ ...USD, total_balance: "20.00" }, CNY] }),
      stale: false,
    },
    { currency: "USD", lowBalanceThreshold: 10, usageRange: "today" },
  );
  assert.equal(vm.text, "$(credit-card) USD 20.00");
});

test("低余额阈值按所选币种的数值直接比较，不做汇率换算", () => {
  // 已知语义而非 bug：阈值是单一数字、与币种无关，所以 USD 1.20 会触发
  // 阈值为 10 的告警，哪怕 $1.20 按汇率其实高于 ¥10。
  // 配置项描述里已说明阈值以所显示的币种为准。
  const vm = renderWith(
    { kind: "ok", snapshot: snapshot({ infos: [USD] }), stale: false },
    { currency: "AUTO", lowBalanceThreshold: 10, usageRange: "today" },
  );
  assert.equal(vm.text, "$(warning) USD 1.20");
});

test("正常但无余额信息：回退到名称而非报错", () => {
  const vm = renderWith({
    kind: "ok",
    snapshot: snapshot({ infos: [] }),
    stale: false,
  });
  assert.equal(vm.text, "$(credit-card) DeepSeek");
  assert.equal(vm.colorId, undefined);
  assert.match(vm.tooltip, /（无余额信息）/);
});

test("低余额：警告前景色 + 警告背景", () => {
  const vm = renderWith({
    kind: "ok",
    snapshot: snapshot({ infos: [{ ...CNY, total_balance: "3.20" }] }),
    stale: false,
  });
  assert.equal(vm.text, "$(warning) CNY 3.20");
  assert.equal(vm.colorId, "statusBarItem.warningForeground");
  assert.equal(vm.backgroundColorId, "statusBarItem.warningBackground");
  assert.match(vm.tooltip, /低于阈值 10/);
});

test("低余额：恰好等于阈值不算低", () => {
  const vm = renderWith({
    kind: "ok",
    snapshot: snapshot({ infos: [{ ...CNY, total_balance: "10.00" }] }),
    stale: false,
  });
  assert.equal(vm.text, "$(credit-card) CNY 10.00");
});

test("数据过期：只改前景色，不设背景", () => {
  const vm = renderWith({ kind: "ok", snapshot: snapshot(), stale: true });
  assert.equal(vm.text, "$(warning) CNY 34.53");
  assert.equal(vm.colorId, "statusBarItem.warningForeground");
  assert.equal(vm.backgroundColorId, undefined);
  assert.match(vm.tooltip, /数据可能已过期/);
});

test("余额不可用于 API 调用：独立一态，保留数字", () => {
  const vm = renderWith({
    kind: "ok",
    snapshot: snapshot({ isAvailable: false }),
    stale: false,
  });
  assert.equal(vm.text, "$(circle-slash) CNY 34.53");
  assert.equal(vm.colorId, "statusBarItem.warningForeground");
  assert.equal(vm.backgroundColorId, "statusBarItem.warningBackground");
  assert.match(vm.tooltip, /is_available 为 false/);
});

test("密钥无效：丢弃状态栏数字，改用错误色，点击去重设", () => {
  const vm = renderWith({
    kind: "error",
    error: { kind: "unauthorized", message: "API Key 无效或已失效，请重新设置。", httpStatus: 401 },
    previous: snapshot(),
    stale: true,
  });
  assert.equal(vm.text, "$(error) DeepSeek 密钥无效");
  assert.equal(vm.colorId, "statusBarItem.errorForeground");
  assert.equal(vm.backgroundColorId, "statusBarItem.errorBackground");
  assert.equal(vm.command, COMMAND_SET_API_KEY);
  // 旧值仍可在 tooltip 里看到，但明确标注已过期
  assert.match(vm.tooltip, /上次成功获取的值：CNY 34\.53（已过期）/);
});

test("403 与 401 同样处理", () => {
  const vm = renderWith({
    kind: "error",
    error: { kind: "forbidden", message: "该 API Key 没有访问余额接口的权限。", httpStatus: 403 },
    stale: false,
  });
  assert.equal(vm.text, "$(error) DeepSeek 密钥无效");
  assert.equal(vm.command, COMMAND_SET_API_KEY);
});

test("网络失败但有历史值：保留最后已知良好值", () => {
  const vm = renderWith({
    kind: "error",
    error: { kind: "network", message: "网络请求失败：fetch failed" },
    previous: snapshot(),
    stale: true,
  });
  assert.equal(vm.text, "$(warning) CNY 34.53");
  assert.equal(vm.colorId, "statusBarItem.warningForeground");
  assert.equal(vm.backgroundColorId, undefined);
  assert.equal(vm.command, COMMAND_REFRESH);
});

test("网络失败且无历史值：显示连接失败", () => {
  const vm = renderWith({
    kind: "error",
    error: { kind: "network", message: "网络请求失败：fetch failed" },
    stale: false,
  });
  assert.equal(vm.text, "$(warning) DeepSeek 连接失败");
  assert.equal(vm.backgroundColorId, undefined);
});

test("超时且无历史值：同样归入连接失败", () => {
  const vm = renderWith({
    kind: "error",
    error: { kind: "timeout", message: "请求超时（15 秒）。" },
    stale: false,
  });
  assert.equal(vm.text, "$(warning) DeepSeek 连接失败");
});

test("数据异常：单独文案，便于分辨代理返回错误页", () => {
  const vm = renderWith({
    kind: "error",
    error: { kind: "malformed", message: "接口返回的内容不是合法 JSON（可能是代理返回了错误页）。" },
    stale: false,
  });
  assert.equal(vm.text, "$(warning) DeepSeek 数据异常");
  assert.match(vm.tooltip, /代理返回了错误页/);
});

test("HTTP 状态码出现在 tooltip 里", () => {
  const vm = renderWith({
    kind: "error",
    error: { kind: "http", message: "余额接口返回异常（HTTP 500）。", httpStatus: 500 },
    stale: false,
  });
  assert.match(vm.tooltip, /HTTP 状态码：500/);
});

test("背景色只会用到那两个真正生效的 id", () => {
  const states: StatusState[] = [
    { kind: "no-key" },
    { kind: "loading" },
    { kind: "ok", snapshot: snapshot(), stale: false },
    { kind: "ok", snapshot: snapshot({ infos: [] }), stale: false },
    { kind: "ok", snapshot: snapshot({ isAvailable: false }), stale: false },
    { kind: "ok", snapshot: snapshot(), stale: true },
    { kind: "error", error: { kind: "network", message: "x" }, stale: false },
    { kind: "error", error: { kind: "unauthorized", message: "x" }, stale: false },
  ];
  for (const state of states) {
    const id = renderWith(state).backgroundColorId;
    if (id === undefined) continue;
    assert.ok(
      id === "statusBarItem.warningBackground" || id === "statusBarItem.errorBackground",
      `意外的背景色 id：${id}`,
    );
  }
});

test("每种状态都给出可访问标签与命令", () => {
  const states: StatusState[] = [
    { kind: "no-key" },
    { kind: "loading" },
    { kind: "ok", snapshot: snapshot(), stale: false },
    { kind: "error", error: { kind: "network", message: "x", }, stale: false },
  ];
  for (const state of states) {
    const vm = renderWith(state);
    assert.ok(vm.accessibleLabel.length > 0);
    assert.ok(ALL_COMMANDS.includes(vm.command), `未登记的命令：${vm.command}`);
  }
});

test("tooltip 里的命令链接都在白名单内", () => {
  const vm = renderWith({ kind: "ok", snapshot: snapshot(), stale: false });
  const linked = [...vm.tooltip.matchAll(/command:([A-Za-z0-9._-]+)/g)].map(
    (match) => match[1],
  );
  assert.ok(linked.length > 0, "tooltip 里没有任何命令链接");
  for (const command of linked) {
    assert.ok(
      command !== undefined && ALL_COMMANDS.includes(command),
      `tooltip 引用了白名单外的命令：${command}`,
    );
  }
});

// ── 用量段 ──────────────────────────────────────────────────────────

const USAGE_SNAPSHOT: UsageSnapshot = {
  range: "today",
  start: 1_789_344_000,
  end: 1_789_408_800,
  currency: "CNY",
  cost: 1.234,
  requests: 42,
  cacheHitTokens: 8000,
  cacheMissTokens: 2000,
  outputTokens: 2345,
  fetchedAt: 1_760_000_000_000,
  endpoint: "https://platform.deepseek.com/api/v0/usage/by_api_key/cost?start=1&end=2&tz=0",
};

const usageView = (view: UsageView): UsageView => view;

const renderUsage = (view: UsageView, options: RenderOptions = OPTIONS) =>
  render({ kind: "ok", snapshot: snapshot(), stale: false }, options, view);

test("用量/未配置：给出配置入口，并说明余额不受影响", () => {
  const vm = renderUsage(usageView({ kind: "unconfigured" }));
  assert.match(vm.tooltip, /未配置用量 Token/);
  assert.match(vm.tooltip, /command:deepseekBalance\.setUsageToken/);
});

test("用量/加载中：显示正在获取", () => {
  const vm = renderUsage(usageView({ kind: "loading" }));
  assert.match(vm.tooltip, /正在获取用量/);
});

test("用量/过期：多给一个「重新获取 Token」入口", () => {
  const vm = renderUsage(
    usageView({ kind: "error", message: "用量 Token 已失效，请重新获取。", expired: true }),
  );
  assert.match(vm.tooltip, /用量 Token 已失效/);
  assert.match(vm.tooltip, /command:deepseekBalance\.setUsageToken/);
});

test("用量/普通错误：只给重试，不误导用户去重配 Token", () => {
  const vm = renderUsage(
    usageView({ kind: "error", message: "用量接口返回异常（HTTP 500）。", expired: false }),
  );
  assert.match(vm.tooltip, /HTTP 500/);
  assert.doesNotMatch(
    vm.tooltip,
    /command:deepseekBalance\.setUsageToken/,
    "网络问题不该劝用户重新获取 Token",
  );
  assert.match(vm.tooltip, /command:deepseekBalance\.refresh/);
});

test("用量/有数据：金额两位小数、Token 千分位、请求次数与 token 分开呈现", () => {
  const vm = renderUsage(usageView({ kind: "ok", snapshot: USAGE_SNAPSHOT }));
  assert.match(vm.tooltip, /CNY 1\.23/);
  assert.match(vm.tooltip, /请求 42 次/);
  // 输入 = 缓存命中 + 未命中
  assert.match(vm.tooltip, /输入 10,000/);
  assert.match(vm.tooltip, /缓存命中 8,000/);
  assert.match(vm.tooltip, /未命中 2,000/);
  assert.match(vm.tooltip, /输出 2,345/);
  assert.match(vm.tooltip, new RegExp(`用量更新：${formatTime(USAGE_SNAPSHOT.fetchedAt)}`));
});

test("用量/今日：不显示 UTC 窗口行（本地口径，没什么要解释的）", () => {
  const vm = renderUsage(usageView({ kind: "ok", snapshot: USAGE_SNAPSHOT }));
  assert.doesNotMatch(vm.tooltip, /UTC 日界/);
});

test("用量/周月：把 UTC 窗口摊开，口径差别可见", () => {
  for (const range of ["week", "month"] as const) {
    const vm = renderUsage(
      usageView({
        kind: "ok",
        snapshot: {
          ...USAGE_SNAPSHOT,
          range,
          start: Date.UTC(2026, 8, 8) / 1000,
          end: Date.UTC(2026, 8, 15) / 1000,
        },
      }),
      { ...OPTIONS, usageRange: range },
    );
    assert.match(vm.tooltip, /09-08 → 09-15/, `${range} 应显示窗口`);
    assert.match(vm.tooltip, /UTC 日界/, `${range} 应说明口径`);
  }
});

test("用量/切换中：手上还是旧范围的快照时按「正在获取」处理，不标错数据", () => {
  // 拿近 7 天的数字顶着「本月」的标题显示，比什么都不显示更糟。
  const vm = renderUsage(
    usageView({ kind: "ok", snapshot: { ...USAGE_SNAPSHOT, range: "week" } }),
    { ...OPTIONS, usageRange: "month" },
  );
  assert.match(vm.tooltip, /正在获取用量/);
  assert.doesNotMatch(vm.tooltip, /CNY 1\.23/, "不能显示另一个范围的数字");
});

test("用量：当前范围是粗体不是链接，另外两个才是链接", () => {
  const vm = renderUsage(usageView({ kind: "loading" }), { ...OPTIONS, usageRange: "week" });
  assert.match(vm.tooltip, /\*\*用量 · 近 7 天\*\*/);
  assert.doesNotMatch(vm.tooltip, /command:deepseekBalance\.usageRangeWeek/);
  assert.match(vm.tooltip, /command:deepseekBalance\.usageRangeToday/);
  assert.match(vm.tooltip, /command:deepseekBalance\.usageRangeMonth/);
});

test("用量：范围链接都在命令白名单内", () => {
  const vm = renderUsage(usageView({ kind: "ok", snapshot: USAGE_SNAPSHOT }));
  const linked = [...vm.tooltip.matchAll(/command:([A-Za-z0-9._-]+)/g)].map((m) => m[1]);
  for (const command of linked) {
    assert.ok(
      command !== undefined && ALL_COMMANDS.includes(command),
      `用量段引用了白名单外的命令：${command}`,
    );
  }
});

test("用量/无 Key 态不显示用量段（那一态的主旨是去配 Key）", () => {
  const vm = render(
    { kind: "no-key" },
    OPTIONS,
    usageView({ kind: "ok", snapshot: USAGE_SNAPSHOT }),
  );
  assert.doesNotMatch(vm.tooltip, /用量/);
});

/**
 * 「用量失败不影响余额」的可执行约束。
 *
 * 这是整个设计的硬要求，光靠类型分家只能保证不去读对方的字段，保证不了渲染时
 * 不去动对方的那几个字段——所以逐字节比。
 */
const ISOLATION_STATES: StatusState[] = [
  { kind: "no-key" },
  { kind: "loading" },
  { kind: "loading", previous: snapshot() },
  { kind: "ok", snapshot: snapshot(), stale: false },
  { kind: "ok", snapshot: snapshot({ infos: [] }), stale: false },
  { kind: "ok", snapshot: snapshot({ isAvailable: false }), stale: false },
  { kind: "ok", snapshot: snapshot(), stale: true },
  { kind: "error", error: { kind: "network", message: "x" }, stale: false },
  {
    kind: "error",
    error: { kind: "unauthorized", message: "x", httpStatus: 401 },
    previous: snapshot(),
    stale: true,
  },
  { kind: "error", error: { kind: "malformed", message: "x" }, stale: false },
];

const ISOLATION_VIEWS: UsageView[] = [
  { kind: "loading" },
  { kind: "unconfigured" },
  { kind: "ok", snapshot: USAGE_SNAPSHOT },
  { kind: "error", message: "用量 Token 已失效，请重新获取。", expired: true },
  { kind: "error", message: "网络请求失败。", expired: false },
];

test("用量段的任何状态都不改动余额那几个字段（逐字节相同）", () => {
  for (const state of ISOLATION_STATES) {
    const baseline = render(state, OPTIONS, undefined);
    for (const view of ISOLATION_VIEWS) {
      const withUsage = render(state, OPTIONS, view);
      const label = `${state.kind} + ${view.kind}`;
      assert.equal(withUsage.text, baseline.text, `${label} 的 text 被改了`);
      assert.equal(withUsage.colorId, baseline.colorId, `${label} 的 colorId 被改了`);
      assert.equal(
        withUsage.backgroundColorId,
        baseline.backgroundColorId,
        `${label} 的 backgroundColorId 被改了`,
      );
      assert.equal(withUsage.command, baseline.command, `${label} 的 command 被改了`);
      assert.equal(
        withUsage.accessibleLabel,
        baseline.accessibleLabel,
        `${label} 的 accessibleLabel 被改了`,
      );
    }
  }
});

test("不传用量段时 tooltip 里不出现任何用量字样", () => {
  for (const state of ISOLATION_STATES) {
    assert.doesNotMatch(render(state, OPTIONS, undefined).tooltip, /用量/, state.kind);
  }
});

test("formatTokens：千分位分组，不用 toLocaleString", () => {
  assert.equal(formatTokens(0), "0");
  assert.equal(formatTokens(7), "7");
  assert.equal(formatTokens(999), "999");
  assert.equal(formatTokens(1000), "1,000");
  assert.equal(formatTokens(12345), "12,345");
  assert.equal(formatTokens(1234567), "1,234,567");
  assert.equal(formatTokens(1000000000), "1,000,000,000");
});

test("formatTokens：小数四舍五入、负数带号", () => {
  assert.equal(formatTokens(1234.6), "1,235");
  assert.equal(formatTokens(1234.4), "1,234");
  assert.equal(formatTokens(-1234), "-1,234");
});

test("formatCost：币种码 + 空格 + 两位小数", () => {
  // 与 formatAmount 的「CNY 34.53」同形；¥ 在多币种下有歧义，所以不用符号。
  assert.equal(formatCost("CNY", 1.234), "CNY 1.23");
  assert.equal(formatCost("CNY", 0), "CNY 0.00");
  assert.equal(formatCost("USD", 1.005), "USD 1.00");
  assert.equal(formatCost("CNY", 3.75), "CNY 3.75");
});
