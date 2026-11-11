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

import { director, DirectorEvent } from '../game/director';
import { game } from '../game';
import { ThermalLevel } from './types';
import type {
    FrameTimeSource,
    IFrameTimeSampler,
    IThermalAction,
    IThermalStrategy,
    ThermalActionDirection,
    ThermalActionEvent,
    ThermalActionLever,
    ThermalConfig,
    ThermalDowngradeOrder,
    ThermalState,
} from './types';

type ThermalLever = ThermalActionLever;

interface ScaleEffectProbe {
    preAvgMs: number;
    dueAt: number;
}

function defaultReadCurrentFps (): number {
    const fr = game.frameRate;
    const n = typeof fr === 'number' ? fr : parseInt(fr, 10);
    // 0（不限帧）与非法值一律归一到 60：targetMs = 1000 / fps 会因 fps=0 除零成 Infinity。
    return Number.isFinite(n) && n > 0 ? n : 60;
}

function defaultTimeSource (): number {
    return performance.now();
}

/**
 * @en Orchestration layer of the thermal control: wires the sampler, the strategy and the actions
 * into a self-running loop. It listens to the director's AFTER_UPDATE event, throttled to about one
 * evaluation per second, and drives downgrade/upgrade actions based on the strategy's decision.
 * @zh 温控的编排层：把采样器、策略、动作拼成一个自运行的循环。它监听导演的 AFTER_UPDATE 事件，
 * 约每秒评估一次，并按策略决策驱动降/升档动作。
 *
 * Controller-side protections on top of the strategy:
 * 1. Warm-up: no action during warmupSeconds after enable/resume, and the sampling window is cleared
 *    when the warm-up ends, so startup jank (shader compilation, asset upload) cannot trigger a
 *    downgrade on the first post-warm-up decision.
 * 2. Recovery probe + exponential backoff (kept for manual/optional automated upgrades).
 * 3. Optional resolution effectiveness probe (scaleEffectCheck, default off).
 * 4. Action events + optional console logging for every real down/up step.
 * 中文：预热（结束时清窗）、升档试验/退避、可选的分辨率有效性校验、动作事件与日志。
 */
export class ThermalController {
    private static readonly EVALUATE_INTERVAL_MS = 1000;
    private static readonly RESUME_WARMUP_MS = 5000;
    /**
     * 判定所需的最少样本数（窗口内原始帧数）。
     * 20s 窗口在 60fps 下有 ~1200 个样本；少于这个数说明窗口还没填起来
     * （刚 reset / 环境被节流到 1fps），此时均值没有统计意义。
     * 取 30：60fps 下约 0.5s，15fps 下约 2s，足够消除单帧异常的影响。
     */
    private static readonly MIN_DECISION_SAMPLES = 30;

    private _config: ThermalConfig;
    private _sampler: IFrameTimeSampler;
    private _strategy: IThermalStrategy;
    private _frameRateAction: IThermalAction;
    /** 帧率杠杆是否可用（setFrameRateEnabled；默认 true，测试里可隔离单个杠杆） */
    private _frameRateEnabled = true;
    private _scaleAction?: IThermalAction;
    private _readCurrentFps: () => number;
    private _timeSource: FrameTimeSource;

    // _level: 0 = full performance, +1 per downgrade step, -1 per upgrade step.
    private _level = 0;
    private _lastReportedLevel: ThermalLevel = ThermalLevel.Normal;
    private _levelChangeCb: ((level: ThermalLevel) => void) | null = null;
    private _actionCb: ((event: ThermalActionEvent) => void) | null = null;
    private _enabled = false;
    private _paused = false;
    private _lastEvaluateAt = -Infinity;

    // Warm-up: no action until this timestamp.
    private _warmupUntil = 0;
    private _warmupDone = true;

    // Recovery probe/backoff, tracked per lever. Dormant with the default recoverPercent = -10.
    // NOTE: with the phase-1 default (auto-UP never fires because recoverPercent=-10 is unreachable
    // under a frame cap), _recordRecoveryFailure can still write these fields on an auto-DOWN that
    // follows a manual stepUp(), but their only reader _isUpBlocked is skipped by force=true in
    // manual stepUp() — so the backoff state is written but never read in phase 1. It becomes live
    // only when phase 2 enables automatic upgrade. This is intentional, not a bug.
    private _upProbeLever: ThermalLever | null = null;
    private _upProbeAt = 0;
    private _frameRateFailCount = 0;
    private _scaleFailCount = 0;
    private _frameRateUpBlockedUntil = 0;
    private _scaleUpBlockedUntil = 0;

    // Probe-based auto upgrade (phase 1): soft thermal has no "load became light" passive signal
    // (no temperature; frame time is flattened by the frame cap), so recovery is probe-driven —
    // periodically try to upgrade one tier, watch whether the frame time stays stable, keep or
    // revert. _probeIsAuto marks whether the current _upProbeLever observation window was opened by
    // an AUTO probe (vs manual stepUp), so "immediately continue on success" only applies to auto.
    private _probeIsAuto = false;
    private _nextAutoProbeAt = 0;

    // Optional resolution effectiveness probe.
    private _scaleEffectProbe: ScaleEffectProbe | null = null;
    private _scaleIneffectiveUntil = 0;

    /**
     * @param config - Thermal config (also carries the orchestration tunables).
     * @param sampler - Frame time sampler.
     * @param strategy - Thermal strategy (decision maker).
     * @param frameRateAction - Frame rate action (executed after the resolution action on downgrade).
     * @param scaleAction - Optional resolution action (executed first on downgrade when available).
     * @param readCurrentFps - Injectable current-frame-rate reader. Defaults to reading game.frameRate.
     * @param timeSource - Injectable timestamp source (used by tests). Defaults to performance.now.
     */
    constructor (
        config: ThermalConfig,
        sampler: IFrameTimeSampler,
        strategy: IThermalStrategy,
        frameRateAction: IThermalAction,
        scaleAction?: IThermalAction,
        readCurrentFps: () => number = defaultReadCurrentFps,
        timeSource: FrameTimeSource = defaultTimeSource,
    ) {
        this._config = config;
        this._sampler = sampler;
        this._strategy = strategy;
        this._frameRateAction = frameRateAction;
        this._scaleAction = scaleAction;
        this._readCurrentFps = readCurrentFps;
        this._timeSource = timeSource;
        // E04：downgradeOrder 只接受两个预设，非法值回落并告警（避免拼错后静默走默认反而更难查）。
        const order = config.downgradeOrder;
        if (order !== undefined && order !== 'scale-first' && order !== 'frameRate-first') {
            console.warn('[Thermal] downgradeOrder=' + String(order)
                + ' 不是预设值（scale-first / frameRate-first），已回落 scale-first');
        }
    }

    /**
     * @en Starts the loop: starts the sampler and registers the AFTER_UPDATE listener.
     * @zh 启动循环：启动采样器并注册 AFTER_UPDATE 监听。
     */
    public enable (): void {
        if (this._enabled) {
            return;
        }
        this._enabled = true;
        this._paused = false;
        this._resetTransientState();
        this._sampler.start();
        this._warmupUntil = this._timeSource() + this._warmupMs;
        this._warmupDone = false;
        this._lastEvaluateAt = -Infinity;
        director.on(DirectorEvent.AFTER_UPDATE, this._onAfterUpdate, this);
    }

    /**
     * @en Stops the loop: unregisters the listener, stops the sampler, restores all actions and
     * clears the callbacks (zero-overhead when disabled).
     * @zh 停止循环：注销监听、停止采样、还原所有动作并清空回调（关闭后零开销）。
     */
    public disable (): void {
        if (!this._enabled) {
            return;
        }
        this._enabled = false;
        this._paused = false;
        director.off(DirectorEvent.AFTER_UPDATE, this._onAfterUpdate, this);
        this._sampler.stop();
        this._levelChangeCb = null;
        this._actionCb = null;
        this.restore();
    }

    /**
     * @en Sets the downgrade trigger threshold (percent, 1~100). Out-of-range values are rejected
     * with a warning: `<= 0` would downgrade on every evaluation and `> 100` would disable
     * downgrading entirely, both of which are configuration mistakes rather than intent.
     * @zh 设置降档触发阈值（百分比，合法范围 1~100）。越界值告警后忽略：
     * `<= 0` 会变成"每次评估都降档"，`> 100` 等于关闭降档，都属于配置错误而不是意图。
     */
    public setThreshold (percent: number): void {
        if (!Number.isFinite(percent) || percent < 1 || percent > 100) {
            console.warn('[Thermal] setThreshold(' + String(percent) + ') 非法（合法范围 1~100），已忽略');
            return;
        }
        this._strategy.setThreshold(percent);
    }

    /**
     * @en Switches the downgrade order at runtime. `_doStepDown` reads `_config.downgradeOrder` on
     * every step, so the change takes effect on the next downgrade (already-lowered tiers stay).
     * @zh 运行时切换降档顺序。`_doStepDown` 每一步都读 `_config.downgradeOrder`，
     * 所以下一次降档立即生效（已经降过的档不会回滚）。
     */
    public setDowngradeOrder (order: ThermalDowngradeOrder): void {
        if (order !== 'scale-first' && order !== 'frameRate-first') {
            console.warn('[Thermal] setDowngradeOrder(' + String(order)
                + ') 非法（只接受 scale-first / frameRate-first），已忽略');
            return;
        }
        this._config.downgradeOrder = order;
    }

    /**
     * @en Enables/disables the scale lever at runtime. Disabling restores the original scale and
     * FSR state; the controller then uses the frame-rate lever only.
     * @zh 运行时启用/禁用 scale 杠杆。禁用时还原原缩放和 FSR，控制器只使用帧率杠杆。
     */
    public setScaleEnabled (enabled: boolean): void {
        this._scaleAction?.setEnabled?.(enabled);
        // E01：禁用会还原 scale，若还靠累加计数器，等级会卡在 Emergency（scale 已经回 1.0 了）。
        // 这里按两个杠杆"实际降了几档"重算并补发 onLevelChange。
        this._recomputeLevelFromActions();
    }

    /**
     * @en Derives the new counter value from the fallback delta, but prefers the real lever state
     * when both actions implement getStepsDown(). Keeps test doubles (no getStepsDown) working.
     * @zh 优先用两个杠杆的实际状态推导档位；动作没实现 getStepsDown() 时退回计数器语义，
     * 保证老的测试替身行为不变。
     */
    private _deriveLevel (fallbackDelta: number): number {
        const scaleSteps = this._scaleAction?.getStepsDown?.();
        const fpsSteps = this._frameRateAction.getStepsDown?.();
        if (typeof scaleSteps === 'number' && typeof fpsSteps === 'number') {
            return scaleSteps + fpsSteps;
        }
        return this._level + fallbackDelta;
    }

    /** 仅当两个动作都实现了 getStepsDown() 时重算并补发事件（否则保持原计数器行为） */
    private _recomputeLevelFromActions (): void {
        const scaleSteps = this._scaleAction?.getStepsDown?.();
        const fpsSteps = this._frameRateAction.getStepsDown?.();
        if (typeof scaleSteps !== 'number' || typeof fpsSteps !== 'number') {
            return;
        }
        const next = scaleSteps + fpsSteps;
        if (next === this._level) {
            return;
        }
        this._level = next;
        this._onLevelChanged();
    }

    public isScaleEnabled (): boolean {
        return this._scaleAction ? (this._scaleAction.isEnabled?.() ?? true) : false;
    }

    /**
     * @en Enables/disables the frame-rate lever at runtime. When disabled the controller only uses
     * the scale lever — useful for isolating "what does lowering resolution alone buy".
     * @zh 运行时启用/禁用帧率杠杆。禁用后控制器只使用分辨率杠杆——
     * 用来单独衡量"只降分辨率"能带来多少收益（A/B 实验要隔离单个杠杆）。
     */
    public setFrameRateEnabled (enabled: boolean): void {
        if (this._frameRateEnabled === enabled) {
            return;
        }
        this._frameRateEnabled = enabled;
        if (!enabled) {
            // 禁用时把帧率还原成原值，否则会留一个"已降但不会再升"的档位
            this._frameRateAction.restore();
        }
        this._recomputeLevelFromActions();
    }

    public isFrameRateEnabled (): boolean {
        return this._frameRateEnabled;
    }

    /**
     * @en Resets the sampler, the strategy and all transient recovery state (used when switching
     * scenes). When the loop is running it also restarts the warm-up window.
     * @zh 重置采样器、策略和所有瞬态恢复状态（换场景用）。若循环正在运行，同时重新开始预热窗口。
     */
    public reset (): void {
        this._sampler.reset();
        this._strategy.reset();
        this._resetTransientState();
        if (this._enabled && !this._paused) {
            this._warmupUntil = this._timeSource() + this._warmupMs;
            this._warmupDone = false;
            this._lastEvaluateAt = this._timeSource();
        }
    }

    /**
     * @en Registers the level-change callback.
     * @zh 注册档位变化回调。
     */
    public onLevelChange (cb: (level: ThermalLevel) => void): void {
        this._levelChangeCb = cb;
    }

    /**
     * @en Registers the action callback. Fires after every real down/up step (automatic or manual).
     * @zh 注册动作回调。每次真正发生降/升档（自动或手动）后触发。
     */
    public onAction (cb: (event: ThermalActionEvent) => void): void {
        this._actionCb = cb;
    }

    /**
     * @en Returns a snapshot of the current thermal state.
     * @zh 返回当前温控状态快照。
     */
    public getState (): ThermalState {
        return {
            level: this.getLevel(),
            frameRate: this._frameRateAction.getCurrent(),
            shadingScale: this._scaleAction ? this._scaleAction.getCurrent() : 1.0,
            scaleEnabled: this._scaleAction ? (this._scaleAction.isEnabled?.() ?? true) : false,
            enabled: this._enabled,
            paused: this._paused,
        };
    }

    /**
     * @en Returns the current frame rate tier.
     * @zh 返回当前帧率档位。
     */
    public getFrameRate (): number {
        return this._frameRateAction.getCurrent();
    }

    /**
     * @en Returns the current shading scale tier.
     * @zh 返回当前分辨率档位。
     */
    public getShadingScale (): number {
        return this._scaleAction ? this._scaleAction.getCurrent() : 1.0;
    }

    /**
     * @en Returns the current thermal level mapped from the downgrade step count.
     * @zh 返回由降档步数映射得到的当前温控等级。
     */
    public getLevel (): ThermalLevel {
        // N2：等级必须是"当前实际状态"的函数，不能只读累加计数器 —— 外部直接还原
        // （DRS 循环、screen.resolutionScale、用户手写 pipeline.shadingScale）不会经过
        // setScaleEnabled()/升降档这些重算点，光读计数器会又变成"level=Emergency 但 scale=1.0"。
        // _deriveLevel(0) 在测试替身（没有 getStepsDown）时就是 _level + 0，行为不变。
        const level = this._deriveLevel(0);
        if (level <= 0) {
            return ThermalLevel.Normal;
        }
        if (level === 1) {
            return ThermalLevel.Hot;
        }
        return ThermalLevel.Emergency;
    }

    /**
     * @en Manual single downgrade step (bypasses the recovery/effectiveness latches).
     * @zh 手动单步降档（绕过恢复/有效性锁）。
     */
    public stepDown (): boolean {
        return this._doStepDown(0, 0, this._timeSource(), true);
    }

    /**
     * @en Manual single upgrade step (bypasses the recovery backoff).
     * @zh 手动单步升档（绕过恢复退避）。
     */
    public stepUp (): boolean {
        return this._doStepUp(0, 0, this._timeSource(), true);
    }

    /**
     * @en Restores all actions, resets the level to full performance and clears the sampler window.
     * If the loop is still running, a new warm-up window starts.
     * @zh 还原所有动作、档位归零并清空采样窗口。若循环仍在运行，会重新开始预热窗口。
     */
    public restore (): void {
        this._frameRateAction.restore();
        this._scaleAction?.restore();
        this._level = 0;
        this._onLevelChanged();
        this._resetTransientState();
        this._sampler.reset();
        if (this._enabled && !this._paused) {
            this._warmupUntil = this._timeSource() + this._warmupMs;
            this._warmupDone = false;
            this._lastEvaluateAt = this._timeSource();
        }
    }

    /**
     * @en Pauses sampling (used during loading).
     * @zh 暂停采样（加载期用）。
     */
    public pause (): void {
        if (this._paused) {
            return;
        }
        this._paused = true;
        this._sampler.stop();
    }

    /**
     * @en Resumes sampling. The old window is discarded and a warm-up starts. The warm-up is at least
     * as long as the sampling window, otherwise the first decisions would run on a half-empty window.
     * @zh 恢复采样。丢弃暂停前的窗口并重新预热；预热长度至少对齐采样窗长度，
     * 否则恢复后的头几次决策会建立在"半空的窗口"上（噪声更大、容易误判）。
     */
    public resume (): void {
        if (!this._paused) {
            return;
        }
        this._paused = false;
        this._sampler.start();
        this._sampler.reset();
        const now = this._timeSource();
        // 窗口长度优先取采样器自己报的；注入的 mock 没实现该字段时退回配置值（默认 20s）。
        const windowSeconds = this._sampler.windowSeconds ?? this._config.windowSeconds ?? 20;
        this._warmupUntil = now + Math.max(ThermalController.RESUME_WARMUP_MS, windowSeconds * 1000);
        this._warmupDone = false;
        this._lastEvaluateAt = now;
    }

    private get _warmupMs (): number {
        return (this._config.warmupSeconds ?? 20) * 1000;
    }

    private get _recoveryProbeMs (): number {
        return (this._config.recoveryProbeSeconds ?? 15) * 1000;
    }

    private get _probeIntervalMs (): number {
        return (this._config.probeIntervalSeconds ?? 60) * 1000;
    }

    private _onAfterUpdate (): void {
        const now = this._timeSource();
        if (now - this._lastEvaluateAt < ThermalController.EVALUATE_INTERVAL_MS) {
            return;
        }
        this._lastEvaluateAt = now;
        this._evaluate();
    }

    private _evaluate (): void {
        if (this._paused) {
            return;
        }
        const now = this._timeSource();
        if (!this._warmupDone) {
            if (now < this._warmupUntil) {
                return;
            }
            this._warmupDone = true;
            // 预热结束：把预热期采到的样本清掉，再进入第一次判定。
            // 为什么必须清：平均帧时间按"帧"平均，启动阶段少量极端慢帧（shader 编译/资源上传，
            // 实测 10 帧 × 300ms）就能把 20s 窗口的均值抬过 triggerPercent。只延迟不清窗的话，
            // 预热结束的瞬间就会按这批启动卡顿降一次档；而一期自动升档默认关闭 → 这次误降档是永久的。
            // 清窗后本轮直接返回（窗口为空），下一次评估（约 1s 后）只用预热结束之后的帧。
            // warmupSeconds = 0（测试/无预热）不做清窗，保持"第一次评估即生效"的语义。
            if (this._warmupMs > 0) {
                this._sampler.reset();
                return;
            }
        }

        this._updateRecoveryProbe(now);

        const avgMs = this._sampler.getAverageFrameTimeMs();
        if (avgMs <= 0) {
            return; // The sliding window is empty.
        }

        // 窗口里样本太少时不许判定。
        // 触发场景：预热结束 reset 之后、resume 之后、手动 stepUp 之后，窗口是"半空"的；
        // 微信开发者工具/后台节流时每个 tick 间隔接近 1s，但 993ms < MAX_FRAME_DELTA_MS(1000) 不会被丢弃，
        // 于是"一个 993ms 的假帧"直接变成 avg=993ms（diff +5858%）→ 误降一档。
        // 真机上同样会发生（GC 长停顿、切前后台的边缘情况），所以按样本数兜底，而不是只靠时间阈值。
        if (this._sampler.getSampleCount) {
            if (this._sampler.getSampleCount() < ThermalController.MIN_DECISION_SAMPLES) {
                return;
            }
        }

        if (this._config.scaleEffectCheck) {
            this._updateScaleEffectiveness(now, avgMs);
        }

        // Never cache the target: after a downgrade the current frame rate changes.
        const targetMs = 1000 / this._readCurrentFps();
        const action = this._strategy.update(avgMs, targetMs);
        if (action === 'DOWN') {
            this._doStepDown(avgMs, targetMs, now, false);
            // 降档后：若启用自动升档，启动（或重置）试探计时，到 probeIntervalSeconds 后尝试升档。
            if (this._config.enableAutoUpgrade) {
                this._nextAutoProbeAt = now + this._probeIntervalMs;
            }
        } else if (action === 'UP') {
            this._doStepUp(avgMs, targetMs, now, false);
        } else {
            // 负载平稳：若启用自动升档，检查是否到了自动试探升档的时间。
            if (this._config.enableAutoUpgrade) {
                this._maybeAutoProbe(now);
            }
        }
    }

    /**
     * 自动试探升档：软温控没有"负载变轻"的被动信号，只能定期主动升一档、观察能否稳住。
     * 到点且不在观察期内、不在退避期内，就做一次 scale-first 的自动试探。
     */
    private _maybeAutoProbe (now: number): void {
        if (this._nextAutoProbeAt <= 0 || now < this._nextAutoProbeAt) {
            return;
        }
        if (this._upProbeLever) {
            // 正在观察上一次升档的成败，本轮不叠加试探。
            return;
        }
        this._nextAutoProbeAt = 0;
        const moved = this._doStepUp(0, 0, now, false, true);
        if (moved) {
            this._probeIsAuto = true;
        }
        // 若没动成（两个杠杆都到底/被退避），不设下次试探；等下一次 DOWN 或手动操作再触发。
        // 已到底（全性能）时确实无需再试；被退避时，退避到期后由下一次 DOWN→调度 重新排队。
    }

    private _updateRecoveryProbe (now: number): void {
        if (!this._upProbeLever) {
            return;
        }
        if (now - this._upProbeAt <= this._recoveryProbeMs) {
            return;
        }
        // The upgraded lever held for a full probe window: clear its failure history.
        this._resetRecoveryFailCount(this._upProbeLever);
        this._upProbeLever = null;
        if (this._probeIsAuto) {
            // 自动试探成功：立即继续下一档（不等 probeIntervalSeconds），直到升满或某档失败。
            this._probeIsAuto = false;
            this._nextAutoProbeAt = now;
        }
    }

    private _updateScaleEffectiveness (now: number, avgMs: number): void {
        const probe = this._scaleEffectProbe;
        if (!probe || now < probe.dueAt) {
            return;
        }
        this._scaleEffectProbe = null;
        if (probe.preAvgMs <= 0) {
            return;
        }
        const improvementPercent = ((probe.preAvgMs - avgMs) / probe.preAvgMs) * 100;
        const minPercent = this._config.scaleEffectMinImprovementPercent ?? 5;
        if (improvementPercent < minPercent) {
            this._scaleIneffectiveUntil = now + (this._config.scaleIneffectiveSeconds ?? 60) * 1000;
        }
    }

    private _doStepDown (preAvgMs: number, targetMs: number, now: number, force: boolean): boolean {
        // 观察期内又降档 = 上次升档失败：记录失败、退避翻倍。
        const probeLever = this._upProbeLever;
        const inProbeWindow = !force && probeLever && now - this._upProbeAt <= this._recoveryProbeMs;
        if (inProbeWindow) {
            this._recordRecoveryFailure(probeLever, now);
        }
        this._upProbeLever = null;
        this._probeIsAuto = false;
        this._scaleEffectProbe = null;

        const scaleAction = this._scaleAction;
        const scaleAllowed = !!scaleAction && (force || now >= this._scaleIneffectiveUntil);
        let lever: ThermalLever | null = null;
        let from = 0;
        let to = 0;
        let moved = false;

        // 失败定向撤销：观察期内降档，优先撤销"刚升的那个杠杆"，而不是走通用 scale-first 顺序。
        // 否则"30→60 探测失败"会被通用 scale-first 降档改写成"先降分辨率级联"，语义错误。
        if (inProbeWindow && probeLever === 'frameRate') {
            from = this._frameRateAction.getCurrent();
            moved = this._frameRateAction.stepDown();
            if (moved) {
                lever = 'frameRate';
                to = this._frameRateAction.getCurrent();
            }
        } else if (inProbeWindow && probeLever === 'scale') {
            if (scaleAction) {
                from = scaleAction.getCurrent();
                moved = scaleAction.stepDown();
                if (moved) {
                    lever = 'scale';
                    to = scaleAction.getCurrent();
                }
            }
        }

        // 通用降档顺序：由 config.downgradeOrder 决定（方案 §2.3 开放给开发商），默认 scale-first。
        // 每次只动一个杠杆：第一个降得动的杠杆占这一步，两个都到底才返回 false。
        if (!moved) {
            const order: Array<'scale' | 'frameRate'> = this._config.downgradeOrder === 'frameRate-first'
                ? ['frameRate', 'scale']
                : ['scale', 'frameRate'];
            for (let i = 0; i < order.length; i++) {
                const lv = order[i];
                if (lv === 'scale') {
                    if (!scaleAction || !scaleAllowed) continue;
                    from = scaleAction.getCurrent();
                    moved = scaleAction.stepDown();
                    if (moved) {
                        lever = 'scale';
                        to = scaleAction.getCurrent();
                    }
                } else {
                    if (!this._frameRateEnabled) continue;
                    from = this._frameRateAction.getCurrent();
                    moved = this._frameRateAction.stepDown();
                    if (moved) {
                        lever = 'frameRate';
                        to = this._frameRateAction.getCurrent();
                    }
                }
                if (moved) break;
            }
        }
        // At the frame-rate floor, resolution is the only remaining lever. Retry it even if it was
        // recently judged ineffective for frame time: it may still reduce GPU power and heat.
        if (!moved && scaleAction && !scaleAllowed) {
            from = scaleAction.getCurrent();
            moved = scaleAction.stepDown();
            if (moved) {
                lever = 'scale';
                to = scaleAction.getCurrent();
            }
        }
        if (!moved || !lever) {
            return false;
        }

        this._sampler.reset();
        this._level = this._deriveLevel(+1);
        // 跨过 FSR 开关阈值的那一步同时改了分辨率和升采样状态，帧时间差不能单独归因于分辨率：
        // 不 arm 探针（否则 0.85 档可能被误判为"降分辨率无效"，直接封掉 scale 杠杆 60s）。
        const fsrFlipStep = lever === 'scale'
            && !!scaleAction
            && typeof (scaleAction as any).isFsrStateChanging === 'function'
            && (scaleAction as any).isFsrStateChanging(from, to);
        if (lever === 'scale' && preAvgMs > 0 && this._config.scaleEffectCheck && !fsrFlipStep) {
            this._scaleEffectProbe = {
                preAvgMs,
                dueAt: now + (this._config.scaleEffectProbeSeconds ?? 5) * 1000,
            };
        }
        this._onLevelChanged();
        this._emitAction('DOWN', lever, from, to, force ? 'manual' : 'trigger', preAvgMs, targetMs);
        return true;
    }

    /**
     * 升档顺序分两种（见 upgrade-design.md）：
     * - **手动 stepUp()**（force=true，autoScaleFirst=false）：frameRate-first —— 先回帧率（更硬的体验约束），
     *   用户手动升档最想要 FPS 先回来；与降档的 scale-first 正好相反（对称反转）。
     * - **自动试探**（force=false，autoScaleFirst=true）：scale-first —— 分辨率多档、可逐档渐进（风险低），
     *   帧率 30→60 大跳放最后。对自动探测更稳。
     * 两种顺序都保证"一次只动一个杠杆"。
     * @param autoScaleFirst 自动试探时传 true（scale-first）；手动/信号驱动升档传 false（frameRate-first）。
     */
    private _doStepUp (preAvgMs: number, targetMs: number, now: number, force: boolean, autoScaleFirst = false): boolean {
        let lever: ThermalLever | null = null;
        let from = 0;
        let to = 0;
        let moved = false;
        const scaleAction = this._scaleAction;

        if (autoScaleFirst) {
            // 自动试探：先升分辨率，满后再升帧率。
            if (scaleAction && (force || !this._isUpBlocked('scale', now))) {
                from = scaleAction.getCurrent();
                moved = scaleAction.stepUp();
                if (moved) {
                    lever = 'scale';
                    to = scaleAction.getCurrent();
                }
            }
            if (!moved && (force || !this._isUpBlocked('frameRate', now))) {
                from = this._frameRateAction.getCurrent();
                moved = this._frameRateAction.stepUp();
                if (moved) {
                    lever = 'frameRate';
                    to = this._frameRateAction.getCurrent();
                }
            }
        } else {
            // 手动/信号驱动：先回帧率，再回分辨率（现网行为）。
            if (force || !this._isUpBlocked('frameRate', now)) {
                from = this._frameRateAction.getCurrent();
                moved = this._frameRateAction.stepUp();
                if (moved) {
                    lever = 'frameRate';
                    to = this._frameRateAction.getCurrent();
                }
            }
            if (!moved && scaleAction && (force || !this._isUpBlocked('scale', now))) {
                from = scaleAction.getCurrent();
                moved = scaleAction.stepUp();
                if (moved) {
                    lever = 'scale';
                    to = scaleAction.getCurrent();
                }
            }
        }
        if (!moved || !lever) {
            return false;
        }

        this._sampler.reset();
        this._level = this._deriveLevel(-1);
        this._scaleEffectProbe = null;
        if (lever === 'scale') {
            // Restoring the scale invalidates an earlier "scale is ineffective" verdict.
            this._scaleIneffectiveUntil = 0;
        }
        this._upProbeLever = lever;
        this._upProbeAt = now;
        this._onLevelChanged();
        this._emitAction('UP', lever, from, to, force ? 'manual' : 'recover', preAvgMs, targetMs);
        return true;
    }

    private _emitAction (
        direction: ThermalActionDirection,
        lever: ThermalActionLever,
        from: number,
        to: number,
        reason: 'trigger' | 'recover' | 'manual',
        avgMs: number,
        targetMs: number,
    ): void {
        const event: ThermalActionEvent = {
            direction,
            lever,
            from,
            to,
            level: this.getLevel(),
            timestamp: this._timeSource(),
            avgMs: avgMs > 0 ? avgMs : undefined,
            targetMs: targetMs > 0 ? targetMs : undefined,
            reason,
        };
        if (this._config.logActions !== false) {
            const fmt = (v: number): string => (lever === 'scale' ? v.toFixed(2) : String(v));
            let detail = '';
            if (avgMs > 0 && targetMs > 0) {
                const diff = ((avgMs - targetMs) / targetMs) * 100;
                detail = ` | avg=${avgMs.toFixed(2)}ms target=${targetMs.toFixed(2)}ms diff=${diff >= 0 ? '+' : ''}${diff.toFixed(1)}%`;
            }
            // eslint-disable-next-line no-console
            console.log(`[Thermal] ${direction} ${lever} ${fmt(from)} -> ${fmt(to)}${detail} level=${event.level}`);
        }
        if (this._actionCb) {
            this._actionCb(event);
        }
    }

    private _recordRecoveryFailure (lever: ThermalLever, now: number): void {
        if (lever === 'frameRate') {
            this._frameRateFailCount += 1;
            this._frameRateUpBlockedUntil = now + this._recoveryBackoffMs(this._frameRateFailCount);
        } else {
            this._scaleFailCount += 1;
            this._scaleUpBlockedUntil = now + this._recoveryBackoffMs(this._scaleFailCount);
        }
    }

    private _recoveryBackoffMs (failCount: number): number {
        const baseMs = (this._config.recoveryBackoffSeconds ?? 60) * 1000;
        const maxMs = (this._config.recoveryBackoffMaxSeconds ?? 600) * 1000;
        return Math.min(baseMs * (2 ** (failCount - 1)), maxMs);
    }

    private _resetRecoveryFailCount (lever: ThermalLever): void {
        if (lever === 'frameRate') {
            this._frameRateFailCount = 0;
        } else {
            this._scaleFailCount = 0;
        }
    }

    private _isUpBlocked (lever: ThermalLever, now: number): boolean {
        return now < (lever === 'frameRate' ? this._frameRateUpBlockedUntil : this._scaleUpBlockedUntil);
    }

    private _resetTransientState (): void {
        this._upProbeLever = null;
        this._upProbeAt = 0;
        this._probeIsAuto = false;
        this._nextAutoProbeAt = 0;
        this._frameRateFailCount = 0;
        this._scaleFailCount = 0;
        this._frameRateUpBlockedUntil = 0;
        this._scaleUpBlockedUntil = 0;
        this._scaleEffectProbe = null;
        this._scaleIneffectiveUntil = 0;
    }

    private _onLevelChanged (): void {
        const level = this.getLevel();
        if (level !== this._lastReportedLevel) {
            this._lastReportedLevel = level;
            if (this._levelChangeCb) {
                this._levelChangeCb(level);
            }
        }
    }
}
