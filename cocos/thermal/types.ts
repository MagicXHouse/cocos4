/*
 Copyright (c) 2026 Xiamen Yaji Software Co., Ltd.

 https://www.cocos.com/

 Permission is hereby granted, free of charge, to any person obtaining a copy
 of this software and associated documentation files (the "Software"), to deal
 in the Software without restriction, including without limitation the rights to
 use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies
 of the Software, and to permit persons to whom the Software is furnished to do so,
 subject to the following conditions:

 The above copyright notice and this permission notice shall be included in
 all copies or substantial portions of the Software.

 THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 THE SOFTWARE.
*/

/**
 * @en Unified thermal level normalized from raw platform signals.
 * @zh 由各平台原始信号归一化得到的统一温控等级。
 */
import type { Material } from '../asset/assets/material';

export enum ThermalLevel {
    Normal = 0,
    Hot = 1,
    Emergency = 2,
}

/**
 * @en Downgrade order preset. Exposed as a named type so runtime setters
 * (`Thermal.setDowngradeOrder`) and callers share one contract.
 * @zh 降档顺序预设。抽成具名类型，方便运行时 setter（`Thermal.setDowngradeOrder`）与调用方共用同一契约。
 */
export type ThermalDowngradeOrder = 'scale-first' | 'frameRate-first';

/**
 * @en Configurable parameters of the thermal strategy. Every field is optional and carries a default value.
 * @zh 温控策略的可配置参数。所有字段均可选并带有默认值。
 */
export interface ThermalConfig {
    /**
     * @en Target frame rate used to derive the frame time budget. Reserved for now: the phase-1
     * controller derives the budget from the current game.frameRate instead.
     * @zh 用于推导帧时间预算的目标帧率。当前预留：一期控制器改用当前 game.frameRate 推导预算。
     */
    targetFps?: number;
    /**
     * @en Down-grade trigger threshold in percent over the frame time budget. Default 10.
     * @zh 降档触发阈值（相对帧时间预算超出的百分比），默认 10。
     */
    triggerPercent?: number;
    /**
     * @en Up-grade recover threshold in percent of the frame time budget. Default -10.
     * DEPRECATED in phase 1: the frame-time-below-budget signal is unreliable under a frame cap
     * (measured frame time is pulled up to the budget), so upgrades use probe-based recovery
     * (see `cocos/thermal/upgrade-design.md`). The field is kept for phase-2 "signal-driven upgrade"
     * (temperature/headroom + frame time) and only takes effect when `signalDrivenUpgrade` is true;
     * by default the strategy is downgrade-only.
     * @zh 升档恢复阈值（相对帧时间预算的百分比），默认 -10。**一期废弃**：限帧下"帧时间低于预算"信号失真，
     * 升档已改为试探式（见 `cocos/thermal/upgrade-design.md`）。字段保留给二期"信号驱动升档"
     * （温度/headroom + 帧时间双条件），且**只有 `signalDrivenUpgrade` 为 true 时才生效**；
     * 默认策略是"只降不升"。
     */
    recoverPercent?: number;
    /**
     * @en Enables the frame-time-driven UP branch of the strategy (phase-2 "signal-driven upgrade").
     * Default **false** in phase 1: the branch is unreachable in a capped mini game anyway, but more
     * importantly an upgrade triggered here would bypass probe scheduling/backoff and use the
     * manual frameRate-first order, which contradicts "automatic probe must be scale-first".
     * Keep it false until phase 2 wires real temperature/headroom signals and reuses this branch
     * under the same probe state machine.
     * @zh 是否启用策略里"帧时间低于预算就升档"的 UP 分支（二期"信号驱动升档"）。
     * 一期默认 **false**：限帧下这个分支本来就几乎不可达，更关键的是它一旦触发，
     * 会绕过试探的排期与退避、并走手动的 frameRate-first 顺序，与"自动试探必须 scale-first"冲突。
     * 二期接入真实温度/headroom 信号、并把它纳入同一套试探状态机之后再打开。
     */
    signalDrivenUpgrade?: boolean;
    /**
     * @en Sliding window length in seconds used to average the frame time. Default 20.
     * @zh 平均帧时间的滑动窗口时长（秒），默认 20。
     */
    windowSeconds?: number;
    /**
     * @en Recovery confirmation window in seconds. A recovery only fires after the frame time
     * stays below the recover threshold continuously for this duration. Default 5.
     * @zh 恢复确认窗口时长（秒）。恢复条件需持续满足该时长才触发升档，默认 5。
     */
    recoverWindowSeconds?: number;
    /**
     * @en Minimum allowed frame rate. Default 30.
     * @zh 允许的最低帧率，默认 30。
     */
    minFrameRate?: number;
    /**
     * @en Downgrade order preset. `scale-first` (default) lowers the shading scale before the
     * frame rate; `frameRate-first` does the opposite. Exposed because only the game knows whether
     * it is resolution-sensitive or frame-rate-sensitive (plan §2.3). Upgrade order is NOT
     * configurable: manual stepUp is always frameRate-first, auto probe is always scale-first.
     * @zh 降档顺序预设。`scale-first`（默认）先降分辨率再降帧率；`frameRate-first` 相反。
     * 开放这个开关是因为只有开发商清楚自己的游戏对分辨率还是对帧率更敏感（方案 §2.3）。
     * **升档顺序不开放**：手动 stepUp 固定 frameRate-first、自动试探固定 scale-first。
     */
    downgradeOrder?: 'scale-first' | 'frameRate-first';    /**
     * @en Minimum allowed rendering scale. Default 0.3.
     * @zh 允许的最低渲染缩放，默认 0.3。
     */
    minScale?: number;
    /**
     * @en Whether the thermal controller may lower the rendering scale. Default true.
     *
     * IMPORTANT: the engine's runtime shading scale only resizes the render targets of 3D
     * cameras. It does NOT scale a Canvas/UI camera, so a full-screen 2D Sprite/UI shader keeps
     * running at native resolution. If the game's dominant load is 2D/UI, set this to false and
     * use the frame-rate lever only.
     * @zh 是否允许温控降低渲染缩放，默认 true。
     *
     * 注意：引擎的运行时 shadingScale 只缩放 3D 相机的渲染目标，不会缩放 Canvas/UI 相机。
     * 因此全屏 2D Sprite/UI Shader 仍按原生分辨率运行。如果游戏主负载是 2D/UI，应设为 false，
     * 只使用帧率杠杆。
     */
    enableScale?: boolean;
    /**
     * @en Cool-down time in seconds between two consecutive adjustments. Default 10.
     * @zh 两次调整之间的冷却时间（秒），默认 10。
     */
    cooldownSeconds?: number;
    /**
     * @en Whether to print a console line for every executed down/up step. Default true.
     * @zh 每次真正执行降/升档时是否打印 console 日志。默认 true。
     */
    logActions?: boolean;
    /**
     * @en Whether to run the resolution effectiveness probe. When false (default), a resolution
     * downgrade is always followed by the next resolution tier after the cooldown, then the frame
     * rate. Enable it for workloads where resolution is expected to move frame time.
     * When enabled, a step that crosses the FSR threshold (`fsrMinScale`) does NOT arm the probe:
     * that step changes both resolution and FSR state, so its frame-time delta is not a clean
     * measurement of "resolution only".
     * @zh 是否启用分辨率有效性探针。默认 false：分辨率每档等冷却后继续降，降到地板再降帧率。
     * 如果场景预期分辨率能改善帧时间，可以打开。
     * 打开后，**跨过 FSR 开关阈值（`fsrMinScale`）的那一步不参与判定**：那一步同时改了分辨率和
     * FSR 状态，帧时间差不能单独归因于分辨率。
     */
    scaleEffectCheck?: boolean;
    /**
     * @en Warm-up time after enable/resume in seconds. No action is taken during this period so
     * that startup jank (shader compilation, scene loading) does not trigger a false downgrade.
     * Default 20 (aligned with the default sampling window).
     * @zh 启用/恢复后的预热时长（秒）。预热期内不动作，避免启动卡顿（shader 编译、场景加载）
     * 触发误降档。默认 20，与默认采样窗口对齐。
     */
    warmupSeconds?: number;
    /**
     * @en Master switch for probe-based automatic upgrade. When false (default), the thermal control
     * is downgrade-only (auto-UP never fires; manual stepUp() still works). When true, the controller
     * actively probes to upgrade one tier after a downgrade (see `cocos/thermal/upgrade-design.md`).
     * Phase 1 keeps it false by default so that "downgrade effectiveness + temperature drop" can be
     * measured in isolation; enable it to also verify the full downgrade→probe-upgrade loop.
     * @zh 试探式自动升档的总开关。默认 false：温控"只降不升"（自动升档永不触发，手动 stepUp() 仍可用）。
     * 设为 true 后，控制器会在降档后主动试探升档（见 `cocos/thermal/upgrade-design.md`）。
     * 一期默认关闭，便于单独测量"降档有效性 + 温度下降"；开启后可验证完整的"降档→试探升档"闭环。
     */
    enableAutoUpgrade?: boolean;
    /**
     * @en Quiet period in seconds after a downgrade before the first automatic probe-upgrade.
     * After a successful probe the next probe fires immediately (does NOT wait this interval);
     * only the transition from "idle after a downgrade" to "first probe" uses it. Default 60.
     * @zh 降档后到"第一次"自动试探升档的静默期（秒）。试探成功后立即继续下一档（不等此时长），
     * 只有"降档后从空闲态启动新一轮试探"才用它。默认 60。
     */
    probeIntervalSeconds?: number;
    /**
     * @en Recovery probe window in seconds. If a downgrade happens within this window after an
     * upgrade, the upgrade is treated as failed and the next upgrade of that lever is backed off.
     * Default 15.
     * @zh 升档试验窗口（秒）。升档后该窗口内又降档，视为升档失败，对该杠杆的下次升档退避。默认 15。
     */
    recoveryProbeSeconds?: number;
    /**
     * @en Base recovery backoff in seconds after a failed upgrade. Doubles on each consecutive
     * failure. Default 60.
     * @zh 升档失败后的基础退避时长（秒），连续失败翻倍。默认 60。
     */
    recoveryBackoffSeconds?: number;
    /**
     * @en Maximum recovery backoff in seconds. Default 600.
     * @zh 升档退避上限（秒）。默认 600。
     */
    recoveryBackoffMaxSeconds?: number;
    /**
     * @en Time to wait after a resolution downgrade before judging whether it actually reduced
     * the frame time, in seconds. Default 5.
     * @zh 分辨率降档后等待多久再判断它是否真的降低了帧时间（秒）。默认 5。
     */
    scaleEffectProbeSeconds?: number;
    /**
     * @en Minimum frame-time improvement (percent) for a resolution downgrade to be considered
     * effective. Default 5.
     * @zh 分辨率降档被视为有效所需的最小帧时间改善百分比。默认 5。
     */
    scaleEffectMinImprovementPercent?: number;
    /**
     * @en How long a resolution lever stays marked ineffective after a failed effectiveness probe,
     * in seconds. Default 60.
     * @zh 分辨率杠杆被判定无效后保持多久（秒）。默认 60。
     */
    scaleIneffectiveSeconds?: number;
    /**
     * @en Whether the thermal module enables FSR when it lowers the shading scale. Default true.
     *
     * IMPORTANT: FSR upscales the SAME 3D render target that shadingScale shrinks. It cannot
     * compensate a Canvas/UI camera's resolution, because the UI pass is rendered after the 3D
     * upscale at native resolution. For 2D/UI-heavy games, keep enableScale/enableFsr false and
     * use the frame-rate lever only.
     * Requires the custom pipeline (`WebPipeline` with the 'Builtin' builder, i.e. the
     * `custom-pipeline` + `custom-pipeline-builtin-scripts` features) and an FSR material
     * (`pipeline/post-process/fsr1`, e.g. `builtin-fsr.mtl`) passed via `fsrMaterial` /
     * `setFsrMaterial`. Without a material it falls back to plain downsampling.
     * @zh 温控降分辨率时是否启用 FSR。默认 true。需要自定义管线（`WebPipeline` + 'Builtin' builder，
     * 即启用 `custom-pipeline` + `custom-pipeline-builtin-scripts` 特性）以及一份 FSR 材质
     * （`pipeline/post-process/fsr1`，例如 `builtin-fsr.mtl`），通过 `fsrMaterial` / `setFsrMaterial`
     * 传入。没有材质时回退为普通降采样。
     */
    enableFsr?: boolean;
    /**
     * @en Optional FSR material (`pipeline/post-process/fsr1`). If omitted, the material already
     * assigned to the camera's `BuiltinPipelineSettings` is used. The game can load
     * `builtin-fsr.mtl` and pass it here, or call `thermal.setFsrMaterial(material)` after loading.
     * @zh 可选的 FSR 材质（`pipeline/post-process/fsr1`）。不传时使用相机 `BuiltinPipelineSettings`
     * 上已配置的材质。游戏可以加载 `builtin-fsr.mtl` 后传进来，或加载完成后调用
     * `thermal.setFsrMaterial(material)`。
     */
    fsrMaterial?: Material;
    /**
     * @en FSR sharpness in [0, 1]. Default 0.8.
     * @zh FSR 锐度，范围 [0, 1]，默认 0.8。
     */
    fsrSharpness?: number;
    /**
     * @en The largest shading scale at which FSR is enabled (`scale <= fsrMinScale`). Default 0.85.
     * Set it to 1.0 to always upscale whenever the resolution is lowered; set it lower (e.g. 0.7)
     * when FSR's fixed cost (two native-resolution full-screen passes) outweighs the saving of the
     * first tier.
     * @zh 启用 FSR 的最大 shadingScale（`scale <= fsrMinScale` 才开）。默认 0.85。
     * 设为 1.0 = 只要降分辨率就升采样；设为更低（如 0.7）= 0.85 档先纯降采样，0.7 档才开 FSR
     * （FSR 的固定开销是两个原生分辨率全屏 pass，浅档可能入不敷出）。
     */
    fsrMinScale?: number;
}

/**
 * @en A function that returns the current high-resolution timestamp in milliseconds.
 * @zh 返回当前高精度时间戳（毫秒）的函数。
 */
export type FrameTimeSource = () => number;

/**
 * @en Samples raw frame time on the JS side without touching core.
 * @zh 在 JS 侧自采原始帧时间，不动 core。
 */
export interface IFrameTimeSampler {
    start (): void;
    stop (): void;
    getAverageFrameTimeMs (): number;
    /**
     * @en Number of samples currently in the window. Optional; when provided, the controller refuses to
     * decide on a nearly-empty window (a single slow gap would otherwise dominate the average).
     * @zh 当前窗口内的样本数。可选；提供后控制器不会在"半空窗口"上下判定
     * （否则一个异常慢帧就会把均值拉爆，导致误降档）。
     */
    getSampleCount?(): number;
    reset (): void;
    /**
     * @en Length of the sliding window in seconds. Optional: when provided, the controller aligns its
     * resume() warm-up with this length, so the first post-resume decision is not based on a half-empty window.
     * @zh 滑动窗口长度（秒）。可选：提供后，控制器的 resume() 预热会对齐到这个长度，
     * 避免恢复后的第一次决策建立在"半空的窗口"上。
     */
    windowSeconds?: number;
}

/**
 * @en Decision made by the thermal strategy for a single update step.
 * @zh 温控策略单步更新时给出的决策。
 */
export type ThermalStrategyAction = 'NONE' | 'DOWN' | 'UP';

/**
 * @en Direction of one executed thermal action.
 * @zh 一次实际执行的温控动作方向。
 */
export type ThermalActionDirection = 'DOWN' | 'UP';

/**
 * @en Lever changed by one thermal action.
 * @zh 一次温控动作改动的杠杆。
 */
export type ThermalActionLever = 'frameRate' | 'scale';

/**
 * @en Detailed information about one executed thermal action. Emitted after the action has been
 * applied, so from/to are the real values and level is the new level.
 * @zh 一次实际执行的温控动作详情。在动作生效后发出，from/to 是真实前后值，level 是新等级。
 */
export interface ThermalActionEvent {
    direction: ThermalActionDirection;
    lever: ThermalActionLever;
    from: number;
    to: number;
    level: ThermalLevel;
    timestamp: number;
    avgMs?: number;
    targetMs?: number;
    reason?: 'trigger' | 'recover' | 'manual';
}

/**
 * @en Snapshot of the current thermal state.
 * @zh 当前温控状态快照。
 */
export interface ThermalState {
    level: ThermalLevel;
    frameRate: number;
    shadingScale: number;
    /** Whether the scale lever is currently allowed to move. */
    scaleEnabled: boolean;
    enabled: boolean;
    paused: boolean;
}

/**
 * @en Minimal strategy: frame time budget plus hysteresis.
 * @zh 最小策略：帧时间预算 + 迟滞。
 */
export interface IThermalStrategy {
    update (avgMs: number, targetMs: number): ThermalStrategyAction;
    setThreshold (percent: number): void;
    setRecoverThreshold (percent: number): void;
    setRecoverWindowSeconds (seconds: number): void;
    setCooldownSeconds (seconds: number): void;
    reset (): void;
}

/**
 * @en Executes a thermal action (frame rate / rendering scale).
 * @zh 执行温控动作（帧率 / 渲染缩放）。
 */
export interface IThermalAction {
    stepDown (): boolean;
    stepUp (): boolean;
    restore (): void;
    /**
     * @en Read-only floor query. MUST agree with `stepDown() === false`: it exists so callers can ask
     * "is this lever already at the floor?" without triggering a state change. The controller still uses
     * the `stepDown()` return value as its single decision signal — if you change one, change the other,
     * otherwise the two floor semantics drift apart.
     * @zh 只读的地板查询。**必须**与 `stepDown() === false` 等价：它存在的意义是让调用方在不触发状态变化
     * 的前提下询问"这个杠杆到底了吗"。控制器仍以 `stepDown()` 的返回值为唯一决策依据 ——
     * 改其中一个必须同步改另一个，否则两套地板语义会漂移。
     */
    isAtFloor (): boolean;
    /**
     * @en How many tiers this lever is currently below its original value (0 = not downgraded).
     * Optional so simple test doubles stay valid; when both actions implement it, the controller
     * derives the thermal level from real lever state instead of a running counter (a counter
     * drifts whenever one lever is restored out-of-band, e.g. setScaleEnabled(false)).
     * @zh 该杠杆相对原值当前降了几档（0 = 未降）。可选，便于测试替身保持兼容；当两个动作都实现时，
     * 控制器改为从杠杆实际状态推导温控等级 —— 累加计数器在"单独还原某个杠杆"（如
     * setScaleEnabled(false)）时会漂移。
     */
    getStepsDown?(): number;
    /**
     * @en Returns the current value of this lever (frame rate or shading scale).
     * @zh 返回该杠杆的当前值（帧率或渲染缩放）。
     */
    getCurrent (): number;
    /**
     * @en Whether moving from `from` to `to` crosses the FSR on/off threshold (i.e. the upscale
     * turns on or off on this step). Used by the resolution-effectiveness probe to skip the step
     * whose frame-time delta would mix "resolution change" with "FSR turned on/off".
     * @zh 从 `from` 走到 `to` 是否跨过 FSR 的开关阈值（这一步会让升采样打开或关闭）。
     * 分辨率有效性探针用它跳过"同时改了两个变量"的那一步，避免口径混淆。
     */
    isFsrStateChanging? (from: number, to: number): boolean;
    /**
     * @en Enables/disables this lever. Optional so simple test doubles stay valid.
     * @zh 启用/禁用该杠杆。可选方法，便于测试替身保持兼容。
     */
    setEnabled? (enabled: boolean): void;
    /**
     * @en Whether this lever is enabled. Defaults to true when not implemented.
     * @zh 该杠杆是否启用。未实现时默认视为 true。
     */
    isEnabled? (): boolean;
}

/**
 * @en FSR controller used by the resolution action. It enables FSR when shadingScale < 1 and
 * restores the original FSR settings when the scale is restored.
 * @zh 分辨率动作使用的 FSR 控制器。shadingScale < 1 时启用 FSR，恢复缩放时还原原 FSR 设置。
 */
export interface IThermalFsr {
    apply (scale: number): void;
    restore (): void;
    setMaterial? (material: Material | null): void;
    /**
     * @en Enables/disables FSR without removing the scale lever. Disabling restores the
     * camera's original FSR settings. Optional for test doubles.
     * @zh 启用/禁用 FSR（不影响 scale 杠杆）。禁用时会还原相机原来的 FSR 设置。可选方法，便于测试替身。
     */
    setEnabled? (enabled: boolean): void;
    /**
     * @en Sets the largest shading scale at which FSR is enabled (`scale <= minScale`). Optional.
     * @zh 设置启用 FSR 的最大 shadingScale（`scale <= minScale` 才开）。可选方法。
     */
    setMinScale? (minScale: number): void;
    /**
     * @en Whether FSR would be ON at the given shading scale. Optional (used by the resolution
     * effectiveness probe to skip steps that cross the FSR threshold).
     * @zh 给定 shadingScale 下 FSR 是否会开。可选（分辨率有效性探针用它跳过跨 FSR 阈值的那一步）。
     */
    wouldEnableAt? (scale: number): boolean;
    /**
     * @en Whether FSR is currently enabled.
     * @zh FSR 当前是否启用。
     */
    isEnabled? (): boolean;
}
