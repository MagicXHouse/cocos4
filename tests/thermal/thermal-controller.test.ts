import { director, DirectorEvent } from '../../cocos/game/director';
import { ThermalController } from '../../cocos/thermal/thermal-controller';
import { ThermalStrategy } from '../../cocos/thermal/thermal-strategy';
import { ScaleAction } from '../../cocos/thermal/actions/scale-action';
import { FrameRateAction } from '../../cocos/thermal/actions/frame-rate-action';
import { ThermalLevel } from '../../cocos/thermal/types';
import type { ThermalStrategyAction } from '../../cocos/thermal/types';

interface Listener {
    cb: () => void;
    thisArg: unknown;
}

describe('ThermalController', () => {
    let listeners: Listener[];

    beforeEach(() => {
        listeners = [];
        jest.spyOn(director, 'on').mockImplementation((type: string | number, cb: () => void, thisArg?: unknown) => {
            expect(type).toBe(DirectorEvent.AFTER_UPDATE);
            listeners.push({ cb, thisArg });
            return cb;
        });
        jest.spyOn(director, 'off').mockImplementation((type: string | number, cb?: () => void, thisArg?: unknown) => {
            expect(type).toBe(DirectorEvent.AFTER_UPDATE);
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

    const makeSampler = (avgMs = 0, sampleCount = 100) => ({
        start: jest.fn(),
        stop: jest.fn(),
        getAverageFrameTimeMs: jest.fn(() => avgMs),
        getSampleCount: jest.fn(() => sampleCount),
        reset: jest.fn(),
    });

    const makeStrategy = (action: 'NONE' | 'DOWN' | 'UP' = 'NONE') => ({
        update: jest.fn(() => action),
        setThreshold: jest.fn(),
        setRecoverThreshold: jest.fn(),
        setRecoverWindowSeconds: jest.fn(),
        setCooldownSeconds: jest.fn(),
        reset: jest.fn(),
    });

    const makeFrameRateAction = (stepDownResult = true, stepUpResult = true) => ({
        stepDown: jest.fn(() => stepDownResult),
        stepUp: jest.fn(() => stepUpResult),
        restore: jest.fn(),
        isAtFloor: jest.fn(),
        getCurrent: jest.fn(() => 60),
    });

    test('窗口样本太少（<30）时不判定，避免单个异常帧把均值拉爆', () => {
        // 复现真机/开发者工具里看到的：reset 之后窗口只有一个 993ms 的"假帧"
        const sampler = makeSampler(993, 1);
        const strategy = makeStrategy('DOWN');
        const frameRateAction = makeFrameRateAction(true);
        const scaleAction = {
            stepDown: jest.fn(() => true),
            stepUp: jest.fn(() => true),
            restore: jest.fn(),
            isAtFloor: jest.fn(() => false),
            getCurrent: jest.fn(() => 1.0),
        };

        let now = 0;
        const controller = new ThermalController(
            { warmupSeconds: 0 }, sampler, strategy, frameRateAction, scaleAction, () => 50, () => now,
        );
        controller.enable();

        fire();
        expect(scaleAction.stepDown).not.toHaveBeenCalled();
        expect(frameRateAction.stepDown).not.toHaveBeenCalled();
        expect(strategy.update).not.toHaveBeenCalled();

        // 样本攒够之后才允许判定（跨过 1s 评估间隔）
        (sampler.getSampleCount as jest.Mock).mockReturnValue(100);
        now += 1000;
        fire();
        expect(strategy.update).toHaveBeenCalled();
        expect(scaleAction.stepDown).toHaveBeenCalled();

        controller.disable();
    });

    test('DOWN 驱动帧率降档，且降档后 sampler.reset() 被调用', () => {
        const sampler = makeSampler(20);
        const strategy = makeStrategy('DOWN');
        const frameRateAction = makeFrameRateAction(true);
        const controller = new ThermalController({ warmupSeconds: 0 }, sampler, strategy, frameRateAction, undefined, () => 50);

        controller.enable();
        fire();

        expect(strategy.update).toHaveBeenCalledWith(20, 20); // targetMs = 1000/50
        expect(frameRateAction.stepDown).toHaveBeenCalled();
        expect(sampler.reset).toHaveBeenCalled();

        controller.disable();
    });

    test('UP 驱动帧率升档，且升档后 sampler.reset() 被调用', () => {
        const sampler = makeSampler(18);
        const strategy = makeStrategy('UP');
        const frameRateAction = makeFrameRateAction(true, true);
        const controller = new ThermalController({ warmupSeconds: 0 }, sampler, strategy, frameRateAction, undefined, () => 50);

        controller.enable();
        fire();

        expect(frameRateAction.stepUp).toHaveBeenCalled();
        expect(sampler.reset).toHaveBeenCalled();

        controller.disable();
    });

    test('帧率已到底时 DOWN 不再降、不 reset', () => {
        const sampler = makeSampler(20);
        const strategy = makeStrategy('DOWN');
        const frameRateAction = makeFrameRateAction(false); // stepDown 返回 false
        const controller = new ThermalController({ warmupSeconds: 0 }, sampler, strategy, frameRateAction, undefined, () => 50);

        controller.enable();
        fire();

        expect(frameRateAction.stepDown).toHaveBeenCalled();
        expect(sampler.reset).not.toHaveBeenCalled();

        controller.disable();
    });

    test('enable 注册监听 + sampler.start()，disable 注销 + sampler.stop() + 还原', () => {
        const sampler = makeSampler(20);
        const strategy = makeStrategy('NONE');
        const frameRateAction = makeFrameRateAction();
        const controller = new ThermalController({ warmupSeconds: 0 }, sampler, strategy, frameRateAction, undefined, () => 50);

        controller.enable();
        expect(listeners.length).toBe(1);
        expect(sampler.start).toHaveBeenCalled();

        controller.disable();
        expect(listeners.length).toBe(0);
        expect(sampler.stop).toHaveBeenCalled();
        expect(frameRateAction.restore).toHaveBeenCalled();
    });

    test('setThreshold 委托给 strategy，reset 委托给 sampler + strategy', () => {
        const sampler = makeSampler(20);
        const strategy = makeStrategy('NONE');
        const frameRateAction = makeFrameRateAction();
        const controller = new ThermalController({ warmupSeconds: 0 }, sampler, strategy, frameRateAction, undefined, () => 50);

        controller.setThreshold(10);
        expect(strategy.setThreshold).toHaveBeenCalledWith(10);

        controller.reset();
        expect(sampler.reset).toHaveBeenCalled();
        expect(strategy.reset).toHaveBeenCalled();
    });

    test('降档后 _level 变化触发 onLevelChange', () => {
        const sampler = makeSampler(20);
        const strategy = makeStrategy('NONE');
        const frameRateAction = makeFrameRateAction(true);
        const controller = new ThermalController({ warmupSeconds: 0 }, sampler, strategy, frameRateAction, undefined, () => 50);
        const cb = jest.fn();

        controller.onLevelChange(cb);
        controller.stepDown();

        expect(cb).toHaveBeenCalledWith(ThermalLevel.Hot); // Normal(0) -> Hot(1)
    });

    test('E01：setScaleEnabled(false) 还原 scale 后，等级不再卡在 Emergency', () => {
        const sampler = makeSampler(20);
        const strategy = makeStrategy('NONE');
        let fps = 60;
        const frameRateAction = new FrameRateAction(30, [60, 30], () => fps, (v) => { fps = v; });
        let scale = 1.0;
        const scaleAction = new ScaleAction(0.3, [0.85, 0.7], () => scale, (v) => { scale = v; });
        const controller = new ThermalController({ warmupSeconds: 0 }, sampler, strategy, frameRateAction, scaleAction, () => fps);

        controller.stepDown();   // scale 1.0 -> 0.85
        controller.stepDown();   // scale 0.85 -> 0.7
        expect(controller.getLevel()).toBe(ThermalLevel.Emergency);

        const cb = jest.fn();
        controller.onLevelChange(cb);
        controller.setScaleEnabled(false);   // 禁用一个杠杆 → scale 被还原

        expect(scale).toBeCloseTo(1.0, 6);
        expect(controller.getLevel()).toBe(ThermalLevel.Normal);
        expect(cb).toHaveBeenCalledWith(ThermalLevel.Normal);
    });

    test('E04：downgradeOrder=frameRate-first 时先降帧率、分辨率不动', () => {
        const sampler = makeSampler(20);
        const strategy = makeStrategy('NONE');
        let fps = 60;
        const frameRateAction = new FrameRateAction(30, [60, 30], () => fps, (v) => { fps = v; });
        let scale = 1.0;
        const scaleAction = new ScaleAction(0.3, [0.85, 0.7], () => scale, (v) => { scale = v; });
        const controller = new ThermalController(
            { warmupSeconds: 0, downgradeOrder: 'frameRate-first' },
            sampler, strategy, frameRateAction, scaleAction, () => fps);

        expect(controller.stepDown()).toBe(true);
        expect(fps).toBe(30);
        expect(scale).toBeCloseTo(1.0, 6);
    });

    test('N2：外部直接还原 scale 后，getLevel() 立刻回到 Normal（不需要外部再调接口）', () => {
        const sampler = makeSampler(20);
        const strategy = makeStrategy('NONE');
        let fps = 60;
        const frameRateAction = new FrameRateAction(30, [60, 30], () => fps, (v) => { fps = v; });
        let scale = 1.0;
        const scaleAction = new ScaleAction(0.3, [0.85, 0.7], () => scale, (v) => { scale = v; });
        const controller = new ThermalController({ warmupSeconds: 0 }, sampler, strategy, frameRateAction, scaleAction, () => fps);

        controller.stepDown();
        controller.stepDown();
        expect(controller.getLevel()).toBe(ThermalLevel.Emergency);

        // DRS / screen.resolutionScale / 用户手写 pipeline.shadingScale：绕过控制器直接还原
        scale = 1.0;

        expect(controller.getLevel()).toBe(ThermalLevel.Normal);
        expect(controller.getState().level).toBe(ThermalLevel.Normal);
        expect(controller.getState().shadingScale).toBeCloseTo(1.0, 6);
    });

    test('手动 stepDown/stepUp/restore 行为正确', () => {
        const sampler = makeSampler(20);
        const strategy = makeStrategy('NONE');
        const frameRateAction = makeFrameRateAction(true, true);
        const controller = new ThermalController({ warmupSeconds: 0 }, sampler, strategy, frameRateAction, undefined, () => 50);

        expect(controller.stepDown()).toBe(true);
        expect(frameRateAction.stepDown).toHaveBeenCalled();

        expect(controller.stepUp()).toBe(true);
        expect(frameRateAction.stepUp).toHaveBeenCalled();

        controller.restore();
        expect(frameRateAction.restore).toHaveBeenCalled();
        expect(sampler.reset).toHaveBeenCalled();
        expect(controller.getLevel()).toBe(ThermalLevel.Normal);
    });

    test('采样窗口为空时跳过判断', () => {
        const sampler = makeSampler(0); // avgMs = 0
        const strategy = makeStrategy('DOWN');
        const frameRateAction = makeFrameRateAction(true);
        const controller = new ThermalController({ warmupSeconds: 0 }, sampler, strategy, frameRateAction, undefined, () => 50);

        controller.enable();
        fire();

        expect(strategy.update).not.toHaveBeenCalled();

        controller.disable();
    });

    test('主循环节流：1 秒内只判断一次', () => {
        const sampler = makeSampler(20);
        const strategy = makeStrategy('NONE');
        const frameRateAction = makeFrameRateAction();
        let now = 0;
        const controller = new ThermalController({ warmupSeconds: 0 }, sampler, strategy, frameRateAction, undefined, () => 50, () => now);

        controller.enable();
        fire(); // now=0，第一次判断
        fire(); // now=0，被节流
        expect(strategy.update).toHaveBeenCalledTimes(1);

        now = 2000; // 推进 2 秒
        fire(); // 判断
        expect(strategy.update).toHaveBeenCalledTimes(2);

        controller.disable();
    });

    test('restore 还原后档位回到 Normal 并触发 onLevelChange', () => {
        const sampler = makeSampler(20);
        const strategy = makeStrategy('NONE');
        const frameRateAction = makeFrameRateAction(true);
        const controller = new ThermalController({ warmupSeconds: 0 }, sampler, strategy, frameRateAction, undefined, () => 50);
        const cb = jest.fn();

        controller.onLevelChange(cb);
        controller.stepDown(); // Normal -> Hot
        controller.stepDown(); // Hot -> Emergency
        expect(cb).toHaveBeenLastCalledWith(ThermalLevel.Emergency);

        controller.restore(); // Emergency -> Normal
        expect(cb).toHaveBeenLastCalledWith(ThermalLevel.Normal);
    });

    test('pause 后 disable 再 enable，温控能恢复工作', () => {
        const sampler = makeSampler(20);
        const strategy = makeStrategy('DOWN');
        const frameRateAction = makeFrameRateAction(true);
        let now = 0;
        const controller = new ThermalController({ warmupSeconds: 0 }, sampler, strategy, frameRateAction, undefined, () => 50, () => now);

        controller.enable();
        controller.pause(); // _paused = true
        controller.disable(); // 复位 _paused
        controller.enable(); // 重新启用

        now = 2000; // 绕过节流
        fire();
        expect(strategy.update).toHaveBeenCalled(); // 判断执行，不被 _paused 挡住

        controller.disable();
    });

    test('warm-up 期间不动作；预热结束先清窗，下一次评估才动作', () => {
        let now = 0;
        const sampler = makeSampler(20);
        const strategy = makeStrategy('DOWN');
        const frameRateAction = makeFrameRateAction(true);
        const controller = new ThermalController({ warmupSeconds: 20 }, sampler, strategy, frameRateAction, undefined, () => 50, () => now);

        controller.enable();
        fire(); // t=0，预热中
        expect(frameRateAction.stepDown).not.toHaveBeenCalled();
        expect(sampler.reset).not.toHaveBeenCalled();

        now = 10000;
        fire(); // t=10s，仍在预热
        expect(frameRateAction.stepDown).not.toHaveBeenCalled();

        now = 20001;
        fire(); // 预热结束：清掉预热期样本（启动卡顿），本轮不动作
        expect(sampler.reset).toHaveBeenCalled();
        expect(strategy.update).not.toHaveBeenCalled();
        expect(frameRateAction.stepDown).not.toHaveBeenCalled();

        now = 22000;
        fire(); // 清窗后的第一次评估：用预热结束之后的帧决策（需跨过 1s 评估节流）
        expect(frameRateAction.stepDown).toHaveBeenCalledTimes(1);

        controller.disable();
    });

    test('setThreshold 非法值（0 / 200 / NaN）告警并忽略，合法值才透传', () => {
        const sampler = makeSampler(20);
        const strategy = makeStrategy('NONE');
        const frameRateAction = makeFrameRateAction();
        const controller = new ThermalController({ warmupSeconds: 0 }, sampler, strategy, frameRateAction, undefined, () => 50);
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => { /* silence */ });

        controller.setThreshold(0);
        controller.setThreshold(200);
        controller.setThreshold(NaN);
        expect(strategy.setThreshold).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledTimes(3);

        controller.setThreshold(25);
        expect(strategy.setThreshold).toHaveBeenCalledWith(25);

        warn.mockRestore();
    });

    test('setDowngradeOrder 运行时切换：下一次降档先降帧率（无需重建）', () => {
        const sampler = makeSampler(20);
        const strategy = makeStrategy('DOWN');
        const frameRateAction = makeFrameRateAction(true);
        const scaleAction = {
            stepDown: jest.fn(() => true),
            stepUp: jest.fn(() => true),
            restore: jest.fn(),
            isAtFloor: jest.fn(() => false),
            getCurrent: jest.fn(() => 1.0),
        };
        const controller = new ThermalController(
            { warmupSeconds: 0 }, sampler, strategy, frameRateAction, scaleAction, () => 50, () => 0,
        );
        controller.enable();

        controller.setDowngradeOrder('frameRate-first');
        fire();
        expect(frameRateAction.stepDown).toHaveBeenCalled();
        expect(scaleAction.stepDown).not.toHaveBeenCalled();

        controller.setDowngradeOrder('scale-first');
        controller.disable();
        expect(scaleAction.stepDown).not.toHaveBeenCalled();
    });

    test('setDowngradeOrder 非法值告警并忽略（不改变当前顺序）', () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => { /* silence */ });
        const sampler = makeSampler(20);
        const strategy = makeStrategy('DOWN');
        const frameRateAction = makeFrameRateAction(true);
        const scaleAction = {
            stepDown: jest.fn(() => true),
            stepUp: jest.fn(() => true),
            restore: jest.fn(),
            isAtFloor: jest.fn(() => false),
            getCurrent: jest.fn(() => 1.0),
        };
        const controller = new ThermalController(
            { warmupSeconds: 0 }, sampler, strategy, frameRateAction, scaleAction, () => 50, () => 0,
        );
        controller.enable();

        controller.setDowngradeOrder('frameRate_first' as unknown as 'scale-first');
        fire();
        expect(warn).toHaveBeenCalled();
        // 非法值被忽略 → 仍走默认 scale-first
        expect(scaleAction.stepDown).toHaveBeenCalled();
        expect(frameRateAction.stepDown).not.toHaveBeenCalled();

        controller.disable();
        warn.mockRestore();
    });

    test('升档失败后按指数退避锁定该杠杆，退避结束后才允许再试', () => {
        let now = 0;
        const sampler = makeSampler(20);
        const frameRateAction = makeFrameRateAction(true, true);
        const strategy = {
            update: jest.fn((): ThermalStrategyAction => {
                if (now === 0) return 'DOWN';
                if (now === 5000) return 'UP';
                if (now === 10000) return 'DOWN';
                if (now === 15000) return 'UP';
                if (now === 75000) return 'UP';
                return 'NONE';
            }),
            setThreshold: jest.fn(),
            setRecoverThreshold: jest.fn(),
            setRecoverWindowSeconds: jest.fn(),
            setCooldownSeconds: jest.fn(),
            reset: jest.fn(),
        };
        const controller = new ThermalController(
            { warmupSeconds: 0, recoveryProbeSeconds: 15, recoveryBackoffSeconds: 60 },
            sampler, strategy, frameRateAction, undefined, () => 50, () => now,
        );

        controller.enable();
        fire(); // DOWN
        expect(frameRateAction.stepDown).toHaveBeenCalledTimes(1);

        now = 5000;
        fire(); // UP，进入试验期
        expect(frameRateAction.stepUp).toHaveBeenCalledTimes(1);

        now = 10000;
        fire(); // 试验期内又 DOWN，判定升档失败并锁定 60s
        expect(frameRateAction.stepDown).toHaveBeenCalledTimes(2);

        now = 15000;
        fire(); // 仍在退避期，UP 被拦截
        expect(frameRateAction.stepUp).toHaveBeenCalledTimes(1);

        now = 75000;
        fire(); // 退避结束，允许再试
        expect(frameRateAction.stepUp).toHaveBeenCalledTimes(2);

        controller.disable();
    });

    test('分辨率降档无效时切换到帧率，避免一路降到地板', () => {
        let now = 0;
        const sampler = makeSampler(20);
        const frameRateAction = makeFrameRateAction(true, true);
        const scaleAction = {
            stepDown: jest.fn(() => true),
            stepUp: jest.fn(() => true),
            restore: jest.fn(),
            isAtFloor: jest.fn(() => false),
            getCurrent: jest.fn(() => 1.0),
        };
        const strategy = {
            update: jest.fn((): ThermalStrategyAction => {
                if (now === 0) return 'DOWN';
                if (now === 5000) return 'DOWN';
                return 'NONE';
            }),
            setThreshold: jest.fn(),
            setRecoverThreshold: jest.fn(),
            setRecoverWindowSeconds: jest.fn(),
            setCooldownSeconds: jest.fn(),
            reset: jest.fn(),
        };
        const controller = new ThermalController(
            { warmupSeconds: 0, scaleEffectCheck: true, scaleEffectProbeSeconds: 5, scaleEffectMinImprovementPercent: 5, scaleIneffectiveSeconds: 60 },
            sampler, strategy, frameRateAction, scaleAction, () => 50, () => now,
        );

        controller.enable();
        fire(); // 第一次 DOWN：先降分辨率
        expect(scaleAction.stepDown).toHaveBeenCalledTimes(1);
        expect(frameRateAction.stepDown).not.toHaveBeenCalled();

        now = 5000;
        fire(); // 5s 后帧时间没有改善：分辨率被判无效，下一次 DOWN 直接降帧率
        expect(scaleAction.stepDown).toHaveBeenCalledTimes(1);
        expect(frameRateAction.stepDown).toHaveBeenCalledTimes(1);

        controller.disable();
    });

    test('resume 丢弃暂停前的窗口并重新预热（预热长度对齐采样窗 20s）', () => {
        let now = 0;
        const sampler = makeSampler(20);
        const strategy = makeStrategy('DOWN');
        const frameRateAction = makeFrameRateAction(true);
        const controller = new ThermalController({ warmupSeconds: 20 }, sampler, strategy, frameRateAction, undefined, () => 50, () => now);

        controller.enable();
        controller.pause();
        now = 10000;
        controller.resume();
        expect(sampler.reset).toHaveBeenCalled();

        fire(); // 仍被节流/预热挡住
        expect(frameRateAction.stepDown).not.toHaveBeenCalled();

        now = 12000;
        fire(); // 预热中
        expect(frameRateAction.stepDown).not.toHaveBeenCalled();

        now = 25000;
        fire(); // 仍在预热窗内：10s 恢复 + 20s 窗口 = 30s 才结束
        expect(frameRateAction.stepDown).not.toHaveBeenCalled();

        now = 31000;
        fire(); // 预热结束：清窗，本轮不动作
        expect(frameRateAction.stepDown).not.toHaveBeenCalled();

        now = 32000;
        fire(); // 清窗后的第一次评估才动作
        expect(frameRateAction.stepDown).toHaveBeenCalledTimes(1);

        controller.disable();
    });

    test('集成：真实策略 + 60/30 限帧特征，60 分钟内振荡被压到个位数量级', () => {
        let now = 0;
        let fps = 60;
        const config = {
            warmupSeconds: 0,
            recoveryProbeSeconds: 15,
            recoveryBackoffSeconds: 60,
            recoveryBackoffMaxSeconds: 600,
            triggerPercent: 15,
            recoverPercent: 8,
            recoverWindowSeconds: 5,
            cooldownSeconds: 5,
        };
        const sampler = {
            start: jest.fn(),
            stop: jest.fn(),
            reset: jest.fn(),
            // 第三轮实测特征：60 cap 段约 28.2ms，30 cap 段约 31.2ms。
            getAverageFrameTimeMs: jest.fn(() => (fps === 30 ? 31.2 : 28.2)),
        };
        const frameRateAction = {
            stepDown: jest.fn(() => {
                if (fps === 30) return false;
                fps = 30;
                return true;
            }),
            stepUp: jest.fn(() => {
                if (fps === 60) return false;
                fps = 60;
                return true;
            }),
            restore: jest.fn(() => { fps = 60; }),
            isAtFloor: jest.fn(() => fps === 30),
            getCurrent: jest.fn(() => fps),
        };
        const strategy = new ThermalStrategy(config, () => now);
        const controller = new ThermalController(
            config, sampler, strategy, frameRateAction, undefined, () => fps, () => now,
        );

        controller.enable();
        for (let t = 0; t <= 3600; t += 1) {
            now = t;
            fire();
        }

        const transitions = frameRateAction.stepDown.mock.calls.length + frameRateAction.stepUp.mock.calls.length;
        // 旧逻辑按 15s 一个周期会到 ~480 次；新逻辑应远低于 40 次。
        expect(transitions).toBeLessThan(40);
        // 最终应稳定在 30fps（设备在该温度下跑不满 60）。
        expect(fps).toBe(30);

        controller.disable();
    });

    test('默认 -10% 升档阈值：30fps 限帧下自动只降不升', () => {
        let now = 0;
        let fps = 60;
        const config = {
            warmupSeconds: 0,
            triggerPercent: 10,
            recoverPercent: -10,
            cooldownSeconds: 10,
            logActions: false,
        };
        const sampler = {
            start: jest.fn(),
            stop: jest.fn(),
            reset: jest.fn(),
            getAverageFrameTimeMs: jest.fn(() => (fps === 30 ? 31.2 : 28.2)),
        };
        const frameRateAction = {
            stepDown: jest.fn(() => {
                if (fps === 30) return false;
                fps = 30;
                return true;
            }),
            stepUp: jest.fn(() => {
                if (fps === 60) return false;
                fps = 60;
                return true;
            }),
            restore: jest.fn(() => { fps = 60; }),
            isAtFloor: jest.fn(() => fps === 30),
            getCurrent: jest.fn(() => fps),
        };
        const strategy = new ThermalStrategy(config, () => now);
        const controller = new ThermalController(config, sampler, strategy, frameRateAction, undefined, () => fps, () => now);

        controller.enable();
        for (let t = 0; t <= 600; t += 1) {
            now = t;
            fire();
        }

        expect(frameRateAction.stepDown).toHaveBeenCalledTimes(1);
        expect(frameRateAction.stepUp).not.toHaveBeenCalled();
        expect(fps).toBe(30);

        controller.disable();
    });

    test('升降档触发 onAction，带方向/杠杆/前后值/原因', () => {
        let fps = 60;
        const frameRateAction = {
            stepDown: jest.fn(() => { fps = 30; return true; }),
            stepUp: jest.fn(() => { fps = 60; return true; }),
            restore: jest.fn(() => { fps = 60; }),
            isAtFloor: jest.fn(() => fps === 30),
            getCurrent: jest.fn(() => fps),
        };
        const controller = new ThermalController(
            { warmupSeconds: 0, logActions: false },
            makeSampler(20), makeStrategy('NONE'), frameRateAction, undefined, () => fps,
        );
        const events: unknown[] = [];
        controller.onAction((e) => events.push(e));

        controller.stepDown();
        controller.stepUp();

        expect(events).toHaveLength(2);
        expect(events[0]).toMatchObject({ direction: 'DOWN', lever: 'frameRate', from: 60, to: 30, reason: 'manual' });
        expect(events[1]).toMatchObject({ direction: 'UP', lever: 'frameRate', from: 30, to: 60, reason: 'manual' });

        controller.disable();
    });

    test('getState 暴露当前帧率与分辨率档位', () => {
        const scaleAction = {
            stepDown: jest.fn(() => true),
            stepUp: jest.fn(() => true),
            restore: jest.fn(),
            isAtFloor: jest.fn(() => false),
            getCurrent: jest.fn(() => 0.85),
        };
        const controller = new ThermalController(
            { warmupSeconds: 0, logActions: false },
            makeSampler(20), makeStrategy('NONE'), makeFrameRateAction(), scaleAction, () => 50,
        );

        controller.enable();
        expect(controller.getState()).toMatchObject({
            level: ThermalLevel.Normal,
            frameRate: 60,
            shadingScale: 0.85,
            enabled: true,
            paused: false,
        });
        controller.disable();
    });

    test('降档时打印 console 日志', () => {
        const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
        let fps = 60;
        const frameRateAction = {
            stepDown: jest.fn(() => { fps = 30; return true; }),
            stepUp: jest.fn(() => { fps = 60; return true; }),
            restore: jest.fn(() => { fps = 60; }),
            isAtFloor: jest.fn(() => fps === 30),
            getCurrent: jest.fn(() => fps),
        };
        const controller = new ThermalController(
            { warmupSeconds: 0 },
            makeSampler(20), makeStrategy('NONE'), frameRateAction, undefined, () => fps,
        );

        try {
            controller.stepDown();
            expect(spy).toHaveBeenCalledWith(expect.stringContaining('[Thermal] DOWN frameRate 60 -> 30'));
        } finally {
            spy.mockRestore();
            controller.disable();
        }
    });

    // ==================== 自动试探升档（probe-based recovery） ====================

    test('降档后到 probeIntervalSeconds 自动触发 scale-first 试探升档', () => {
        let now = 0;
        const sampler = makeSampler(20);
        // 第一帧 DOWN 触发降档，之后 NONE（负载平稳）
        const strategy = {
            update: jest.fn((): ThermalStrategyAction => (now === 0 ? 'DOWN' : 'NONE')),
            setThreshold: jest.fn(),
            setRecoverThreshold: jest.fn(),
            setRecoverWindowSeconds: jest.fn(),
            setCooldownSeconds: jest.fn(),
            reset: jest.fn(),
        };
        // scale 和 frameRate 都从非顶开始（模拟已降档到 scale=0.3、frameRate=30）
        const scaleAction = {
            stepDown: jest.fn(() => false),
            stepUp: jest.fn(() => true),
            restore: jest.fn(),
            isAtFloor: jest.fn(() => false),
            getCurrent: jest.fn(() => 0.3),
        };
        const frameRateAction = {
            stepDown: jest.fn(() => false),
            stepUp: jest.fn(() => true),
            restore: jest.fn(),
            isAtFloor: jest.fn(() => false),
            getCurrent: jest.fn(() => 30),
        };
        const controller = new ThermalController(
            { warmupSeconds: 0, enableAutoUpgrade: true, probeIntervalSeconds: 60, recoveryProbeSeconds: 15, logActions: false },
            sampler, strategy, frameRateAction, scaleAction, () => 60, () => now,
        );

        controller.enable();
        fire(); // t=0：DOWN → 降档，调度下次试探
        expect(frameRateAction.stepDown).toHaveBeenCalled(); // 通用降档 scale-first：scale 到底后降帧率（此处 scale 已到底）
        expect(scaleAction.stepUp).not.toHaveBeenCalled();   // 还没到试探时间

        now = 59000;
        fire(); // 未到 60s，不试探
        expect(scaleAction.stepUp).not.toHaveBeenCalled();

        now = 60000;
        fire(); // 到 60s：自动试探，scale-first → 先升 scale
        expect(scaleAction.stepUp).toHaveBeenCalledTimes(1);
        expect(frameRateAction.stepUp).not.toHaveBeenCalled(); // scale 先动，帧率还没升

        controller.disable();
    });

    test('自动试探成功观察期满后立即继续下一档（不等 probeIntervalSeconds）', () => {
        let now = 0;
        const sampler = makeSampler(20);
        const strategy = {
            update: jest.fn((): ThermalStrategyAction => (now === 0 ? 'DOWN' : 'NONE')),
            setThreshold: jest.fn(),
            setRecoverThreshold: jest.fn(),
            setRecoverWindowSeconds: jest.fn(),
            setCooldownSeconds: jest.fn(),
            reset: jest.fn(),
        };
        // scale 升到顶返回 false，逼第二次试探去升帧率
        let scale = 0.7;
        const scaleAction = {
            stepDown: jest.fn(() => false),
            stepUp: jest.fn(() => { if (scale >= 1.0) return false; scale = 1.0; return true; }),
            restore: jest.fn(),
            isAtFloor: jest.fn(() => false),
            getCurrent: jest.fn(() => scale),
        };
        let fps = 30;
        const frameRateAction = {
            stepDown: jest.fn(() => false),
            stepUp: jest.fn(() => { if (fps >= 60) return false; fps = 60; return true; }),
            restore: jest.fn(),
            isAtFloor: jest.fn(() => false),
            getCurrent: jest.fn(() => fps),
        };
        const controller = new ThermalController(
            { warmupSeconds: 0, enableAutoUpgrade: true, probeIntervalSeconds: 60, recoveryProbeSeconds: 15, logActions: false },
            sampler, strategy, frameRateAction, scaleAction, () => 60, () => now,
        );

        controller.enable();
        fire(); // t=0：DOWN → 降档，调度试探

        now = 60000;
        fire(); // 到点：自动试探升 scale 0.7→1.0（成功）
        expect(scaleAction.stepUp).toHaveBeenCalledTimes(1);

        // 观察 15s 内不降档 → 成功，立即继续（_nextAutoProbeAt = now）
        now = 61000;
        fire(); // 观察期未满（只过 1s），不动
        expect(frameRateAction.stepUp).not.toHaveBeenCalled();

        now = 76000; // 60000 + 16000 > 15000 观察期满
        fire(); // _updateRecoveryProbe 判定成功 → _nextAutoProbeAt = now → 同帧 _maybeAutoProbe 立即升帧率
        expect(frameRateAction.stepUp).toHaveBeenCalledTimes(1); // scale 已满（1.0），继续升帧率

        controller.disable();
    });

    test('观察期内又降档定向撤销刚升的杠杆（而非通用 scale-first 降档）', () => {
        let now = 0;
        let scale = 1.0;
        let fps = 30;
        const sampler = makeSampler(20);
        // t=5000 触发一次 DOWN（观察期内），其余 NONE
        const strategy = {
            update: jest.fn((): ThermalStrategyAction => (now === 5000 ? 'DOWN' : 'NONE')),
            setThreshold: jest.fn(),
            setRecoverThreshold: jest.fn(),
            setRecoverWindowSeconds: jest.fn(),
            setCooldownSeconds: jest.fn(),
            reset: jest.fn(),
        };
        // scale 已满（1.0）：stepUp 升不动，stepDown 能降（若走通用降档会降到 0.85）
        const scaleAction = {
            stepDown: jest.fn(() => { if (scale <= 0.3) return false; scale = 0.85; return true; }),
            stepUp: jest.fn(() => false),
            restore: jest.fn(),
            isAtFloor: jest.fn(() => scale <= 0.3),
            getCurrent: jest.fn(() => scale),
        };
        const frameRateAction = {
            stepDown: jest.fn(() => { if (fps <= 30) return false; fps = 30; return true; }),
            stepUp: jest.fn(() => { if (fps >= 60) return false; fps = 60; return true; }),
            restore: jest.fn(),
            isAtFloor: jest.fn(() => fps <= 30),
            getCurrent: jest.fn(() => fps),
        };
        const controller = new ThermalController(
            { warmupSeconds: 0, recoveryProbeSeconds: 15, logActions: false },
            sampler, strategy, frameRateAction, scaleAction, () => 60, () => now,
        );

        controller.enable();

        // 手动升档：frameRate-first → 升帧率 30→60，进入观察期（_upProbeLever='frameRate'）
        controller.stepUp();
        expect(fps).toBe(60);
        expect(scale).toBe(1.0);

        now = 5000; // 观察期内（< 15s）
        fire();      // strategy 返回 DOWN → 应定向撤销帧率 60→30，而非通用 scale-first 降 scale
        expect(fps).toBe(30);       // 帧率被撤销回 30
        expect(scale).toBe(1.0);    // scale 保持 1.0（若走通用降档会降到 0.85）

        controller.disable();
    });

    test('手动 stepUp 保持 frameRate-first（不因自动试探逻辑变序）', () => {
        let now = 0;
        let fps = 30;
        let scale = 0.7;
        const frameRateAction = {
            stepDown: jest.fn(() => false),
            stepUp: jest.fn(() => { if (fps >= 60) return false; fps = 60; return true; }),
            restore: jest.fn(),
            isAtFloor: jest.fn(() => fps === 30),
            getCurrent: jest.fn(() => fps),
        };
        const scaleAction = {
            stepDown: jest.fn(() => false),
            stepUp: jest.fn(() => { if (scale >= 1.0) return false; scale = 1.0; return true; }),
            restore: jest.fn(),
            isAtFloor: jest.fn(() => false),
            getCurrent: jest.fn(() => scale),
        };
        const controller = new ThermalController(
            { warmupSeconds: 0, logActions: false },
            makeSampler(20), makeStrategy('NONE'), frameRateAction, scaleAction, () => 60, () => now,
        );

        controller.stepUp(); // 手动升档：frameRate-first → 先升帧率 30→60
        expect(frameRateAction.stepUp).toHaveBeenCalledTimes(1);
        expect(scaleAction.stepUp).not.toHaveBeenCalled(); // 帧率先动，scale 还没轮到

        controller.disable();
    });
});

describe('按杠杆隔离（A/B 实验用）', () => {
    // 杠杆用真实的最小替身：记录当前档位与降了几档，够验证"哪个杠杆动了"
    const makeLever = (levels: number[]) => {
        let i = 0;
        let enabled = true;
        return {
            stepDown: () => { if (!enabled) return false; if (i >= levels.length - 1) return false; i++; return true; },
            stepUp: () => { if (i <= 0) return false; i--; return true; },
            restore: () => { i = 0; },
            isAtFloor: () => i >= levels.length - 1,
            getCurrent: () => levels[i],
            getStepsDown: () => i,
            setEnabled: (v: boolean) => { enabled = v; if (!v) { i = 0; } },
            isEnabled: () => enabled,
        };
    };
    const sampler = () => ({
        start: () => { /* noop */ }, stop: () => { /* noop */ }, reset: () => { /* noop */ },
        getAverageFrameTimeMs: () => 20, getSampleCount: () => 100,
    });
    const strategy = () => ({
        update: () => 'NONE', setThreshold: () => { /* noop */ }, setRecoverThreshold: () => { /* noop */ },
        setRecoverWindowSeconds: () => { /* noop */ }, setCooldownSeconds: () => { /* noop */ }, reset: () => { /* noop */ },
    });


    test('setScaleTiers 换梯度：杠杆回到最高档、新梯度生效', () => {
        // 用真实 ScaleAction，才验证得了 buildLevels 的重建。
        // 读写都要接同一个可变值：ScaleAction 每次决策前会 _syncCurrent() 读实时值，
        // 用 () => 1 会把刚写下的档位又"读"回 1。
        let current = 1;
        const scale = new ScaleAction(0.6, [0.85, 0.7], () => current, (v: number) => { current = v; });
        const fps = makeLever([60, 30]);
        const c = new ThermalController({ warmupSeconds: 0 }, sampler(), strategy(), fps, scale, () => 1) as any;
        c.enable();

        c.stepDown();                       // 0.85
        expect(scale.getCurrent()).toBeCloseTo(0.85, 5);

        c.setScaleTiers([0.9, 0.8, 0.7]);   // 换梯度
        expect(scale.getCurrent()).toBeCloseTo(1.0, 5);   // 回到最高档
        expect(scale.getTiers()).toEqual([0.9, 0.8, 0.7]);

        c.stepDown();
        expect(scale.getCurrent()).toBeCloseTo(0.9, 5);   // 第一步走新梯度
    });




    test('降到底仍超预算时，自动升档仍会按 probeInterval 触发（回归）', () => {
        // 真机现象（GB3）：30.8ms vs 目标 16.67ms，策略每秒判 DOWN，
        // 但两个杠杆都已到底 —— 旧实现每次 DOWN 都把 _nextAutoProbeAt 重置成 now+60s，
        // 自动升档永远触发不了，分辨率一直停在 0.70。
        let now = 0;
        // 读写都接同一个可变值：ScaleAction 每次决策前会 _syncCurrent() 读实时值，
        // 用 () => 1 会把刚写下的档位又读回 1。
        let cur = 1;
        const scale = new ScaleAction(0.7, [0.85, 0.7], () => cur, (v: number) => { cur = v; });
        const fps = makeLever([60, 30]);
        fps.stepDown = () => false;   // 模拟"只勾分辨率"：帧率杠杆动不了
        const c = new ThermalController(
            { warmupSeconds: 0, enableAutoUpgrade: true, probeIntervalSeconds: 60, recoveryProbeSeconds: 5, triggerPercent: 10, cooldownSeconds: 0 },
            { start: () => { /* noop */ }, stop: () => { /* noop */ }, reset: () => { /* noop */ },
              getAverageFrameTimeMs: () => 30.8, getSampleCount: () => 100 },
            { update: () => 'DOWN', setThreshold: () => { /* noop */ }, setRecoverThreshold: () => { /* noop */ },
              setRecoverWindowSeconds: () => { /* noop */ }, setCooldownSeconds: () => { /* noop */ }, reset: () => { /* noop */ } },
            fps, scale, () => 1, () => now,
        ) as any;
        c.enable();
        c.stepDown(); c.stepDown();          // 手动降到底
        expect(scale.getCurrent()).toBe(0.7);

        let probed = false;
        for (let k = 0; k < 200; k++) {
            now += 1000;
            c._evaluate();
            if (scale.getCurrent() > 0.7) { probed = true; break; }
        }
        expect(probed).toBe(true);
    });

    test('setFrameRateEnabled(false) 后只动分辨率杠杆（帧率保持 60）', () => {
        const scale = makeLever([1, 0.85, 0.7]);
        const fps = makeLever([60, 30]);
        const c = new ThermalController({ warmupSeconds: 0 }, sampler(), strategy(), fps, scale, () => 1) as any;
        c.enable();

        c.setFrameRateEnabled(false);
        expect(c.isFrameRateEnabled()).toBe(false);

        c.stepDown();
        c.stepDown();
        expect(fps.getCurrent()).toBe(60);        // 帧率杠杆被禁用
        expect(scale.getCurrent()).toBeLessThan(1); // 分辨率动了
    });


    test('setFrameRateEnabled(false) 后升档也只动分辨率（升降对称）', () => {
        const scale = makeLever([1, 0.85, 0.7]);
        const fps = makeLever([60, 30]);
        const c = new ThermalController({ warmupSeconds: 0 }, sampler(), strategy(), fps, scale, () => 1) as any;
        c.enable();

        c.setFrameRateEnabled(false);
        c.stepDown();   // 只降分辨率
        c.stepDown();   // 0.70
        expect(scale.getCurrent()).toBe(0.7);
        expect(fps.getCurrent()).toBe(60);

        // 手动升档（frameRate-first）：帧率杠杆被禁用，只能回升分辨率
        expect(c.stepUp()).toBe(true);
        expect(fps.getCurrent()).toBe(60);     // ★ 帧率没被升
        expect(scale.getCurrent()).toBe(0.85); // 分辨率回来了
    });

    test('setScaleEnabled(false) 后只动帧率杠杆（分辨率保持 1.00）', () => {
        const scale = makeLever([1, 0.85, 0.7]);
        const fps = makeLever([60, 30]);
        const c = new ThermalController({ warmupSeconds: 0 }, sampler(), strategy(), fps, scale, () => 1) as any;
        c.enable();

        c.setScaleEnabled(false);
        c.stepDown();
        expect(scale.getCurrent()).toBe(1);
        expect(fps.getCurrent()).toBe(30);
    });
});
