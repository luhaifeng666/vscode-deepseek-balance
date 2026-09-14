import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ALL_COMMANDS,
  COMMAND_REFRESH,
  COMMAND_SET_API_KEY,
  formatTime,
  render,
  type RenderOptions,
  type StatusState,
} from "../render";
import type { BalanceInfo, BalanceSnapshot } from "../deepseek/types";

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

const OPTIONS: RenderOptions = { currency: "AUTO", lowBalanceThreshold: 10 };

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
    { currency: "USD", lowBalanceThreshold: 10 },
  );
  assert.equal(vm.text, "$(credit-card) USD 20.00");
});

test("低余额阈值按所选币种的数值直接比较，不做汇率换算", () => {
  // 已知语义而非 bug：阈值是单一数字、与币种无关，所以 USD 1.20 会触发
  // 阈值为 10 的告警，哪怕 $1.20 按汇率其实高于 ¥10。
  // 配置项描述里已说明阈值以所显示的币种为准。
  const vm = renderWith(
    { kind: "ok", snapshot: snapshot({ infos: [USD] }), stale: false },
    { currency: "AUTO", lowBalanceThreshold: 10 },
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
