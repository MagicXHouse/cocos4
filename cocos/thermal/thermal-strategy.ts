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

import type { FrameTimeSource, IThermalStrategy, ThermalConfig, ThermalStrategyAction } from './types';

function defaultTimeSource (): number {
    return performance.now();
}

/**
 * @en Default implementation of IThermalStrategy: frame time budget + hysteresis + cool-down.
 *
 * Decision rule for each update(avgMs, targetMs):
 * - diff = (avgMs - targetMs) / targetMs * 100%.
 * - DOWN: diff >= triggerPercent (immediate).
 * - UP: diff < recoverPercent sustained continuously for recoverWindowSeconds (more conservative than DOWN).
 * - NONE: otherwise (the hysteresis band between recoverPercent and triggerPercent), or during cool-down.
 *
 * NOTE on frame-rate capping: when the frame rate is capped (engine pacer or system vsync), the
 * measured frame time is pulled up to equal the budget, hiding the real device load. This can cause
 * oscillation (downgrade -> immediately meets the recover condition -> upgrade -> ...). Mitigations:
 * 1. The target frame time is never cached - every update() receives targetMs = 1000 / current frame
 *    rate, so a downgrade immediately re-baselines the budget against the new frame rate.
 * 2. "Having headroom" is proxied by "stably full speed for recoverWindowSeconds": recovery requires
 *    diff < recoverPercent to hold continuously for recoverWindowSeconds, and any evaluation period
 *    whose averaged frame time falls back into the band resets the timer. This delays upgrades until
 *    the device has provably been stable, damping the downgrade/upgrade oscillation.
 * 3. The default recoverPercent is -10: the average must be 10% BELOW the budget. Under a stable
 *    frame cap the average sits at the budget, so phase 1 is effectively downgrade-only; recovery is
 *    left to the manual stepUp() API (or a future probe/temperature signal).
 * @zh 温控策略默认实现：帧时间预算 + 迟滞 + 冷却。
 * 每次 update(avgMs, targetMs) 的决策：diff = (avgMs - targetMs) / targetMs * 100%。
 * - DOWN：diff >= triggerPercent（立即降档）。
 * - UP：diff < recoverPercent 且持续满足 recoverWindowSeconds 秒（恢复比降档更保守）。
 * - NONE：其余情况（recoverPercent 与 triggerPercent 之间的迟滞带），或冷却期内。
 * 帧率被限制（pacer / vsync）时实测帧时间会被拉到等于预算，掩盖真实负担，导致"降档后立刻满足
 * 恢复条件、来回抖"。本实现的取舍：1) 目标帧时间从不缓存，每次按当前帧率重新传入；2) 用
 * "稳定满帧 recoverWindowSeconds 秒"作为"确有富余"的代理——恢复需持续满足，任一评估周期的平均帧时间掉回迟滞带即清零重计。
 */
export class ThermalStrategy implements IThermalStrategy {
    private _triggerPercent: number;
    // ⚠️ 一期默认关闭：recoverPercent 驱动的 UP 分支在限帧下不可靠（见 update() 内注释），
    // 且会绕过试探排期/退避、走手动升档顺序。二期接真实信号后由 signalDrivenUpgrade 打开。
    private _recoverPercent: number;
    private _signalDrivenUpgrade: boolean;
    private _recoverWindowMs: number;
    private _cooldownMs: number;
    private _timeSource: FrameTimeSource;

    // -1 means "not active": not in cool-down / not in a recovery streak.
    private _cooldownUntil = -1;
    private _recoverSince = -1;

    /**
     * @param config - Optional tuning; unset fields fall back to the defaults in ThermalConfig.
     * @param timeSource - Injectable timestamp source (used by tests). Defaults to performance.now.
     */
    constructor (config: ThermalConfig = {}, timeSource: FrameTimeSource = defaultTimeSource) {
        this._triggerPercent = config.triggerPercent ?? 10;
        this._recoverPercent = config.recoverPercent ?? -10;
        this._signalDrivenUpgrade = config.signalDrivenUpgrade === true;
        this._recoverWindowMs = (config.recoverWindowSeconds ?? 5) * 1000;
        this._cooldownMs = (config.cooldownSeconds ?? 10) * 1000;
        this._timeSource = timeSource;
    }

    /**
     * @en Decides one step based on the averaged frame time and the current frame time budget.
     * @param avgMs - Averaged actual frame time, in milliseconds.
     * @param targetMs - Current frame time budget, in milliseconds (1000 / current frame rate). Never cached.
     * @returns 'DOWN', 'UP' or 'NONE'.
     * @zh 基于平均帧时间与当前帧时间预算做一次决策。
     * @param avgMs - 平均实际帧时间（毫秒）。
     * @param targetMs - 当前帧时间预算（毫秒，1000 / 当前帧率）。从不缓存。
     * @returns 'DOWN'、'UP' 或 'NONE'。
     */
    public update (avgMs: number, targetMs: number): ThermalStrategyAction {
        if (targetMs <= 0) {
            return 'NONE';
        }
        const now = this._timeSource();
        const diffPercent = ((avgMs - targetMs) / targetMs) * 100;

        if (now < this._cooldownUntil) {
            return 'NONE';
        }

        if (diffPercent >= this._triggerPercent) {
            this._cooldownUntil = now + this._cooldownMs;
            this._recoverSince = -1;
            return 'DOWN';
        }

        // ⚠️ 一期默认关闭（signalDrivenUpgrade=false）：限帧下该信号失真，且这条 UP 会绕过
        // 试探的排期/退避、并走手动升档的 frameRate-first 顺序（与"自动试探必须 scale-first"冲突）。
        // 二期接温度/headroom 后由配置打开，并纳入同一套试探状态机。
        if (this._signalDrivenUpgrade && diffPercent < this._recoverPercent) {
            if (this._recoverSince < 0) {
                this._recoverSince = now;
            }
            if (now - this._recoverSince >= this._recoverWindowMs) {
                this._cooldownUntil = now + this._cooldownMs;
                this._recoverSince = -1;
                return 'UP';
            }
            return 'NONE';
        }

        // Hysteresis band: no action, and reset any in-progress recovery streak.
        this._recoverSince = -1;
        return 'NONE';
    }

    /**
     * @en Sets the down-grade trigger threshold (percent). Takes effect immediately and clears
     * the recovery streak (use together with reset when switching scenes).
     * @zh 设置降档触发阈值（百分比）。立即生效并清空恢复计时（换场景时配合 reset 使用）。
     */
    public setThreshold (percent: number): void {
        this._triggerPercent = percent;
        this._recoverSince = -1;
    }

    /**
     * @en Sets the up-grade recover threshold (percent). Takes effect immediately and clears the recovery streak.
     * @zh 设置升档恢复阈值（百分比）。立即生效并清空恢复计时。
     */
    public setRecoverThreshold (percent: number): void {
        this._recoverPercent = percent;
        this._recoverSince = -1;
    }

    /**
     * @en Sets the recovery confirmation window length (seconds). Takes effect immediately and clears the recovery streak.
     * @zh 设置恢复确认窗口时长（秒）。立即生效并清空恢复计时。
     */
    public setRecoverWindowSeconds (seconds: number): void {
        this._recoverWindowMs = seconds * 1000;
        this._recoverSince = -1;
    }

    /**
     * @en Sets the cool-down duration (seconds) after each DOWN/UP decision.
     * @zh 设置每次 DOWN/UP 决策后的冷却时长（秒）。
     */
    public setCooldownSeconds (seconds: number): void {
        this._cooldownMs = seconds * 1000;
    }

    /**
     * @en Clears all transient state (cool-down and recovery streak).
     * @zh 清空所有瞬态状态（冷却与恢复计时）。
     */
    public reset (): void {
        this._cooldownUntil = -1;
        this._recoverSince = -1;
    }
}
