import { shouldRenderFrame, FrameLimiterState, defaultSoftwareFrameLimitEnabled } from '../../cocos/game/frame-limiter';
import { Game } from '../../cocos/game/game';
import { director } from '../../cocos/game/director';

describe('frame-limiter', () => {
    const newState = (): FrameLimiterState => ({ accumulator: 0, lastTime: 0 });

    test('targetFrameRate=60 时每帧都渲染（零回归）', () => {
        const state = newState();
        for (let i = 0; i < 100; i++) {
            expect(shouldRenderFrame(state, i * 16.7, 60)).toBe(true);
        }
    });

    test('targetFrameRate=0 时恒 true（不设限）', () => {
        const state = newState();
        for (let i = 0; i < 100; i++) {
            expect(shouldRenderFrame(state, i * 16.7, 0)).toBe(true);
        }
    });

    test('targetFrameRate=30 时，16.7ms 递增的时间序列下渲染帧间隔约 33.4ms', () => {
        const state = newState();
        const renderTimes: number[] = [];
        for (let i = 0; i < 200; i++) {
            const now = i * 16.7;
            if (shouldRenderFrame(state, now, 30)) {
                renderTimes.push(now);
            }
        }
        // 渲染帧间隔应为 2 个 16.7ms
        expect(renderTimes.length).toBeGreaterThan(1);
        for (let j = 1; j < renderTimes.length; j++) {
            expect(renderTimes[j] - renderTimes[j - 1]).toBeCloseTo(33.4, 1);
        }
    });

    test('累加器余数正确：3 次 16.7ms 回调渲染 1 次，余数约 16.7ms', () => {
        const state = newState();
        let rendered = 0;
        rendered += shouldRenderFrame(state, 16.7, 30) ? 1 : 0;
        rendered += shouldRenderFrame(state, 33.4, 30) ? 1 : 0;
        rendered += shouldRenderFrame(state, 50.1, 30) ? 1 : 0;
        expect(rendered).toBe(1);
        expect(state.accumulator).toBeGreaterThan(16);
        expect(state.accumulator).toBeLessThan(18);
    });

    test('暂停/初始化后大时间跳变被封顶，快速恢复隔帧节奏', () => {
        const state = newState();
        shouldRenderFrame(state, 0, 30); // 初始化
        // 模拟暂停后恢复：时间跳变 10 秒
        let consecutiveRenders = 0;
        let maxConsecutive = 0;
        for (let i = 0; i < 30; i++) {
            const now = 10000 + i * 16.7;
            if (shouldRenderFrame(state, now, 30)) {
                consecutiveRenders++;
                maxConsecutive = Math.max(maxConsecutive, consecutiveRenders);
            } else {
                consecutiveRenders = 0;
            }
        }
        // 封顶 100ms 后，最多连续渲染约 5 帧就回到隔帧节奏（不封顶时会连续渲染几十帧）
        expect(maxConsecutive).toBeLessThanOrEqual(5);
    });

    test('E07 默认门控：只在小游戏平台开启', () => {
        expect(defaultSoftwareFrameLimitEnabled(false, false)).toBe(false); // web / native
        expect(defaultSoftwareFrameLimitEnabled(true, false)).toBe(true);   // 任意小游戏（微信/抖音/支付宝/淘宝/OPPO/vivo/华为…）
        expect(defaultSoftwareFrameLimitEnabled(false, true)).toBe(true);   // 微信小程序
        expect(defaultSoftwareFrameLimitEnabled(true, true)).toBe(true);    // 两者都算
    });

    describe('E07 集成：Game._updateCallback 与 pacer 的先后关系', () => {
        let now = 0;
        let tick: jest.SpyInstance;

        const makeFakeGame = (frameRate: number, limit: boolean): any => ({
            _inited: true,
            _shouldLoadLaunchScene: false,
            _frameRate: frameRate,
            _softwareFrameLimitEnabled: limit,
            _frameLimiterState: newState(),
            _calculateDT: () => 0.016,
        });

        const call = (fake: any): void => {
            (Game.prototype as any)._updateCallback.call(fake);
        };

        beforeEach(() => {
            now = 0;
            jest.spyOn(performance, 'now').mockImplementation(() => now);
            tick = jest.spyOn(director, 'tick').mockImplementation(() => { /* 不真的跑一帧 */ });
        });

        afterEach(() => {
            jest.restoreAllMocks();
        });

        test('frameRate=30 且门控开启：每两帧只 tick 一次', () => {
            const g = makeFakeGame(30, true);
            call(g);                    // t=0
            now = 16.7; call(g);        // 累计 16.7 < 33.3 → 跳过
            now = 33.4; call(g);        // 累计 33.4 ≥ 33.3 → tick
            now = 50.1; call(g);        // 又跳过
            now = 66.8; call(g);        // tick
            expect(tick).toHaveBeenCalledTimes(2);
        });

        test('frameRate=30 但门控关闭（Web/Native 默认）：每帧都 tick', () => {
            const g = makeFakeGame(30, false);
            for (let i = 0; i < 5; i++) {
                now = i * 16.7;
                call(g);
            }
            expect(tick).toHaveBeenCalledTimes(5);
        });

        test('frameRate=60：无论门控如何都每帧 tick', () => {
            const g = makeFakeGame(60, true);
            for (let i = 0; i < 5; i++) {
                now = i * 16.7;
                call(g);
            }
            expect(tick).toHaveBeenCalledTimes(5);
        });
    });
});
