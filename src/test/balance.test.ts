import assert from "node:assert/strict";
import { test } from "node:test";

import {
  formatAllDetailed,
  formatAmount,
  formatDetailed,
  isLow,
  selectInfo,
} from "../deepseek/balance";
import type { BalanceInfo } from "../deepseek/types";

/** 官方文档里的示例响应，用于交叉验证格式化结果。 */
const CNY: BalanceInfo = {
  currency: "CNY",
  total_balance: "110.00",
  granted_balance: "10.00",
  topped_up_balance: "100.00",
};

const USD: BalanceInfo = {
  currency: "USD",
  total_balance: "1.20",
  granted_balance: "0.00",
  topped_up_balance: "1.20",
};

test("selectInfo：AUTO 优先人民币", () => {
  assert.equal(selectInfo([USD, CNY], "AUTO")?.currency, "CNY");
});

test("selectInfo：AUTO 没有 CNY 时退回第一条", () => {
  assert.equal(selectInfo([USD], "AUTO")?.currency, "USD");
});

test("selectInfo：指定币种不存在时退回第一条", () => {
  assert.equal(selectInfo([CNY], "USD")?.currency, "CNY");
});

test("selectInfo：空数组返回 undefined", () => {
  assert.equal(selectInfo([], "AUTO"), undefined);
});

test("selectInfo：指定币种存在时优先于第一条", () => {
  assert.equal(selectInfo([CNY, USD], "USD")?.currency, "USD");
});

test("formatAmount：币种码而非 ¥ 符号，避免多币种歧义", () => {
  assert.equal(formatAmount(CNY), "CNY 110.00");
});

test("formatDetailed：对已核实的真实响应格式正确", () => {
  assert.equal(formatDetailed(CNY), "CNY 110.00（赠送 10.00 / 充值 100.00）");
});

test("formatDetailed：赠送/充值字段缺失时回退为 0", () => {
  const partial = { currency: "CNY", total_balance: "5.00" } as BalanceInfo;
  assert.equal(formatDetailed(partial), "CNY 5.00（赠送 0 / 充值 0）");
});

test("formatDetailed：金额原样透传，不做 toFixed 重排", () => {
  const odd = { ...CNY, total_balance: "34.5" };
  assert.equal(formatDetailed(odd), "CNY 34.5（赠送 10.00 / 充值 100.00）");
});

test("formatAllDetailed：无余额信息时回退到既有中文文案", () => {
  assert.equal(formatAllDetailed([]), "（无余额信息）");
});

test("formatAllDetailed：多币种以 · 连接", () => {
  assert.equal(
    formatAllDetailed([CNY, USD]),
    "CNY 110.00（赠送 10.00 / 充值 100.00）  ·  USD 1.20（赠送 0.00 / 充值 1.20）",
  );
});

test("isLow：低于阈值为 true", () => {
  assert.equal(isLow({ ...CNY, total_balance: "3.20" }, 10), true);
});

test("isLow：恰好等于阈值不算低（严格小于）", () => {
  assert.equal(isLow({ ...CNY, total_balance: "10.00" }, 10), false);
});

test("isLow：阈值为 0 时关闭提醒", () => {
  assert.equal(isLow({ ...CNY, total_balance: "0.00" }, 0), false);
});

test("isLow：金额解析不出来时不告警", () => {
  assert.equal(isLow({ ...CNY, total_balance: "abc" }, 10), false);
});

test("isLow：没有余额信息时不告警", () => {
  assert.equal(isLow(undefined, 10), false);
});
