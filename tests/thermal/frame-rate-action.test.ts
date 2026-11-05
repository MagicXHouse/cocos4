import { FrameRateAction } from '../../cocos/thermal/actions/frame-rate-action';

describe('FrameRateAction', () => {
    test('档位序列：60 -> 45 -> 30 一档档降', () => {
        let current = 60;
        const written: number[] = [];
        const action = new FrameRateAction(30, [60, 45, 30], () => current, (fps) => { current = fps; written.push(fps); });

        expect(action.stepDown()).toBe(true); // 60 -> 45
        expect(written).toEqual([45]);
        expect(action.stepDown()).toBe(true); // 45 -> 30
        expect(written).toEqual([45, 30]);
        expect(action.stepDown()).toBe(false); // 到底
        expect(action.isAtFloor()).toBe(true);
    });

    test('E02：外部改了 game.frameRate 后，stepDown 以实时值为准', () => {
        let current = 60;
        const action = new FrameRateAction(30, [60, 30], () => current, (fps) => { current = fps; });

        // 外部（项目的 setFps、其他系统）把它改到 30
        current = 30;
        expect(action.stepDown()).toBe(false);      // 已经在地板，不能"降"成 60
        expect(current).toBe(30);
        expect(action.getStepsDown()).toBe(1);

        // 外部改回 60：这一下应当真正降到 30
        current = 60;
        expect(action.stepDown()).toBe(true);
        expect(current).toBe(30);
    });

    test('E05：minFrameRate 等于原帧率 = 钉住（buildLevels 退化成单元素，stepDown 恒 false）', () => {
        let current = 60;
        const action = new FrameRateAction(60, [60, 30], () => current, (fps) => { current = fps; });

        expect(action.stepDown()).toBe(false);
        expect(action.stepUp()).toBe(false);
        expect(current).toBe(60);
        expect(action.isAtFloor()).toBe(true);
    });

    test('N1：外部把帧率设成 120 时，第一档降到表内 top 档 60（不能一跳到底）', () => {
        let current = 60;
        const action = new FrameRateAction(30, [60, 30], () => current, (fps) => { current = fps; });

        current = 120;                              // 120Hz 设备把 game.frameRate 设成 120
        expect(action.stepDown()).toBe(true);
        expect(current).toBe(60);                   // 期望 60，而不是直接 30
    });

    test('到底不再降，stepDown 返回 false', () => {
        let current = 30;
        const action = new FrameRateAction(30, [60, 45, 30], () => current, (fps) => { current = fps; });

        expect(action.isAtFloor()).toBe(true);
        expect(action.stepDown()).toBe(false);
    });

    test('restore 还原到原帧率', () => {
        let current = 60;
        const action = new FrameRateAction(30, [60, 45, 30], () => current, (fps) => { current = fps; });

        action.stepDown(); // 45
        action.stepDown(); // 30
        expect(current).toBe(30);
        action.restore();
        expect(current).toBe(60);
    });

    test('stepUp 一档档升，到原帧率封顶', () => {
        let current = 60;
        const action = new FrameRateAction(30, [60, 45, 30], () => current, (fps) => { current = fps; });

        action.stepDown(); // 45
        action.stepDown(); // 30
        expect(action.stepUp()).toBe(true); // 30 -> 45
        expect(action.stepUp()).toBe(true); // 45 -> 60
        expect(action.stepUp()).toBe(false); // 到顶
        expect(current).toBe(60);
    });

    test('原帧率不在标准档位里（如 90），动态生成阶梯', () => {
        let current = 90;
        const written: number[] = [];
        const action = new FrameRateAction(30, [60, 45, 30], () => current, (fps) => { current = fps; written.push(fps); });

        expect(action.stepDown()).toBe(true); // 90 -> 60
        expect(action.stepDown()).toBe(true); // 60 -> 45
        expect(action.stepDown()).toBe(true); // 45 -> 30
        expect(action.stepDown()).toBe(false); // 到底
        expect(written).toEqual([60, 45, 30]);
        action.restore();
        expect(current).toBe(90);
    });

    test('原帧率低于地板时不降也不升', () => {
        let current = 25;
        const action = new FrameRateAction(30, [60, 45, 30], () => current, (fps) => { current = fps; });

        expect(action.isAtFloor()).toBe(true);
        expect(action.stepDown()).toBe(false);
        expect(action.stepUp()).toBe(false);
        expect(current).toBe(25); // 帧率始终不被改动
    });
});
