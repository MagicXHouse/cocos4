import { cclegacy } from '../../cocos/core';
import { ScaleAction } from '../../cocos/thermal/actions/scale-action';

describe('ScaleAction', () => {
    test('档位序列：1.0 -> 0.85 -> 0.7 -> 0.6 一档档降', () => {
        let current = 1.0;
        const written: number[] = [];
        const action = new ScaleAction(0.6, [0.85, 0.7], () => current, (s) => { current = s; written.push(s); });

        expect(action.stepDown()).toBe(true); // 1.0 -> 0.85
        expect(written).toEqual([0.85]);
        expect(action.stepDown()).toBe(true); // 0.85 -> 0.7
        expect(action.stepDown()).toBe(true); // 0.7 -> 0.6
        expect(action.stepDown()).toBe(false); // 到底
        expect(action.isAtFloor()).toBe(true);
    });

    test('stepUp 一档档升，回原值封顶', () => {
        let current = 1.0;
        const action = new ScaleAction(0.6, [0.85, 0.7], () => current, (s) => { current = s; });

        action.stepDown(); // 0.85
        action.stepDown(); // 0.7
        expect(action.stepUp()).toBe(true); // 0.7 -> 0.85
        expect(action.stepUp()).toBe(true); // 0.85 -> 1.0
        expect(action.stepUp()).toBe(false); // 到顶
        expect(current).toBeCloseTo(1.0, 10);
    });

    test('restore 还原到原值', () => {
        let current = 1.0;
        const action = new ScaleAction(0.6, [0.85, 0.7], () => current, (s) => { current = s; });

        action.stepDown();
        action.stepDown();
        expect(current).toBeCloseTo(0.7, 10);
        action.restore();
        expect(current).toBeCloseTo(1.0, 10);
    });

    test('E02：外部改了 shadingScale 后，stepDown 以实时值为准（不会把 0.3 写成 0.85）', () => {
        let current = 1.0;
        const action = new ScaleAction(0.3, [0.85, 0.7], () => current, (s) => { current = s; });

        // 外部（DRS 循环 / 手动 setScale）把它直接拍到地板
        current = 0.3;
        expect(action.stepDown()).toBe(false);      // 已经在地板，不能"降"成 0.85
        expect(current).toBeCloseTo(0.3, 10);
        expect(action.getStepsDown()).toBe(3);

        // 外部改成表外值 0.5：下一档应当是 0.3
        current = 0.5;
        expect(action.stepDown()).toBe(true);
        expect(current).toBeCloseTo(0.3, 10);
    });

    test('N1：外部写入超采样 2.0 时，第一档降回表内 top 档 1.0（不能跳过它）', () => {
        let current = 1.0;
        const action = new ScaleAction(0.3, [0.85, 0.7], () => current, (s) => { current = s; });

        current = 2.0;                              // 交接文档里的 A/B 用 setScale(2.0) 超采样
        expect(action.stepDown()).toBe(true);
        expect(current).toBeCloseTo(1.0, 10);       // 期望 1.0，而不是一步跳到 0.85

        expect(action.stepDown()).toBe(true);
        expect(current).toBeCloseTo(0.85, 10);
    });

    test('E01：getStepsDown 反映实际档位（外部还原后归零）', () => {
        let current = 1.0;
        const action = new ScaleAction(0.3, [0.85, 0.7], () => current, (s) => { current = s; });

        expect(action.getStepsDown()).toBe(0);
        action.stepDown();
        expect(action.getStepsDown()).toBe(1);
        action.stepDown();
        expect(action.getStepsDown()).toBe(2);

        current = 1.0;                              // 外部还原（或 setScaleEnabled(false) 内部 restore）
        expect(action.getStepsDown()).toBe(0);
    });

    test('原值不在标准档位（如 0.9）动态生成阶梯', () => {
        let current = 0.9;
        const written: number[] = [];
        const action = new ScaleAction(0.6, [0.85, 0.7], () => current, (s) => { current = s; written.push(s); });

        expect(action.stepDown()).toBe(true); // 0.9 -> 0.85
        expect(action.stepDown()).toBe(true); // 0.85 -> 0.7
        expect(action.stepDown()).toBe(true); // 0.7 -> 0.6
        expect(action.stepDown()).toBe(false);
        expect(written).toEqual([0.85, 0.7, 0.6]);
        action.restore();
        expect(current).toBeCloseTo(0.9, 10);
    });

    test('原值低于地板时不降也不升', () => {
        let current = 0.5;
        const action = new ScaleAction(0.6, [0.85, 0.7], () => current, (s) => { current = s; });

        expect(action.isAtFloor()).toBe(true);
        expect(action.stepDown()).toBe(false);
        expect(action.stepUp()).toBe(false);
        expect(current).toBe(0.5);
    });

    test('scale 变化时 apply FSR，restore 时恢复', () => {
        let current = 1.0;
        const fsr = { apply: jest.fn(), restore: jest.fn() };
        const action = new ScaleAction(0.3, [0.85, 0.7], () => current, (s) => { current = s; }, fsr);

        action.stepDown(); // 1.0 -> 0.85
        expect(fsr.apply).toHaveBeenLastCalledWith(0.85);
        action.stepUp(); // 0.85 -> 1.0
        expect(fsr.apply).toHaveBeenLastCalledWith(1.0);

        action.stepDown();
        action.restore();
        expect(fsr.restore).toHaveBeenCalled();
    });

    test('setEnabled(false) 还原并停止降/升，重新启用后恢复', () => {
        let current = 1.0;
        const action = new ScaleAction(0.6, [0.85, 0.7], () => current, (s) => { current = s; });

        expect(action.stepDown()).toBe(true); // 1.0 -> 0.85
        expect(current).toBeCloseTo(0.85, 10);

        action.setEnabled(false);
        expect(action.isEnabled()).toBe(false);
        expect(current).toBeCloseTo(1.0, 10); // 禁用时还原
        expect(action.stepDown()).toBe(false);
        expect(action.stepUp()).toBe(false);
        expect(current).toBeCloseTo(1.0, 10);

        action.setEnabled(true);
        expect(action.isEnabled()).toBe(true);
        expect(action.stepDown()).toBe(true);
        expect(current).toBeCloseTo(0.85, 10);
    });

    test('defaultWriteScale 触发 forceResizeAllWindows', () => {
        const forceResize = jest.fn();
        // cclegacy.rendering 是运行时挂载的，测试环境手动挂一个假的计数
        const originalRendering = (cclegacy as any).rendering;
        (cclegacy as any).rendering = { forceResizeAllWindows: forceResize };
        // readScale 注入假值，writeScale 用默认（内部会调 forceResizeAllWindows）
        const action = new ScaleAction(0.6, [0.85, 0.7], () => 1.0);
        action.stepDown(); // 1.0 -> 0.85
        expect(forceResize).toHaveBeenCalled();
        (cclegacy as any).rendering = originalRendering; // 恢复
    });

    test('isFsrStateChanging：跨过 FSR 阈值的那一步返回 true', () => {
        let current = 1.0;
        const fsr = {
            apply: jest.fn(),
            restore: jest.fn(),
            wouldEnableAt: (s: number) => s < 1 && s <= 0.7,
        };
        const action = new ScaleAction(0.3, [0.85, 0.7], () => current, (s) => { current = s; }, fsr);

        expect(action.isFsrStateChanging(1.0, 0.85)).toBe(false); // 都没开
        expect(action.isFsrStateChanging(0.85, 0.7)).toBe(true);  // 这一步打开 FSR
        expect(action.isFsrStateChanging(0.7, 0.3)).toBe(false);  // 都开着
    });

    test('isFsrStateChanging：无 FSR 控制器时返回 false（测试替身兼容）', () => {
        const action = new ScaleAction(0.6, [0.85, 0.7], () => 1.0, () => { /* noop */ });
        expect(action.isFsrStateChanging(1.0, 0.7)).toBe(false);

        const noWouldEnable = { apply: jest.fn(), restore: jest.fn() } as any;
        const action2 = new ScaleAction(0.6, [0.85, 0.7], () => 1.0, () => { /* noop */ }, noWouldEnable);
        expect(action2.isFsrStateChanging(1.0, 0.7)).toBe(false);
    });
});
