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

import { director } from '../../game/director';
import { cclegacy } from '../../core';
import type { IThermalAction, IThermalFsr } from '../types';
import { buildLevels } from './levels';

/** 档位比较的容差（0.85 这类小数直接比较会因浮点误差漏判） */
const LEVEL_EPSILON = 1e-6;

/**
 * Reads the runtime shading scale. In the phase-1 WeChat mini game setup (custom pipeline), this is
 * director.root.pipeline (a WebPipeline), whose shadingScale reads pipelineSceneData.shadingScale.
 * The default 1.0 means "not overridden" (matching the builtin pipeline's runtime-override sentinel).
 */
function defaultReadScale (): number {
    const pipeline = director.root?.pipeline;
    return pipeline ? pipeline.shadingScale : 1.0;
}

/**
 * Writes the runtime shading scale and forces RT rebuild. The WebPipeline shadingScale setter only
 * writes pipelineSceneData and does not rebuild render targets, so forceResizeAllWindows is required,
 * otherwise "the value changes but the RT size does not".
 *
 * Known limitation (7a report, plan A): when the editor has configured a per-camera shadingScale < 1,
 * readScale() still returns 1.0 (the pipelineSceneData default), so the tiers start from 1.0. This
 * phase does not support that scenario.
 */
function defaultWriteScale (scale: number): void {
    const pipeline = director.root?.pipeline;
    if (pipeline) {
        pipeline.shadingScale = scale;
    }
    // 双可选链：rendering 或方法本身缺失时都不抛（与 StressTestController 里的写法保持一致）
    cclegacy.rendering?.forceResizeAllWindows?.();
}

/**
 * @en Resolution action of the thermal control: steps the shading scale down/up through discrete
 * tiers, never jumping straight to the floor. The original scale is recorded at construction time
 * and restored by restore(). Every step also notifies the FSR controller (`apply(scale)`), which
 * enables the custom pipeline's FSR pass on the camera's `BuiltinPipelineSettings` while the scale
 * is below 1 (and below `fsrMinScale`); the FSR material comes from `thermal.setFsrMaterial()`.
 * @zh 温控的分辨率动作：按离散档位逐档降/升渲染缩放（shadingScale），绝不一步到地板。构造时记录
 * 原值，restore() 还原。每次变档都会通知 FSR 控制器（`apply(scale)`），由它在 scale < 1（且
 * <= `fsrMinScale`）期间打开相机 `BuiltinPipelineSettings` 上的 FSR pass；FSR 材质通过
 * `thermal.setFsrMaterial()` 提供。
 */
/**
 * SCOPE: the runtime shadingScale resizes 3D camera render targets only. A Canvas/UI camera is
 * NOT scaled, so a full-screen 2D Sprite/UI shader keeps its native fragment count. For 2D/UI
 * heavy games disable this action (enableScale=false) and use the frame-rate lever only.
 */
export class ScaleAction implements IThermalAction {
    private _originalScale: number;
    private _currentScale: number;
    private _minScale: number;
    private _levels: number[];
    private _writeScale: (scale: number) => void;
    private _readScale: () => number;
    private _fsr?: IThermalFsr;
    private _enabled = true;

    /**
     * @param minScale - The floor scale. Default 0.6.
     * @param tiers - Discrete descending tiers used to step down. Default [0.8, 0.6].
     * @param readScale - Injectable reader (used by tests). Defaults to reading the runtime pipeline shadingScale.
     * @param writeScale - Injectable writer (used by tests). Defaults to writing pipeline shadingScale + forceResize.
     * @param fsr - Optional FSR controller. When provided, it is applied on every scale change.
     */
    constructor (
        minScale = 0.6,
        tiers: number[] = [0.8, 0.6],
        readScale: () => number = defaultReadScale,
        writeScale: (scale: number) => void = defaultWriteScale,
        fsr: IThermalFsr | undefined = undefined,
    ) {
        this._minScale = minScale;
        this._writeScale = writeScale;
        this._fsr = fsr;
        this._readScale = readScale;
        this._originalScale = readScale();
        this._currentScale = this._originalScale;
        this._levels = buildLevels(this._originalScale, tiers, minScale);
    }

    /**
     * E02：外部可能直接改 pipeline.shadingScale（手动 setScale、DRS 循环、screen.resolutionScale…），
     * 缓存会漂移。每次决策前用注入的 reader 读一次实时值，保证"降档"不会变成"升分辨率"。
     */
    private _syncCurrent (): void {
        const live = this._readScale();
        if (typeof live === 'number' && isFinite(live)) {
            this._currentScale = live;
        }
    }

    /** 档位表降序：返回第一个严格小于 v 的档（= 下一档）。
     *  必须从 i=0 扫起：外部写入超采样（如 setScale(2.0)）时，表内 top 档 1.0 才是"下一档"，
     *  从 i=1 起会一步跳过它（2.0 → 0.85）。 */
    private _nextBelow (v: number): number | null {
        for (let i = 0; i < this._levels.length; i++) {
            if (this._levels[i] < v - LEVEL_EPSILON) return this._levels[i];
        }
        return null;
    }

    /** 返回严格大于 v 的最小档（= 上一档） */
    private _nextAbove (v: number): number | null {
        for (let i = this._levels.length - 1; i >= 0; i--) {
            if (this._levels[i] > v + LEVEL_EPSILON) return this._levels[i];
        }
        return null;
    }

    /**
     * @en Steps the shading scale down by one tier. Returns false once the floor is reached.
     * @zh 渲染缩放降一档。到达地板后返回 false。
     */
    public stepDown (): boolean {
        if (!this._enabled) {
            return false;
        }
        this._syncCurrent();
        const next = this._nextBelow(this._currentScale);
        if (next === null) {
            return false;
        }
        this._currentScale = next;
        this._writeScale(next);
        this._fsr?.apply(next);
        return true;
    }

    /**
     * @en Steps the shading scale up by one tier. Returns false once the original scale is restored.
     * @zh 渲染缩放升一档。恢复到原值后返回 false。
     */
    public stepUp (): boolean {
        if (!this._enabled) {
            return false;
        }
        this._syncCurrent();
        const next = this._nextAbove(this._currentScale);
        if (next === null) {
            return false;
        }
        this._currentScale = next;
        this._writeScale(next);
        this._fsr?.apply(next);
        return true;
    }

    /**
     * @en Returns the current shading scale tier.
     * @zh 返回当前分辨率档位。
     */
    public getCurrent (): number {
        this._syncCurrent();
        return this._currentScale;
    }

    /**
     * @en How many tiers this lever is currently below its original value (0 = not downgraded).
     * Used by the controller to derive the thermal level from real lever state instead of
     * a running counter, so restoring one lever (e.g. setScaleEnabled(false)) cannot leave
     * the reported level stuck.
     * @zh 该杠杆相对原值当前降了几档（0 = 未降）。控制器用它从杠杆实际状态推导温控等级，
     * 而不是靠累加计数器 —— 这样单独还原一个杠杆（如 setScaleEnabled(false)）不会让上报的等级卡住。
     */
    public getStepsDown (): number {
        this._syncCurrent();
        let steps = 0;
        for (let i = 1; i < this._levels.length; i++) {
            if (this._levels[i] >= this._currentScale - LEVEL_EPSILON) steps = i;
        }
        return steps;
    }

    /**
     * @en Enables/disables the scale lever. Disabling restores the original scale and FSR state.
     * @zh 启用/禁用 scale 杠杆。禁用时还原原缩放和 FSR 状态。
     */
    public setEnabled (enabled: boolean): void {
        if (this._enabled === enabled) {
            return;
        }
        this._enabled = enabled;
        if (!enabled) {
            this.restore();
        }
    }

    public isEnabled (): boolean {
        return this._enabled;
    }

    /**
     * @en Restores the shading scale recorded at construction time.
     * @zh 还原到构造时记录的原缩放值。
     */
    public restore (): void {
        this._currentScale = this._originalScale;
        this._writeScale(this._originalScale);
        this._fsr?.restore();
    }

    /**
     * @en Whether the shading scale has reached the floor. Read-only query; must stay consistent with
     * `stepDown() === false` (see IThermalAction.isAtFloor).
     * @zh 缩放是否已到达地板。只读查询；必须与 `stepDown() === false` 保持一致
     *（见 IThermalAction.isAtFloor）。
     */
    public isAtFloor (): boolean {
        this._syncCurrent();
        return this._currentScale <= this._minScale;
    }

    /**
     * @en Whether moving from `from` to `to` crosses the FSR on/off threshold. Returns false when
     * there is no FSR controller (or the controller does not implement `wouldEnableAt`).
     * @zh 从 `from` 到 `to` 是否跨过 FSR 开关阈值。没有 FSR 控制器（或未实现 `wouldEnableAt`）时返回 false。
     */
    public isFsrStateChanging (from: number, to: number): boolean {
        const fsr: any = this._fsr;
        if (!fsr || typeof fsr.wouldEnableAt !== 'function') {
            return false;
        }
        return fsr.wouldEnableAt(from) !== fsr.wouldEnableAt(to);
    }
}
