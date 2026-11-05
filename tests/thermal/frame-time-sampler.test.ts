import { director, DirectorEvent } from '../../cocos/game/director';
import { FrameTimeSampler } from '../../cocos/thermal/frame-time-sampler';

interface Listener {
    cb: () => void;
    thisArg: unknown;
}

describe('FrameTimeSampler', () => {
    let listeners: Listener[];

    beforeEach(() => {
        listeners = [];
        jest.spyOn(director, 'on').mockImplementation((type: string | number, cb: () => void, thisArg?: unknown) => {
            expect(type).toBe(DirectorEvent.BEFORE_UPDATE);
            listeners.push({ cb, thisArg });
            return cb;
        });
        jest.spyOn(director, 'off').mockImplementation((type: string | number, cb?: () => void, thisArg?: unknown) => {
            expect(type).toBe(DirectorEvent.BEFORE_UPDATE);
            if (cb) {
                const idx = listeners.findIndex((l) => l.cb === cb && l.thisArg === thisArg);
                if (idx >= 0) {
                    listeners.splice(idx, 1);
                }
            }
        });
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    const fire = (): void => {
        for (const { cb, thisArg } of listeners) {
            cb.call(thisArg);
        }
    };

    test('时间窗内的平均帧时间', () => {
        let now = 0;
        const sampler = new FrameTimeSampler(10, () => now);
        sampler.start();
        now = 10; fire(); // 10
        now = 20; fire(); // 10
        now = 35; fire(); // 15
        expect(sampler.getAverageFrameTimeMs()).toBeCloseTo(35 / 3, 10);

        sampler.stop();
    });

    test('窗口按时间开窗，旧样本按时间戳滑出', () => {
        let now = 0;
        const sampler = new FrameTimeSampler(1, () => now); // 1 秒窗口
        sampler.start();
        now = 100; fire(); // frameTime 100, time 100
        now = 200; fire(); // frameTime 100, time 200
        expect(sampler.getAverageFrameTimeMs()).toBeCloseTo(100, 10);

        // 推进到 1200ms，窗口截止 1200-1000=200，time=100 的样本滑出
        now = 1200; fire(); // frameTime 1000, time 1200
        expect(sampler.getAverageFrameTimeMs()).toBeCloseTo((100 + 1000) / 2, 10);

        sampler.stop();
    });

    test('reset 清空窗口', () => {
        let now = 0;
        const sampler = new FrameTimeSampler(10, () => now);
        sampler.start();
        now = 10; fire();
        now = 20; fire();
        expect(sampler.getAverageFrameTimeMs()).toBeCloseTo(10, 10);

        sampler.reset();
        expect(sampler.getAverageFrameTimeMs()).toBe(0);

        now = 35; fire(); // reset 后从 20 起算，frameTime 15
        expect(sampler.getAverageFrameTimeMs()).toBeCloseTo(15, 10);

        sampler.stop();
    });

    test('E03：切后台的超长间隔不计入窗口（不会一次把均值拉到几十毫秒）', () => {
        let now = 0;
        const sampler = new FrameTimeSampler(20, () => now);
        sampler.start();

        // 600 帧 16.67ms 的稳态
        for (let i = 0; i < 600; i++) {
            now += 16.67;
            fire();
        }
        const before = sampler.getAverageFrameTimeMs();
        expect(before).toBeCloseTo(16.67, 1);

        // 模拟切后台 30 秒后回来
        now += 30000;
        fire();

        // 这个 30s 的"帧"必须被丢弃：均值不能被拉高
        const after = sampler.getAverageFrameTimeMs();
        expect(after).toBeCloseTo(before, 1);
        expect(after).toBeLessThan(100);

        // 恢复后的一帧仍然正常计入
        now += 16.67;
        fire();
        expect(sampler.getAverageFrameTimeMs()).toBeCloseTo(16.67, 1);

        sampler.stop();
    });

    test('start/stop 后不再计数（零开销红线）', () => {
        let now = 0;
        const sampler = new FrameTimeSampler(10, () => now);
        expect(listeners.length).toBe(0);

        sampler.start();
        expect(listeners.length).toBe(1);

        sampler.start(); // 重复 start 不重复注册
        expect(listeners.length).toBe(1);

        now = 10; fire();
        now = 20; fire();
        expect(sampler.getAverageFrameTimeMs()).toBeCloseTo(10, 10);

        sampler.stop();
        expect(listeners.length).toBe(0);

        const avgAfterStop = sampler.getAverageFrameTimeMs();
        now = 100; fire();
        now = 200; fire();
        expect(sampler.getAverageFrameTimeMs()).toBe(avgAfterStop);
    });
});
