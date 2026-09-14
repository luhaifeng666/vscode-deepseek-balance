/**
 * 状态栏状态机 —— 纯函数，不 import vscode。
 *
 * 颜色以 ThemeColor 的字符串 id 返回，由 StatusBarController 负责实例化。
 * tooltip 也在这里生成成 markdown 字符串，所以整张状态表都能在纯 Node 下单测。
 */

import {
  formatAmount,
  formatDetailed,
  isLow,
  selectInfo,
  type CurrencyPref,
} from "./deepseek/balance";
import type {
  BalanceError,
  BalanceSnapshot,
  UsageRange,
  UsageSnapshot,
} from "./deepseek/types";

export const COMMAND_REFRESH = "deepseekBalance.refresh";
export const COMMAND_SHOW_DETAILS = "deepseekBalance.showDetails";
export const COMMAND_SET_API_KEY = "deepseekBalance.setApiKey";
export const COMMAND_CLEAR_API_KEY = "deepseekBalance.clearApiKey";
export const COMMAND_OPEN_SETTINGS = "deepseekBalance.openSettings";
export const COMMAND_SET_USAGE_TOKEN = "deepseekBalance.setUsageToken";
/**
 * 不在 ALL_COMMANDS 里：那份清单是 **tooltip 里可点链接的白名单**，而清除 Token
 * 没有任何 tooltip 入口（只从命令面板 / 余额详情的 QuickPick 走）。白名单只放
 * 真正会被渲染成链接的命令，才守得住「白名单 = 最小必要集」这个性质。
 */
export const COMMAND_CLEAR_USAGE_TOKEN = "deepseekBalance.clearUsageToken";
export const COMMAND_USAGE_RANGE_TODAY = "deepseekBalance.usageRangeToday";
export const COMMAND_USAGE_RANGE_WEEK = "deepseekBalance.usageRangeWeek";
export const COMMAND_USAGE_RANGE_MONTH = "deepseekBalance.usageRangeMonth";

/** tooltip 里允许点击的命令白名单——绝不能改成 isTrusted: true。 */
export const ALL_COMMANDS: readonly string[] = [
  COMMAND_REFRESH,
  COMMAND_SHOW_DETAILS,
  COMMAND_SET_API_KEY,
  COMMAND_CLEAR_API_KEY,
  COMMAND_OPEN_SETTINGS,
  COMMAND_SET_USAGE_TOKEN,
  COMMAND_USAGE_RANGE_TODAY,
  COMMAND_USAGE_RANGE_WEEK,
  COMMAND_USAGE_RANGE_MONTH,
];

const WARNING_FG = "statusBarItem.warningForeground";
const WARNING_BG = "statusBarItem.warningBackground";
const ERROR_FG = "statusBarItem.errorForeground";
const ERROR_BG = "statusBarItem.errorBackground";

/** 只有这两个背景色 id 在多数主题下真正生效。 */
export const ALERT_BACKGROUNDS: readonly string[] = [WARNING_BG, ERROR_BG];

export interface RenderOptions {
  currency: CurrencyPref;
  lowBalanceThreshold: number;
  /** 用户选定的用量时间范围；与快照自带的 range 不一定一致，见 usageSection。 */
  usageRange: UsageRange;
}

/**
 * 用量那段视图。
 *
 * 刻意**不并进 StatusState**：StatusState 是余额控制器产出并 emit 的类型，放进去
 * 等于用量必须由余额控制器持有转发，正是要避免的耦合。分开传参还有个附带好处——
 * 用量缺失时（undefined）余额那几个字段逐字节不变，「用量失败不影响余额」就成了
 * 结构上的保证，而不是靠调用方自觉。
 */
export type UsageView =
  | { kind: "loading" }
  | { kind: "ok"; snapshot: UsageSnapshot }
  | { kind: "error"; message: string; expired: boolean }
  | { kind: "unconfigured" };

export type StatusState =
  | { kind: "no-key" }
  | { kind: "loading"; previous?: BalanceSnapshot }
  | { kind: "ok"; snapshot: BalanceSnapshot; stale: boolean }
  | {
      kind: "error";
      error: BalanceError;
      previous?: BalanceSnapshot;
      stale: boolean;
    };

export interface StatusViewModel {
  text: string;
  tooltip: string;
  colorId?: string;
  backgroundColorId?: string;
  command: string;
  accessibleLabel: string;
}

export function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    ` ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

type Section = string[] | undefined;
/**
 * 千分位分组。
 *
 * ⚠️ 不用 `toLocaleString`：CI 上的 Node 未必带 full ICU，同一个数字在不同机器上
 * 会输出不同结果，测试也就跟着飘。手写这几行贵不到哪去，但结果是确定的。
 */
export function formatTokens(value: number): string {
  const rounded = Math.round(value);
  const digits = String(Math.abs(rounded));
  const parts: string[] = [];
  for (let end = digits.length; end > 0; end -= 3) {
    parts.unshift(digits.slice(Math.max(0, end - 3), end));
  }
  return `${rounded < 0 ? "-" : ""}${parts.join(",")}`;
}

/**
 * 用量金额。
 *
 * ⚠️ 这里**破了**「金额原样透传、绝不 toFixed」那条既有取向（见 balance.ts 的
 * formatAmount 与 README）。那条规则针对的是**接口返回的字符串**——把 "34.53"
 * 这种非两位小数的币种重排会悄悄改坏它。而用量金额是我们**自己把一串浮点数加起
 * 来的**，四舍五入的责任本来就在我们这边，不加约束反而会印出 1.2300000000000002。
 * 两者不是一回事，别以为规则被违反了。
 */
export function formatCost(currency: string, value: number): string {
  return `${currency} ${value.toFixed(2)}`;
}

/** UTC 日期（月-日）。用量窗口在周/月两种范围下是按 UTC 日切的。 */
function formatUtcDay(epochSec: number): string {
  const date = new Date(epochSec * 1000);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}
function assemble(sections: readonly Section[]): string {
  return sections
    .filter((section): section is string[] => section !== undefined && section.length > 0)
    .map((section) => section.join("\n"))
    .join("\n\n");
}

function actions(...pairs: readonly (readonly [string, string])[]): string[] {
  return [pairs.map(([label, command]) => `[${label}](command:${command})`).join(" · ")];
}

/** 状态栏要显示的那一条金额；没有余额信息时返回 undefined。 */
function headline(
  snapshot: BalanceSnapshot,
  options: RenderOptions,
): string | undefined {
  const info = selectInfo(snapshot.infos, options.currency);
  return info === undefined ? undefined : formatAmount(info);
}

function balanceLines(snapshot: BalanceSnapshot): string[] {
  if (snapshot.infos.length === 0) return ["（无余额信息）"];
  return snapshot.infos.map(formatDetailed);
}

function snapshotSection(snapshot: BalanceSnapshot): string[] {
  return [
    ...balanceLines(snapshot),
    "",
    snapshot.isAvailable
      ? "$(check) 账户状态：可用"
      : "$(circle-slash) 账户状态：不可用于 API 调用",
    `$(history) 上次更新：${formatTime(snapshot.fetchedAt)}`,
    // 接口地址**不放悬停里**：它是排查代理配错的诊断信息，日常悬停不需要，
    // 放在那里只是噪音。改到「查看余额详情」的 QuickPick 里，诊断能力不丢。
  ];
}

const DEFAULT_ACTIONS = actions(
  ["立即刷新", COMMAND_REFRESH],
  ["查看详情", COMMAND_SHOW_DETAILS],
  ["设置", COMMAND_OPEN_SETTINGS],
);

/**
 * 三个时间范围的显示名与切换命令。顺序也是 tooltip 里的展示顺序。
 *
 * 导出是给 commands.ts 用的：配置被工作区层覆盖时要如实说出「被覆盖成了哪个
 * 范围」，那里需要一个不会跟这里写法漂移的显示名来源。
 */
export const USAGE_RANGE_LABELS: Record<UsageRange, string> = {
  today: "今日",
  week: "近 7 天",
  month: "本月",
};

const USAGE_RANGE_ORDER: readonly UsageRange[] = ["today", "week", "month"];

/** 同样导出给 commands.ts：范围→命令 id 的映射只能有一份，否则会注册出错位的命令。 */
export const USAGE_RANGE_COMMANDS: Record<UsageRange, string> = {
  today: COMMAND_USAGE_RANGE_TODAY,
  week: COMMAND_USAGE_RANGE_WEEK,
  month: COMMAND_USAGE_RANGE_MONTH,
};

/**
 * 用量段。`undefined` 表示「这一态不显示用量」，调用方与既有用例都不受影响。
 *
 * 范围**只说一遍**：当前范围进标题行，其余两个才做成命令链接。粗体而不是链接，
 * 是因为点一个「已经是当前值」的链接除了让 tooltip 消失没有任何作用。
 */
function usageSection(
  view: UsageView | undefined,
  options: RenderOptions,
): Section {
  if (view === undefined) return undefined;

  const current = options.usageRange;
  const links = USAGE_RANGE_ORDER.filter((range) => range !== current).map(
    (range) => `[${USAGE_RANGE_LABELS[range]}](command:${USAGE_RANGE_COMMANDS[range]})`,
  );
  const title = `**用量 · ${USAGE_RANGE_LABELS[current]}**    ${links.join(" · ")}`;

  switch (view.kind) {
    case "unconfigured":
      return [
        title,
        "",
        "$(key) 未配置用量 Token。余额显示不受影响；配置后会额外显示控制台用量。",
        ...actions(["去配置", COMMAND_SET_USAGE_TOKEN]),
      ];

    case "loading":
      return [title, "", "$(sync~spin) 正在获取用量…"];

    case "error":
      return [
        title,
        "",
        `$(warning) ${view.message}`,
        ...actions(
          ...(view.expired
            ? ([["重新获取 Token", COMMAND_SET_USAGE_TOKEN]] as const)
            : []),
          ["重试", COMMAND_REFRESH] as const,
        ),
      ];

    case "ok": {
      const { snapshot } = view;
      // 刚切范围时手上还是上一个范围的快照。拿它顶着新标题显示就是把近 7 天的
      // 数字标成「本月」——宁可按「正在获取」处理，也不要标错的数据。
      if (snapshot.range !== options.usageRange) {
        return [title, "", "$(sync~spin) 正在获取用量…"];
      }

      const inputTokens = snapshot.cacheHitTokens + snapshot.cacheMissTokens;
      const lines = [
        `${formatCost(snapshot.currency, snapshot.cost)} · 请求 ${formatTokens(snapshot.requests)} 次`,
        `Token 输入 ${formatTokens(inputTokens)}` +
          `（缓存命中 ${formatTokens(snapshot.cacheHitTokens)} / 未命中 ${formatTokens(snapshot.cacheMissTokens)}）` +
          ` · 输出 ${formatTokens(snapshot.outputTokens)}`,
      ];

      // 周/月是按 UTC 日切的（本地对齐的长窗口会被接口拒掉），所以把窗口摊开，
      // 让这个口径差别看得见，而不是含糊地说「本月」。
      if (snapshot.range !== "today") {
        lines.push(
          `$(globe) 窗口 ${formatUtcDay(snapshot.start)} → ${formatUtcDay(snapshot.end)}（UTC 日界，与本地日界可能相差数小时）`,
        );
      }
      lines.push(`$(history) 用量更新：${formatTime(snapshot.fetchedAt)}`);

      return [title, "", ...lines];
    }
  }
}

export function render(
  state: StatusState,
  options: RenderOptions,
  usage?: UsageView,
): StatusViewModel {
  switch (state.kind) {
    case "no-key":
      // 这一态**不显示**用量段：它的主题是「去配 API Key」，而且用量轮询本来就
      // gate 在「已配置 API Key」上（未配置的用户不该向第三方主机发请求），
      // 所以这里也不可能有真实用量可显示。
      return {
        text: "$(key) DeepSeek",
        tooltip: assemble([
          ["**DeepSeek 余额**"],
          ["尚未配置 API Key。"],
          actions(["设置 API Key", COMMAND_SET_API_KEY]),
        ]),
        command: COMMAND_SET_API_KEY,
        accessibleLabel: "DeepSeek 余额：尚未配置 API Key",
      };

    case "loading": {
      const previous = state.previous;
      const amount = previous === undefined ? undefined : headline(previous, options);
      return {
        text: amount === undefined ? "$(sync~spin) DeepSeek" : `$(sync~spin) ${amount}`,
        tooltip: assemble([
          ["**DeepSeek 余额**"],
          [
            "正在刷新…",
            ...(previous === undefined
              ? []
              : [`上次成功获取：${formatTime(previous.fetchedAt)}`]),
          ],
          previous === undefined ? undefined : snapshotSection(previous),
          usageSection(usage, options),
          DEFAULT_ACTIONS,
        ]),
        command: COMMAND_REFRESH,
        accessibleLabel: "DeepSeek 余额：正在刷新",
      };
    }

    case "ok": {
      const { snapshot, stale } = state;
      const amount = headline(snapshot, options);
      const info = selectInfo(snapshot.infos, options.currency);

      let text: string;
      let colorId: string | undefined;
      let backgroundColorId: string | undefined;
      let notes: string[] | undefined;
      let label: string;

      if (!snapshot.isAvailable) {
        // 钱还在，只是不能用于 API 调用——独立成一态，不并进通用错误。
        text = `$(circle-slash) ${amount ?? "DeepSeek"}`;
        colorId = WARNING_FG;
        backgroundColorId = WARNING_BG;
        notes = [
          "**账户余额当前不可用**（is_available 为 false）：资金仍然存在，但无法用于 API 调用，请检查账户状态。",
        ];
        label = "DeepSeek 余额：账户余额当前不可用于 API 调用";
      } else if (isLow(info, options.lowBalanceThreshold)) {
        text = `$(warning) ${amount ?? "DeepSeek"}`;
        colorId = WARNING_FG;
        backgroundColorId = WARNING_BG;
        notes = [
          `**$(warning) 余额低于阈值 ${options.lowBalanceThreshold}，请及时充值。**`,
        ];
        label = `DeepSeek 余额：${amount ?? "未知"}，低于告警阈值`;
      } else if (stale) {
        // 只改前景色，不设背景——过期是「提醒」不是「告警」。
        text = `$(warning) ${amount ?? "DeepSeek"}`;
        colorId = WARNING_FG;
        notes = [
          `$(warning) 数据可能已过期（上次成功获取：${formatTime(snapshot.fetchedAt)}）。`,
        ];
        label = `DeepSeek 余额：${amount ?? "未知"}，数据可能已过期`;
      } else {
        text = `$(credit-card) ${amount ?? "DeepSeek"}`;
        label = `DeepSeek 余额：${amount ?? "无余额信息"}`;
      }

      return {
        text,
        tooltip: assemble([
          ["**DeepSeek 账户余额**"],
          notes,
          snapshotSection(snapshot),
          usageSection(usage, options),
          DEFAULT_ACTIONS,
        ]),
        ...(colorId === undefined ? {} : { colorId }),
        ...(backgroundColorId === undefined ? {} : { backgroundColorId }),
        command: COMMAND_REFRESH,
        accessibleLabel: label,
      };
    }

    case "error": {
      const { error, previous } = state;
      const previousAmount =
        previous === undefined ? undefined : headline(previous, options);
      const isAuth = error.kind === "unauthorized" || error.kind === "forbidden";

      let text: string;
      let colorId = WARNING_FG;
      let backgroundColorId: string | undefined;
      let command = COMMAND_REFRESH;
      let label: string;

      if (isAuth) {
        // 密钥无效时状态栏不留旧数字——旁边挂个过期数字容易被误读。
        // 旧值仍然出现在 tooltip 里，并标注已过期。
        text = "$(error) DeepSeek 密钥无效";
        colorId = ERROR_FG;
        backgroundColorId = ERROR_BG;
        command = COMMAND_SET_API_KEY;
        label = "DeepSeek 余额：API Key 无效";
      } else if (previousAmount !== undefined) {
        // 保留最后已知良好值，避免一次网络抖动就把状态栏清空。
        text = `$(warning) ${previousAmount}`;
        label = `DeepSeek 余额：${previousAmount}，刷新失败`;
      } else if (error.kind === "malformed") {
        text = "$(warning) DeepSeek 数据异常";
        label = "DeepSeek 余额：接口数据异常";
      } else {
        text = "$(warning) DeepSeek 连接失败";
        label = "DeepSeek 余额：连接失败";
      }

      const staleNote =
        isAuth && previous !== undefined
          ? `$(warning) 上次成功获取的值：${headline(previous, options) ?? "（无余额信息）"}（已过期）`
          : undefined;

      return {
        text,
        tooltip: assemble([
          ["**DeepSeek 余额**"],
          [`**$(error) ${error.message}**`],
          ...(staleNote === undefined ? [] : [[staleNote] as string[]]),
          ...(error.httpStatus === undefined
            ? []
            : [[`$(server) HTTP 状态码：${error.httpStatus}`] as string[]]),
          previous === undefined ? undefined : snapshotSection(previous),
          usageSection(usage, options),
          isAuth
            ? actions(
                ["重新设置 API Key", COMMAND_SET_API_KEY],
                ["查看详情", COMMAND_SHOW_DETAILS],
              )
            : DEFAULT_ACTIONS,
        ]),
        colorId,
        ...(backgroundColorId === undefined ? {} : { backgroundColorId }),
        command,
        accessibleLabel: label,
      };
    }
  }
}
