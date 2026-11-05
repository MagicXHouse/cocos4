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

import { game } from '../../game';
import type { IThermalAction } from '../types';
import { buildLevels } from './levels';

/** 档位比较的容差（小数/帧率比较避免浮点误差漏判） */
const LEVEL_EPSILON = 1e-6;

function defaultReadFrameRate (): number {
    // game.frameRate is deprecated but is still the correct runtime source of the current
    // target frame rate (it reflects changes applied by the thermal control itself).
    const fr = game.frameRate;
    const n = typeof fr === 'number' ? fr : parseInt(fr, 10);
    // 0（或 ≤0）在微信小游戏里常表示"不限帧/跟屏幕刷新率跑满"，对温控而言天花板应归一到 60，
    // 否则 frameTime = 1000/0 会除零、档位表也会退化成 no-op。非法值（NaN/Infinity）同理兜底 60。
    return Number.isFinite(n) && n > 0 ? n : 60;
}

function defaultWriteFrameRate (fps: number): void {
    game.frameRate = fps;
}

/**
 * @en Frame rate action of the thermal control: steps the frame rate down/up through discrete
 * tiers, never jumping straight to the floor. The original frame rate is recorded at construction
 * time and restored by restore().
 * @zh 温控的帧率动作：按离散档位逐档降/升帧率，绝不一步到地板。构造时记录原帧率，restore() 还原。
 */
export class FrameRateAction implements IThermalAction {
    private _originalFrameRate: number;
    private _currentFrameRate: number;
    private _minFrameRate: number;
    private _levels: number[];
    private _writeFrameRate: (fps: number) => void;
    private _readFrameRate: () => number;

    /**
     * @param minFrameRate - The floor frame rate. Default 30.
     * @param tiers - Discrete descending tiers used to step down. Default [60, 30]（45 不是 60 的整数因子会 judder）. On 60Hz
     *   displays (typical WeChat mini games), 45 is not an integer division of 60 and may cause
     *   judder; consider passing [60, 30] there.
     * @param readFrameRate - Injectable reader (used by tests). Defaults to reading game.frameRate.
     * @param writeFrameRate - Injectable writer (used by tests). Defaults to writing game.frameRate.
     */
    constructor (
        minFrameRate = 30,
        tiers: number[] = [60, 30],
        readFrameRate: () => number = defaultReadFrameRate,
        writeFrameRate: (fps: number) => void = defaultWriteFrameRate,
    ) {
        this._minFrameRate = minFrameRate;
        this._writeFrameRate = writeFrameRate;
        this._readFrameRate = readFrameRate;
        this._originalFrameRate = readFrameRate();
        this._currentFrameRate = this._originalFrameRate;
        this._levels = buildLevels(this._originalFrameRate, tiers, minFrameRate);
    }

    /** E02：外部可能直接改 game.frameRate（项目自带的 setFps、其他系统），决策前读实时值 */
    private _syncCurrent (): void {
        const live = this._readFrameRate();
        if (typeof live === 'number' && isFinite(live) && live > 0) {
            this._currentFrameRate = live;
        }
    }

    /** 档位表降序：返回第一个严格小于 v 的档（= 下一档）。
     *  必须从 i=0 扫起：外部把 game.frameRate 设成 120 时，表内 top 档 60 才是"下一档"，
     *  从 i=1 起会一步跳到 30（跨两档）。 */
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
     * @en Steps the frame rate down by one tier. Returns false once the floor is reached.
     * @zh 帧率降一档。到达地板后返回 false。
     */
    public stepDown (): boolean {
        this._syncCurrent();
        const next = this._nextBelow(this._currentFrameRate);
        if (next === null) {
            return false;
        }
        this._currentFrameRate = next;
        this._writeFrameRate(next);
        return true;
    }

    /**
     * @en Steps the frame rate up by one tier. Returns false once the original frame rate is restored.
     * @zh 帧率升一档。恢复到原帧率后返回 false。
     */
    public stepUp (): boolean {
        this._syncCurrent();
        const next = this._nextAbove(this._currentFrameRate);
        if (next === null) {
            return false;
        }
        this._currentFrameRate = next;
        this._writeFrameRate(next);
        return true;
    }

    /**
     * @en Returns the current frame rate tier.
     * @zh 返回当前帧率档位。
     */
    public getCurrent (): number {
        this._syncCurrent();
        return this._currentFrameRate;
    }

    /**
     * @en How many tiers this lever is currently below its original value (0 = not downgraded).
     * @zh 该杠杆相对原值当前降了几档（0 = 未降）。控制器用它从实际状态推导温控等级。
     */
    public getStepsDown (): number {
        this._syncCurrent();
        let steps = 0;
        for (let i = 1; i < this._levels.length; i++) {
            if (this._levels[i] >= this._currentFrameRate - LEVEL_EPSILON) steps = i;
        }
        return steps;
    }

    /**
     * @en Restores the frame rate recorded at construction time.
     * @zh 还原到构造时记录的原帧率。
     */
    public restore (): void {
        this._currentFrameRate = this._originalFrameRate;
        this._writeFrameRate(this._originalFrameRate);
    }

    /**
     * @en Whether the frame rate has reached the floor. Read-only query; must stay consistent with
     * `stepDown() === false` (see IThermalAction.isAtFloor).
     * @zh 帧率是否已到达地板。只读查询；必须与 `stepDown() === false` 保持一致
     *（见 IThermalAction.isAtFloor）。
     */
    public isAtFloor (): boolean {
        this._syncCurrent();
        return this._currentFrameRate <= this._minFrameRate;
    }
}
