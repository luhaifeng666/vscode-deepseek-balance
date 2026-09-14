import type { AppConfig } from "./config";
import type { UsageResult } from "./deepseek/types";
import { fetchUsage } from "./deepseek/usage";
import type { UsageView } from "./render";
import type { RefreshTrigger } from "./controller";

export interface UsageControllerDeps {
  getUsageToken: () => Promise<string | undefined>;
  /** 余额是否已经配好 API Key。用量轮询 gate 在它上面，见下。 */
  hasApiKey: () => Promise<boolean>;
  getConfig: () => AppConfig;
  /**
   * 用量接口地址。由调用方注入而**不是**配置项：前者让 integration/冒烟/本地 mock
   * 指得过去（否则这个客户端整个测不了），后者只会扩大「用户被诱导把 Token 发到
   * 恶意地址」的攻击面。extension.ts 传的是 resolveUsageBaseUrl() 的结果。
   */
  baseUrl: string;
  onView: (view: UsageView) => void;
  debug: (message: string) => void;
  warn: (message: string) => void;
}

/**
 * 用量控制器。
 *
 * ── 它**不起自己的定时器** ────────────────────────────────────────
 *
 * 余额控制器已经按 refreshInterval 稳定心跳了，这里只是搭它的车：extension.ts
 * 把那三处既有的订阅（config / focus / state）各多扇出一条给 refresh()，本类内部
 * 再用「陈旧门槛」决定这次要不要真的发请求。
 *
 * 为什么不自己起一个定时器：`refreshInterval: 0` 的语义是**关闭自动刷新**
 * （package.json、config.ts、controller.ts:240 三处一致）。自己起定时器就得再发明
 * 一个间隔旋钮，而任何形如 `max(refreshInterval, 15)` 的写法都会让用户在明确关掉
 * 后台刷新之后，仍然每 15 分钟被我们打一次 platform.deepseek.com 的私有接口。
 * 搭车就自然没有这个问题：余额不轮询，用量也不轮询。
 *
 * ── 为什么另写一类而不是给 RefreshController 加参数 ────────────────
 *
 * 余额那套语义全是余额专属的：isStale 在 refreshInterval === 0 时**故意**返回
 * false、notify 会弹 VS Code 警告框、鉴权失败时清 snapshot。用量这三样一个都不要
 * （用量失败必须完全静默）。为「静默」在 5 个方法里穿分支，比另写一份更贵也更容易
 * 在改动余额时误伤用量。
 */
export class UsageController {
  private inFlight: Promise<void> | undefined;
  private abort: AbortController | undefined;
  private generation = 0;
  private disposed = false;
  private view: UsageView = { kind: "loading" };
  private lastAttemptAt = 0;
  private lastRange: AppConfig["usageRange"] | undefined;
  /** 上一次「已经告诉过用户 Token 过期」的凭据指纹，避免每次轮询都重复提示。 */
  private lastExpiredToken: string | undefined;

  constructor(private readonly deps: UsageControllerDeps) {}

  getView(): UsageView {
    return this.view;
  }

  /**
   * 由余额心跳、配置变更、窗口聚焦、手动刷新共同触发。
   *
   * `trigger` 决定要不要走陈旧门槛：
   * - `startup` / `manual` / `config` / `key-change` 一定重查；
   * - `timer` / `focus` 在阈值内直接跳过。
   *
   * ⚠️ `startup` **必须**在强制那组里。否则 `refreshInterval: 0`（用户关掉自动
   * 刷新）的用户启动后用量会永远停在「正在获取用量…」——因为陈旧门槛见 0 就返回
   * false，一次都不查。余额那边 start() 也是无条件查一次的，语义一致。
   */
  refresh(trigger: RefreshTrigger): Promise<void> {
    if (this.disposed) return Promise.resolve();

    const config = this.deps.getConfig();
    const rangeChanged = this.lastRange !== undefined && this.lastRange !== config.usageRange;
    const force =
      trigger === "startup" ||
      trigger === "manual" ||
      trigger === "config" ||
      trigger === "key-change" ||
      rangeChanged;

    if (!force && !this.isStale(config)) return Promise.resolve();
    // 在途时再触发不重复发请求；沿用余额控制器 controller.ts:53-66 的合流做法。
    if (this.inFlight !== undefined) return this.inFlight;

    const promise = this.run(trigger, config).finally(() => {
      if (this.inFlight === promise) this.inFlight = undefined;
    });
    this.inFlight = promise;
    return promise;
  }

  /** 窗口重新获得焦点：复用余额那边同样的判断口径。 */
  onFocus(): void {
    if (this.disposed) return;
    void this.refresh("focus");
  }

  /**
   * API Key 变更。存在的理由只有一个：**轮询 gate 挂在 API Key 上**。
   *
   * 没配 Key 时我们连请求都不发（见 run），那条路径不会设置 lastAttemptAt，于是
   * 从「无 Key」变成「有 Key」之后，靠陈旧门槛其实也能放行——但那是**碰巧**成立：
   * 门槛的标准是「上次尝试」，而这里的语义是「gate 的前提变了」。把这句话写明，
   * 将来谁给未配置路径加上 lastAttemptAt 时就不会默默把首次用量查询锁死。
   */
  onApiKeyChanged(): void {
    if (this.disposed) return;
    this.lastAttemptAt = 0;
    void this.refresh("key-change");
  }

  /** 用量 Token 变更。⚠️ 绝不能去动余额控制器的 snapshot。 */
  onTokenChanged(): void {
    if (this.disposed) return;
    this.invalidate();
    this.lastAttemptAt = 0;
    this.lastExpiredToken = undefined;
    void this.refresh("key-change");
  }

  dispose(): void {
    this.disposed = true;
    this.abort?.abort();
    this.abort = undefined;
  }

  private async run(trigger: RefreshTrigger, config: AppConfig): Promise<void> {
    const generation = this.generation;
    this.lastRange = config.usageRange;

    // 未配 API Key 时**一个请求都不发**。
    //
    // 这不是省事，是隐私边界：no-key 态下 tooltip 根本不渲染用量段，此时若还去
    // 轮询，就是一个从没配过 API Key 的用户每 5 分钟被我们向 platform.deepseek.com
    // 打一次，换回一份永不展示的数据——整个设计里唯一「用户看不到收益却打了第三方
    // 主机」的路径，直接和 README 的隐私声明冲突。
    if (!(await this.deps.hasApiKey())) {
      if (this.isOutdated(generation)) return;
      this.emit({ kind: "unconfigured" });
      return;
    }

    const token = await this.deps.getUsageToken();
    if (this.isOutdated(generation)) return;

    if (token === undefined) {
      this.emit({ kind: "unconfigured" });
      return;
    }

    const requestAbort = new AbortController();
    this.abort = requestAbort;
    this.lastAttemptAt = Date.now();

    const result: UsageResult = await fetchUsage({
      token,
      baseUrl: this.deps.baseUrl,
      range: config.usageRange,
      signal: requestAbort.signal,
    });

    if (this.abort === requestAbort) this.abort = undefined;
    if (this.isOutdated(generation)) return;

    // 调用方取消是静默的：dispose 或 Token 变更正好落在请求在途时会走到这里，
    // 冒一条用户可见的错误是错的。与 client.ts:120-122 同一个区分。
    if (!result.ok && result.error.message === "请求已取消。") return;

    if (!result.ok) {
      this.handleError(result.error.kind, result.error.message, token, trigger);
      return;
    }

    this.lastExpiredToken = undefined;
    this.deps.debug(
      `用量刷新成功：${result.snapshot.range} 窗口 cost=${result.snapshot.cost} requests=${result.snapshot.requests}。`,
    );
    this.emit({ kind: "ok", snapshot: result.snapshot });
  }

  /**
   * 用量失败**完全静默**：只记日志、只改 tooltip，绝不弹窗。
   *
   * 唯一例外是「Token 过期」且这次是用户主动触发的——那条得让人知道要去换 Token，
   * 否则悬停里那行小字很容易被忽略。同一枚 Token 只提示一次（lastExpiredToken），
   * 免得每次轮询都弹。
   */
  private handleError(
    kind: string,
    message: string,
    token: string,
    trigger: RefreshTrigger,
  ): void {
    this.deps.debug(`用量刷新失败：${kind} —— ${message}`);
    this.emit({ kind: "error", message, expired: kind === "expired" });

    if (kind === "expired" && trigger === "manual" && this.lastExpiredToken !== token) {
      this.lastExpiredToken = token;
      this.deps.warn("DeepSeek 用量 Token 已失效。");
    }
  }

  private isStale(config: AppConfig): boolean {
    // refreshInterval <= 0 = 用户关掉了自动刷新，这里就只在明确触发时查。
    // （注意方向与余额的 isStale 相反：那边在关掉时不判过期，这边是根本不轮询。）
    if (config.refreshInterval <= 0) return false;
    if (this.lastAttemptAt === 0) return true;
    // 与余额的阈值同量级：两倍心跳周期，且不低于 5 分钟。用量是慢变量，没必要
    // 跟余额一样频繁。
    //
    // ⚠️ 口径是**上次尝试**，不是上次成功。按成功算的话，首次请求失败的用户
    // lastAttemptAt 一直是 0，于是每次窗口聚焦都判定「过期」——聚焦是高频动作，
    // 就成了对着一个已知连不上的地址反复打。按尝试算，最密也就是一个阈值周期一次。
    return Date.now() - this.lastAttemptAt > Math.max(2 * config.refreshInterval, 5) * 60_000;
  }

  private isOutdated(generation: number): boolean {
    return this.disposed || generation !== this.generation;
  }

  private invalidate(): void {
    this.generation += 1;
    this.abort?.abort();
    this.abort = undefined;
    this.inFlight = undefined;
  }

  private emit(view: UsageView): void {
    if (this.disposed) return;
    this.view = view;
    this.deps.onView(view);
  }
}
