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
import type { IFrameTimeSampler, FrameTimeSource } from './types';

/** 超过这个间隔就不当作一帧（切后台、断点、真机挂起都会造出几十秒的间隔） */
const MAX_FRAME_DELTA_MS = 1000;

interface FrameTimeSample {
    time: number;
    frameTime: number;
}

function defaultFrameTimeSource (): number {
    return performance.now();
}

/**
 * @en Samples raw frame time on the JS side without touching core.
 * It listens to the director's BEFORE_UPDATE event, measures the interval between
 * two adjacent frames, and keeps a sliding window over the most recent windowSeconds.
 * The window is time-based, so its span does not drift with the frame rate.
 * @zh 在 JS 侧自采原始帧时间，不动 core。它监听导演的 BEFORE_UPDATE 事件，测量相邻两帧的间隔，
 * 并保留最近 windowSeconds 秒内的样本。窗口按时间开窗，跨度不随帧率漂移。
 */
export class FrameTimeSampler implements IFrameTimeSampler {
    private _samples: FrameTimeSample[] = [];
    private _windowSeconds: number;
    private _timeSource: FrameTimeSource;
    private _lastTime = 0;
    private _running = false;

    /**
     * @param windowSeconds - Length of the sliding window in seconds. Default 20.
     * @param timeSource - Injectable timestamp source (used by tests). Defaults to performance.now.
     */
    constructor (windowSeconds = 20, timeSource: FrameTimeSource = defaultFrameTimeSource) {
        this._windowSeconds = windowSeconds;
        this._timeSource = timeSource;
    }

    /**
     * @en Starts sampling. The director listener is registered only when started.
     * NOTE: the sliding window is **not** cleared here. If sampling was stopped and restarted,
     * samples captured before the stop keep contributing to the average until they fall out of the
     * time window (samples older than windowSeconds are pruned on the next frame). Call reset()
     * first when you need statistics for the new session only.
     * @zh 开始采样。仅在启动后才注册导演监听。
     * 注意：这里**不会**清空滑动窗口。若中间 stop 过，停止前的样本会继续参与平均，
     * 直到它们超出时间窗（超过 windowSeconds 的样本会在下一帧被裁掉）。
     * 需要只统计新会话时，先调 reset()。
     */
    public start (): void {
        if (this._running) {
            return;
        }
        this._running = true;
        this._lastTime = this._timeSource();
        director.on(DirectorEvent.BEFORE_UPDATE, this._onBeforeUpdate, this);
    }

    /**
     * @en Stops sampling and unregisters the director listener (zero-overhead when stopped).
     * The window is intentionally kept, so the last average stays readable after stopping (logging,
     * reporting). It is NOT a "discard" operation — use reset() for that.
     * @zh 停止采样并注销导演监听（停止后零开销）。
     * 窗口数据刻意保留，停止后仍能读到最后一次平均值（日志/上报用）；它不是"丢弃"操作，
     * 要丢弃请调 reset()。
     */
    public stop (): void {
        if (!this._running) {
            return;
        }
        this._running = false;
        director.off(DirectorEvent.BEFORE_UPDATE, this._onBeforeUpdate, this);
    }

    /**
     * @en Length of the sliding window in seconds. Exposed so the controller can align its
     * resume() warm-up with the window (a 5s warm-up over a 20s window would decide on half-empty data).
     * @zh 滑动窗口长度（秒）。暴露给控制器，让 resume() 的预热能对齐窗口长度
     *（5s 预热配 20s 窗口 = 用半空的数据做决策）。
     */
    public get windowSeconds (): number {
        return this._windowSeconds;
    }

    /**
     * @en Clears the sliding window.
     * @zh 清空滑动窗口。
     */
    public reset (): void {
        this._samples.length = 0;
        this._lastTime = this._timeSource();
    }

    /**
     * @en Returns the average frame time over the sliding window, in milliseconds. Returns 0 when empty.
     * While stopped (or paused by the controller, which only calls stop()), this returns the value
     * frozen at the moment of stop — stale by definition, not 0.
     * @zh 返回滑动窗口内的平均帧时间（毫秒），窗口为空时返回 0。
     * 处于停止状态时（控制器 pause() 只调 stop()），返回的是停止那一刻的值 —— 属于陈旧值，不是 0。
     */
    public getAverageFrameTimeMs (): number {
        const { length } = this._samples;
        if (length === 0) {
            return 0;
        }
        let sum = 0;
        for (let i = 0; i < length; i++) {
            sum += this._samples[i].frameTime;
        }
        return sum / length;
    }

    private _onBeforeUpdate (): void {
        const now = this._timeSource();
        const frameTime = now - this._lastTime;
        this._lastTime = now;
        if (frameTime <= 0) {
            return;
        }
        // E03：切后台/断点会造出一个"几十秒的帧间隔"。它一旦进窗口，平均帧时间会被拉到几十毫秒，
        // 恢复瞬间就误判降档（用户看到的是"切回来就变糊"）。这类间隔不是帧，直接丢弃；
        // _lastTime 已更新，下一帧的间隔仍然正确。
        if (frameTime > MAX_FRAME_DELTA_MS) {
            return;
        }
        this._samples.push({ time: now, frameTime });
        const cutoff = now - this._windowSeconds * 1000;
        while (this._samples.length > 0 && this._samples[0].time < cutoff) {
            this._samples.shift();
        }
    }
}
