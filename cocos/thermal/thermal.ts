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

import { FrameTimeSampler } from './frame-time-sampler';
import { ThermalStrategy } from './thermal-strategy';
import { FrameRateAction } from './actions/frame-rate-action';
import { ScaleAction } from './actions/scale-action';
import { ThermalController } from './thermal-controller';
import { ThermalFsr } from './fsr';
import { game } from '../game';
import { ThermalLevel } from './types';
import type { Material } from '../asset/assets/material';
import type { ThermalActionEvent, ThermalConfig, ThermalDowngradeOrder, ThermalState } from './types';

/**
 * @en User-facing facade of the thermal control module. It lazily builds a ThermalController
 * from the given config and delegates every call to it. A singleton instance is exported as thermal.
 * @zh 温控模块的用户门面。它按配置懒构建一个 ThermalController 并把所有调用委托过去。
 * 单例实例以 thermal 导出。
 *
 * 杠杆顺序（两个方向**刻意相反**，每次只动一个杠杆）：
 *   降档：先 shadingScale（分辨率），scale 到地板后才降 frameRate；
 *   升档：先 frameRate，帧率回到顶后才升 shadingScale。
 * 也就是说"降档省 GPU 优先降分辨率，升档恢复体验优先回帧率"。
 */
export class Thermal {
    private _controller: ThermalController | null = null;
    private _config: ThermalConfig = {};
    private _levelChangeCb: ((level: ThermalLevel) => void) | null = null;
    private _actionCb: ((event: ThermalActionEvent) => void) | null = null;
    private _fsr: ThermalFsr | null = null;
    /** 二次 enable(config) 时只告警一次，避免每帧/每次调用刷屏 */
    private _warnedConfigIgnored = false;

    /**
     * @en Enables the thermal control. On first call it builds the sampler/strategy/actions from
     * the config and starts the loop. The config only takes effect on the first enable call;
     * to change parameters at runtime, use the setters such as setThreshold.
     * Passing a config to a later enable() cannot rebuild the controller, so it is ignored (and warned once).
     * @zh 启用温控。首次调用时按配置构建采样器/策略/动作并启动循环。config 只在首次 enable 生效；
     * 运行时改参数请用 setThreshold 等 setter。
     * 后续 enable(config) 无法重建控制器，config 会被忽略（只告警一次）。
     */
    public enable (config?: ThermalConfig): void {
        this._config = { ...this._config, ...config };
        if (!this._controller) {
            this._controller = this._createController();
        } else if (config && !this._warnedConfigIgnored) {
            // 控制器是按旧 config 建好的，合并进来的新字段不会生效 —— 明确告警，别让人误以为改到了。
            this._warnedConfigIgnored = true;
            console.warn('[Thermal] enable(config) only takes effect on the first call; the controller already exists, '
                + 'so this config was ignored. Use setThreshold / setScaleEnabled / setFsrEnabled for runtime changes.');
        }
        // Re-attach the user callback on every enable: the controller clears it in disable(),
        // and onLevelChange may have been called before the controller existed.
        if (this._levelChangeCb) {
            this._controller.onLevelChange(this._levelChangeCb);
        }
        if (this._actionCb) {
            this._controller.onAction(this._actionCb);
        }
        this._controller.enable();
    }

    /**
     * @en Disables the thermal control and restores everything.
     * @zh 关闭温控并还原一切。
     */
    public disable (): void {
        this._controller?.disable();
    }

    public setThreshold (percent: number): void {
        this._controller?.setThreshold(percent);
    }

    /**
     * @en Switches the downgrade order at runtime (`scale-first` / `frameRate-first`).
     * Only affects **subsequent** downgrades; a tier already lowered is not rolled back.
     * Invalid values are ignored with a warning (same contract as the construction-time check).
     * @zh 运行时切换降档顺序（`scale-first` / `frameRate-first`）。
     * 只影响**之后**的降档，已经降过的档不会回滚。非法值告警后忽略（与构造期校验同一契约）。
     */
    public setDowngradeOrder (order: ThermalDowngradeOrder): void {
        if (order !== 'scale-first' && order !== 'frameRate-first') {
            console.warn('[Thermal] setDowngradeOrder(' + String(order)
                + ') 非法（只接受 scale-first / frameRate-first），已忽略');
            return;
        }
        this._config.downgradeOrder = order;
        this._controller?.setDowngradeOrder?.(order);
        console.log('[Thermal] downgradeOrder = ' + order + '（只影响之后的降档）');
    }

    /**
     * @en Enables/disables the frame-rate lever at runtime. Disabling restores the original frame
     * rate and leaves only the scale lever active — used to isolate "resolution only" experiments.
     * @zh 运行时启用/禁用帧率杠杆。禁用时还原原帧率，只保留分辨率杠杆——
     * 用于隔离"只降分辨率"的 A/B 实验。
     */
    public setFrameRateEnabled (enabled: boolean): void {
        // 写进配置：控制器还没建时（enable 之前）也要生效，否则面板上的开关会被静默丢弃
        this._config.enableFrameRate = enabled;
        this._controller?.setFrameRateEnabled?.(enabled);
    }

    public isFrameRateEnabled (): boolean {
        return this._controller?.isFrameRateEnabled?.() ?? true;
    }

    /**
     * @en Replaces the resolution tier ladder at runtime (developer dashboard / experiments).
     * Written into config so it also survives an enable() that happens later.
     * @zh 运行时替换分辨率档位梯度（开发者面板/实验用）。同时写入配置，enable() 之前调用也不丢。
     */
    public setScaleTiers (tiers: number[]): void {
        this._config.scaleTiers = (tiers || []).slice();
        this._controller?.setScaleTiers?.(this._config.scaleTiers);
    }

    /** 运行时替换帧率档位梯度（开发者面板/实验用） */
    public setFrameRateTiers (tiers: number[]): void {
        this._config.frameRateTiers = (tiers || []).slice();
        this._controller?.setFrameRateTiers?.(this._config.frameRateTiers);
    }

    /**
     * @en Enables/disables the scale (shadingScale) lever at runtime. Disabling restores the
     * original scale and FSR state. The scale lever only affects 3D camera render targets; for
     * 2D/UI-heavy games keep it disabled and use the frame-rate lever only.
     * @zh 运行时启用/禁用 scale（shadingScale）杠杆。禁用时还原原缩放和 FSR 状态。
     * scale 杠杆只影响 3D 相机的渲染目标；2D/UI 重的游戏应保持关闭，只用帧率杠杆。
     */
    public setScaleEnabled (enabled: boolean): void {
        this._config.enableScale = enabled;
        this._controller?.setScaleEnabled?.(enabled);
    }

    /**
     * @en Enables/disables FSR independently of the scale lever. Disabling restores the camera's
     * original FSR settings. FSR only upscales the 3D render target; it cannot compensate UI.
     * @zh 独立于 scale 杠杆启用/禁用 FSR。禁用时还原相机原来的 FSR 设置。
     * FSR 只升采样 3D 渲染目标，不能补偿 UI。
     */
    public setFsrEnabled (enabled: boolean): void {
        this._config.enableFsr = enabled;
        this._fsr?.setEnabled?.(enabled);
        if (enabled) {
            // 控制器还没建时 getShadingScale() 返回 0；用 1.0 兜底，避免把 FSR 开在"scale=0"上。
            const scale = this.getShadingScale();
            this._fsr?.apply(scale > 0 ? scale : 1);
        }
    }

    public isFsrEnabled (): boolean {
        return this._fsr?.isEnabled?.() ?? false;
    }

    /**
     * @en Sets the largest shading scale at which FSR is enabled (`scale <= minScale`). Default 0.85.
     * Lower it to 0.7 when the FSR cost outweighs the saving of the 0.85 tier.
     * @zh 设置启用 FSR 的最大 shadingScale（`scale <= minScale` 才开），默认 0.85。
     * 若 0.85 档 FSR 的固定开销盖过了降采样省下的时间，可下调到 0.7。
     */
    public setFsrMinScale (minScale: number): void {
        this._config.fsrMinScale = minScale;
        this._fsr?.setMinScale?.(minScale);
    }

    /**
     * @en Sets the FSR material used by the resolution action. Call it after loading
     * builtin-fsr.mtl if the material is loaded asynchronously. A null value clears it.
     * @zh 设置分辨率动作用的 FSR 材质。如果 builtin-fsr.mtl 是异步加载的，加载完成后调用；
     * 传 null 表示清空。
     */
    public setFsrMaterial (material: Material | null): void {
        this._config.fsrMaterial = material ?? undefined;
        this._fsr?.setMaterial(material);
    }

    public reset (): void {
        this._controller?.reset();
    }

    public onLevelChange (cb: (level: ThermalLevel) => void): void {
        // Stash the callback so a registration before enable() is not lost. enable() re-attaches it.
        this._levelChangeCb = cb;
        this._controller?.onLevelChange(cb);
    }

    /**
     * @en Registers the action callback (direction, lever, from/to, level). Fires for automatic and
     * manual steps. A registration before enable() is kept and attached in enable().
     * @zh 注册动作回调（方向、杠杆、前后值、等级）。自动和手动升降档都会触发；enable() 之前注册
     * 也不会丢。
     */
    public onAction (cb: (event: ThermalActionEvent) => void): void {
        this._actionCb = cb;
        this._controller?.onAction(cb);
    }

    /**
     * @en Returns the current thermal state snapshot. Before enable() it returns a disabled snapshot
     * with zero tiers.
     * @zh 返回当前温控状态快照。enable() 之前返回 enabled=false、挡位为 0 的占位快照。
     */
    public getState (): ThermalState {
        return this._controller?.getState() ?? {
            level: ThermalLevel.Normal,
            frameRate: 0,
            shadingScale: 0,
            scaleEnabled: false,
            enabled: false,
            paused: false,
        };
    }

    /**
     * @en Returns the current frame rate tier (0 before enable()).
     * @zh 返回当前帧率档位（enable() 之前为 0）。
     */
    public getFrameRate (): number {
        return this._controller?.getFrameRate() ?? 0;
    }

    /**
     * @en Returns the current shading scale tier (0 before enable()).
     * @zh 返回当前分辨率档位（enable() 之前为 0）。
     */
    public getShadingScale (): number {
        return this._controller?.getShadingScale() ?? 0;
    }

    public getLevel (): ThermalLevel {
        return this._controller?.getLevel() ?? ThermalLevel.Normal;
    }

    public stepDown (): boolean {
        return this._controller?.stepDown() ?? false;
    }

    public stepUp (): boolean {
        return this._controller?.stepUp() ?? false;
    }

    public restore (): void {
        this._controller?.restore();
    }

    public pause (): void {
        this._controller?.pause();
    }

    public resume (): void {
        this._controller?.resume();
    }

    /**
     * @en Sanitizes `triggerPercent` (legal range 1~100). `<= 0` would downgrade on every
     * evaluation and `> 100` would never downgrade, so both fall back to the default 10 with a warning.
     * @zh 校验 `triggerPercent`（合法范围 1~100）。`<= 0` 会每次评估都降档，`> 100` 等于永不降档，
     * 两种情况都告警并回落默认值 10。
     */
    private static _sanitizeTriggerPercent (raw: number | undefined): number {
        if (raw === undefined) {
            return 10;
        }
        if (!Number.isFinite(raw) || raw < 1 || raw > 100) {
            console.warn('[Thermal] triggerPercent=' + String(raw) + ' 非法（合法范围 1~100），已回落 10');
            return 10;
        }
        return raw;
    }

    /**
     * @en Sanitizes `minScale`. It must be in (0, 1]: `<= 0` / NaN would produce a `scale = 0` tier
     * (a zero-pixel render target), so they fall back to 0.3; a value `> 1` means "the floor is above
     * the original scale", i.e. the scale lever should not move, so it is clamped to 1 with a hint
     * to use `enableScale=false` instead.
     * @zh 校验 `minScale`，必须落在 (0, 1]：`<= 0` 或 NaN 会产出 `scale = 0` 档（渲染目标 0 像素），
     * 回落 0.3；大于 1 表示"地板高于原值"= 不该降分辨率，收敛到 1 并提示改用 `enableScale=false`。
     */
    private static _sanitizeMinScale (raw: number | undefined): number {
        if (raw === undefined) {
            return 0.7;
        }
        if (!Number.isFinite(raw) || raw <= 0) {
            console.warn('[Thermal] minScale=' + String(raw) + ' 非法（必须 > 0，预设 0.85 / 0.7），已回落 0.7');
            return 0.7;
        }
        if (raw > 1) {
            console.warn('[Thermal] minScale=' + String(raw) + ' > 1：已收敛到 1（等于不降分辨率）；'
                + '只想降帧率请用 enableScale=false');
            return 1;
        }
        return raw;
    }

    private _createController (): ThermalController {
        const config = this._config;
        const sampler = new FrameTimeSampler(config.windowSeconds ?? 20);
        // E08：数值型配置先做范围校验，避免拼错后静默产生"每次评估都降档"的行为。
        const triggerPercent = Thermal._sanitizeTriggerPercent(config.triggerPercent);
        const strategy = new ThermalStrategy({ ...config, triggerPercent });
        // 微信 60Hz 下 45 非 60 的整数因子、且离设备自然帧率太近易振荡，帧率档用 [60, 30]；
        // 分辨率地板 0.7（三档 1.00 / 0.85 / 0.70，降档更温和：每档只掉 15 个百分点）。
        //
        // E05：minFrameRate 的合法性按"当前天花板"判，而不是只认 30/20/15 三个字面量：
        //   - min >= 天花板：**钉住帧率**，buildLevels(original, tiers, min>=original) 退化成单元素，
        //     帧率杠杆自然是 no-op。这是"只让温控降分辨率"的合法写法，不能回落、也不该告警。
        //   - 天花板 % min === 0 且 min >= 15（30/20/15…）：整数帧，合法。
        //   - 其余（45/40/25 出不了整数帧；12/10/5 这类虽然能整除但过低）：warn + 回落 30。
        const requestedMinFps = config.minFrameRate ?? 30;
        const currentCeiling = Math.max(1, Math.floor(Number(game.frameRate) || 60));
        let minFps = requestedMinFps;
        const pinsFrameRate = requestedMinFps >= currentCeiling;
        // 下限 15：方案预设最低就是 15。只判"能整除"会放行 12/10/6/5，档位表里出现 5fps 地板。
        const dividesCeiling = requestedMinFps >= 15 && currentCeiling % requestedMinFps === 0;
        if (!pinsFrameRate && !dividesCeiling) {
            console.warn('[Thermal] minFrameRate=' + requestedMinFps
                + ' 不是当前天花板 ' + currentCeiling + 'Hz 的合法档（预设 30/20/15；'
                + '45/40/25 不是整数因子会 judder，<15 过低），已回落 30。'
                + '若想钉住帧率只降分辨率，请把 minFrameRate 设成 >= ' + currentCeiling);
            minFps = 30;
        }
        const frameRateAction = new FrameRateAction(minFps, [60, 30]);
        // Always create both objects so setScaleEnabled()/setFsrEnabled() work at runtime;
        // config only sets their initial enabled state.
        const fsr = new ThermalFsr(config.fsrMaterial ?? null, config.fsrSharpness ?? 0.8, config.fsrMinScale ?? 0.85);
        fsr.setEnabled?.(config.enableFsr !== false);
        this._fsr = fsr;
        const scaleAction = new ScaleAction(Thermal._sanitizeMinScale(config.minScale), undefined, undefined, undefined, fsr);
        scaleAction.setEnabled?.(config.enableScale !== false);
        const controller = new ThermalController(config, sampler, strategy, frameRateAction, scaleAction);
        // 与 enableScale 对称：构建期/运行时关掉的帧率杠杆，在控制器创建时补上
        if (config.enableFrameRate === false) {
            controller.setFrameRateEnabled?.(false);
        }
        // 自定义档位梯度：enable() 之前设置过也要在控制器创建时应用
        if (Array.isArray(config.scaleTiers) && config.scaleTiers.length > 0) {
            controller.setScaleTiers?.(config.scaleTiers);
        }
        if (Array.isArray(config.frameRateTiers) && config.frameRateTiers.length > 0) {
            controller.setFrameRateTiers?.(config.frameRateTiers);
        }
        return controller;
    }
}

export const thermal = new Thermal();
