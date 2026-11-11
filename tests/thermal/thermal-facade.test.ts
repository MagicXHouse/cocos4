import { Thermal } from '../../cocos/thermal/thermal';
import { FrameRateAction } from '../../cocos/thermal/actions/frame-rate-action';
import { ScaleAction } from '../../cocos/thermal/actions/scale-action';
import { ThermalStrategy } from '../../cocos/thermal/thermal-strategy';
import * as controllerModule from '../../cocos/thermal/thermal-controller';

jest.mock('../../cocos/thermal/fsr', () => ({ ThermalFsr: jest.fn().mockImplementation(() => ({ setMaterial: jest.fn() })) }));
jest.mock('../../cocos/thermal/frame-time-sampler', () => ({ FrameTimeSampler: jest.fn() }));
jest.mock('../../cocos/thermal/thermal-strategy', () => ({ ThermalStrategy: jest.fn() }));
jest.mock('../../cocos/thermal/actions/frame-rate-action', () => ({ FrameRateAction: jest.fn() }));
jest.mock('../../cocos/thermal/actions/scale-action', () => ({ ScaleAction: jest.fn() }));
jest.mock('../../cocos/thermal/thermal-controller', () => {
    const instances: unknown[] = [];
    return {
        ThermalController: jest.fn().mockImplementation(() => {
            const instance = {
                enable: jest.fn(),
                disable: jest.fn(),
                onLevelChange: jest.fn(),
                onAction: jest.fn(),
                getState: jest.fn(() => ({
                    level: 0,
                    frameRate: 60,
                    shadingScale: 1.0,
                    enabled: true,
                    paused: false,
                })),
                getFrameRate: jest.fn(() => 60),
                getShadingScale: jest.fn(() => 1.0),
                setThreshold: jest.fn(),
                setDowngradeOrder: jest.fn(),
                reset: jest.fn(),
                getLevel: jest.fn(() => 0),
                stepDown: jest.fn(() => true),
                stepUp: jest.fn(() => true),
                restore: jest.fn(),
                pause: jest.fn(),
                resume: jest.fn(),
            };
            instances.push(instance);
            return instance;
        }),
        __instances: instances,
    };
});

interface MockControllerInstance {
    onLevelChange: jest.Mock;
    onAction: jest.Mock;
    getState: jest.Mock;
}

function getInstances (): MockControllerInstance[] {
    return (controllerModule as unknown as { __instances: MockControllerInstance[] }).__instances;
}

describe('Thermal facade', () => {
    beforeEach(() => {
        getInstances().length = 0;
    });

    test('enable 之前注册的 onLevelChange 会在 enable 后挂到 controller 上', () => {
        const facade = new Thermal();
        const cb = jest.fn();

        facade.onLevelChange(cb);
        facade.enable();

        const instances = getInstances();
        expect(instances.length).toBe(1);
        expect(instances[0].onLevelChange).toHaveBeenCalledWith(cb);
    });

    test('disable 后重新 enable 会重新挂上回调', () => {
        const facade = new Thermal();
        const cb = jest.fn();

        facade.onLevelChange(cb);
        facade.enable();
        facade.disable();
        facade.enable();

        const instances = getInstances();
        expect(instances.length).toBe(1);
        expect(instances[0].onLevelChange).toHaveBeenCalledTimes(2);
    });

    test('enable 之前注册的 onAction 会在 enable 后挂到 controller 上', () => {
        const facade = new Thermal();
        const cb = jest.fn();

        facade.onAction(cb);
        facade.enable();

        const instances = getInstances();
        expect(instances.length).toBe(1);
        expect(instances[0].onAction).toHaveBeenCalledWith(cb);
    });

    test('E05：minFrameRate=60 视为"钉住帧率"，不告警、不回落', () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => { /* silence */ });
        const facade = new Thermal();
        facade.enable({ minFrameRate: 60 });

        // 传的是 60 而不是 30：buildLevels(60,[60,30],60) → [60]，帧率杠杆自然 no-op
        expect(FrameRateAction).toHaveBeenCalledWith(60, [60, 30]);
        expect(warn).not.toHaveBeenCalled();
        warn.mockRestore();
    });

    test('E05：minFrameRate=45 不在预设内，回落 30 并告警', () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => { /* silence */ });
        const facade = new Thermal();
        facade.enable({ minFrameRate: 45 });

        // 帧率档固定 [60, 30]，地板回落 30（45 在 60Hz 下会 judder）
        expect(FrameRateAction).toHaveBeenCalledWith(30, [60, 30]);
        expect(warn).toHaveBeenCalled();
        warn.mockRestore();
    });

    test('E09：minScale=0 非法（会产出 scale=0 档），回落 0.7 并告警', () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => { /* silence */ });
        const facade = new Thermal();
        facade.enable({ minScale: 0 });

        expect(ScaleAction).toHaveBeenCalledWith(0.7, undefined, undefined, undefined, expect.anything());
        expect(warn).toHaveBeenCalled();
        warn.mockRestore();
    });

    test('E09：minScale=1.5（地板高于原值）收敛到 1（等于不降分辨率）并告警', () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => { /* silence */ });
        const facade = new Thermal();
        facade.enable({ minScale: 1.5 });

        expect(ScaleAction).toHaveBeenCalledWith(1, undefined, undefined, undefined, expect.anything());
        expect(warn).toHaveBeenCalled();
        warn.mockRestore();
    });

    test('E08：triggerPercent 越界（0 / 200 / NaN）回落 10 并告警', () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => { /* silence */ });
        const strategyMock = ThermalStrategy as unknown as jest.Mock;
        for (const bad of [0, 200, NaN]) {
            strategyMock.mockClear();
            const facade = new Thermal();
            facade.enable({ triggerPercent: bad });
            expect(strategyMock.mock.calls[0][0].triggerPercent).toBe(10);
        }
        expect(warn).toHaveBeenCalledTimes(3);
        warn.mockRestore();
    });

    test('E08：triggerPercent 合法值（1 / 25 / 100）原样传给策略', () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => { /* silence */ });
        const strategyMock = ThermalStrategy as unknown as jest.Mock;
        for (const good of [1, 25, 100]) {
            strategyMock.mockClear();
            const facade = new Thermal();
            facade.enable({ triggerPercent: good });
            expect(strategyMock.mock.calls[0][0].triggerPercent).toBe(good);
        }
        expect(warn).not.toHaveBeenCalled();
        warn.mockRestore();
    });

    test('setDowngradeOrder 委托给 controller；非法值告警并忽略', () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => { /* silence */ });
        const facade = new Thermal();
        facade.enable();
        const inst = getInstances()[0] as unknown as { setDowngradeOrder: jest.Mock };

        facade.setDowngradeOrder('frameRate-first');
        expect(inst.setDowngradeOrder).toHaveBeenCalledWith('frameRate-first');

        facade.setDowngradeOrder('frameRate_first' as unknown as 'scale-first');
        expect(inst.setDowngradeOrder).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalled();
        warn.mockRestore();
    });

    test('getState 委托给 controller', () => {
        const facade = new Thermal();
        facade.enable();

        const state = facade.getState();
        expect(state.frameRate).toBe(60);
        expect(state.shadingScale).toBe(1.0);
        expect(state.enabled).toBe(true);
    });
});

