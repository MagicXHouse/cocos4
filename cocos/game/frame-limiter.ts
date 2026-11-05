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
 * @en Persistent state of the software frame limiter.
 * @zh 软件限帧器的持久状态。
 */
export interface FrameLimiterState {
    /** @en Accumulated time in milliseconds. @zh 累计时间（毫秒）。 */
    accumulator: number;
    /** @en Timestamp of the last callback, in milliseconds. @zh 上次回调的时间戳（毫秒）。 */
    lastTime: number;
}

/** Maximum delta between two callbacks that is accounted, to survive pause/resume time jumps. */
const MAX_FRAME_DELTA_MS = 100;

/**
 * @en Default policy for the software frame limiter: only environments where the platform may
 * ignore a `< 60` request need it.
 * - Any mini-game platform (`MINIGAME`: WeChat / ByteDance / Alipay / Taobao / OPPO / vivo / Huawei…)
 *   and WeChat mini program: the preferred-frames request can be ignored, so the limiter is required.
 * - Web: pacer-web already throttles internally → must stay off to avoid double throttling.
 * - Native: the platform delivers ticks at the requested rate → not needed.
 * @zh 软件限帧的默认策略：只有"平台可能忽略 < 60 请求"的环境才需要。
 * - 任意小游戏平台（`MINIGAME`：微信 / 抖音 / 支付宝 / 淘宝 / OPPO / vivo / 华为…）与微信小程序：
 *   setPreferredFramesPerSecond 可能被忽略 → 需要；
 * - Web：pacer-web 自己已按 _frameTime 节流 → 必须关闭，否则是双重节流；
 * - Native：平台按请求交付 tick → 不需要。
 */
export function defaultSoftwareFrameLimitEnabled (minigame: boolean, wechatMiniProgram: boolean): boolean {
    return minigame || wechatMiniProgram;
}

/**
 * @en Decides whether the current frame should be rendered, implementing software frame rate
 * limiting. When the target frame rate is at or above 60 (the default) or not set, every frame is
 * rendered, which is exactly the previous behaviour (zero regression). For lower targets the
 * callback is throttled: RAF keeps firing at 60Hz, but only every N-th frame actually ticks.
 *
 * Limitation: a target that does not divide 60 evenly (e.g. 45 on a 60Hz display) produces uneven
 * frame intervals (16.7ms / 33.3ms alternating) and therefore judder. This is a physical limit of
 * software limiting, not a bug - thermal tiers should use divisors of 60 such as 30/20/15.
 * @zh 判断当前帧是否应渲染，实现软件限帧。目标帧率 >= 60（默认）或未设限时每帧都渲染，与改动前
 * 完全一致（零回归）。目标更低时对回调节流：RAF 仍以 60Hz 触发，但每隔 N 帧才真正 tick。
 *
 * 局限：不能整除 60 的目标帧率（如 60Hz 屏上的 45）会造成帧间隔不均（16.7ms / 33.3ms 交替）→
 * 抖动，这是软件限帧的物理限制而非 bug，温控档位建议用 30/20/15 这类 60 的整除档。
 *
 * @en Behavior change: on WeChat mini games, frame rates below 60 used to be silently ignored by
 * wx.setPreferredFramesPerSecond and the game kept running at 60; the engine now software-limits to
 * actually match the target.
 * NOTE: this limiter is NOT a no-op on Web/Native — it runs on every platform's pacer tick. On Web
 * the pacer already throttles by itself (`_handleRAF`'s elapseFrame/frameCount), so enabling this
 * there means double throttling (extra dropped frames / phase drift). That is why `Game` gates it
 * with `enableSoftwareFrameLimit`, which defaults to true only on mini-game platforms.
 * @zh 行为变化：此前微信小游戏上低于 60 的帧率会被 wx.setPreferredFramesPerSecond 静默忽略、实际
 * 仍跑满 60；现在引擎软件强制限帧、真正按目标帧率运行。
 * 注意：这个限帧器在 Web/Native 上**不是 no-op** —— 它挂在所有平台的 pacer tick 上。Web 的 pacer
 * 本身就会按 `_handleRAF` 的 elapseFrame/frameCount 节流，再叠一层就是双重节流（多丢帧/相位漂移）。
 * 所以 `Game` 用 `enableSoftwareFrameLimit` 做门控，默认只在小游戏平台开启。
 */
export function shouldRenderFrame (state: FrameLimiterState, now: number, targetFrameRate: number): boolean {
    // No limit, or target >= 60: render every frame (zero regression at the default 60fps).
    if (targetFrameRate <= 0 || targetFrameRate >= 60) {
        state.accumulator = 0;
        state.lastTime = now;
        return true;
    }
    const intervalMs = 1000 / targetFrameRate;
    // Cap the delta so a large time jump (pause/resume or initialization) cannot flood the
    // accumulator and make the limiter render at full speed for a long time.
    const delta = Math.min(now - state.lastTime, MAX_FRAME_DELTA_MS);
    state.accumulator += delta;
    state.lastTime = now;
    if (state.accumulator < intervalMs) {
        return false; // Not enough accumulated time for one frame yet, skip.
    }
    state.accumulator -= intervalMs; // Keep the remainder to avoid accumulating error.
    return true;
}
