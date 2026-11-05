import { ThermalStrategy } from '../../cocos/thermal/thermal-strategy';

describe('ThermalStrategy', () => {
    const makeClock = (start = 0) => {
        let t = start;
        return {
            now: (): number => t,
            advance: (ms: number): void => { t += ms; },
        };
    };

    // 默认：trigger 10%，recover -10%，recoverWindow 5s，cooldown 10s。
    // targetMs = 100 时：diff >= +10% 降档；diff < -10% 持续 5s 才升档。

    test('默认 10% 触发，冷却 10s 内不重复动作', () => {
        const clock = makeClock(0);
        const s = new ThermalStrategy({}, clock.now);
        expect(s.update(110, 100)).toBe('DOWN'); // 恰好 10%
        clock.advance(1000);
        expect(s.update(150, 100)).toBe('NONE'); // 冷却期内
        clock.advance(9000); // 累计 10s
        expect(s.update(110, 100)).toBe('DOWN'); // 冷却结束
    });

    test('边界：9% 不触发，10% 触发', () => {
        const clock = makeClock(0);
        const s = new ThermalStrategy({}, clock.now);
        expect(s.update(109, 100)).toBe('NONE');
        expect(s.update(110, 100)).toBe('DOWN');
    });

    test('默认 -10% 恢复：低于预算 10% 持续 5s 才升档（signalDrivenUpgrade=true 时）', () => {
        const clock = makeClock(0);
        const s = new ThermalStrategy({ signalDrivenUpgrade: true }, clock.now);
        expect(s.update(89, 100)).toBe('NONE'); // -11%，开始计时
        clock.advance(4000);
        expect(s.update(89, 100)).toBe('NONE');
        clock.advance(1000);
        expect(s.update(89, 100)).toBe('UP'); // 持续 5s
    });

    test('一期默认（signalDrivenUpgrade=false）：帧时间低于预算也永不升档', () => {
        const clock = makeClock(0);
        const s = new ThermalStrategy({}, clock.now);
        // 连续 30s 低于预算 50%，远超恢复阈值与确认窗口 —— 仍然是 NONE（只降不升）
        for (let i = 0; i < 30; i++) {
            expect(s.update(50, 100)).toBe('NONE');
            clock.advance(1000);
        }
        // 打开开关后同一序列才会升档
        const s2 = new ThermalStrategy({ signalDrivenUpgrade: true }, makeClock(0).now);
        expect(s2.update(50, 100)).toBe('NONE');
    });

    test('默认 -10%：30fps 限帧特征（-6.4%）不会触发升档', () => {
        const clock = makeClock(0);
        const s = new ThermalStrategy({}, clock.now);
        expect(s.update(31.2, 33.33)).toBe('NONE'); // -6.4%
        clock.advance(10000);
        expect(s.update(31.2, 33.33)).toBe('NONE');
        clock.advance(10000);
        expect(s.update(31.2, 33.33)).toBe('NONE');
    });

    test('恢复边界：恰好 -10% 不算恢复', () => {
        const clock = makeClock(0);
        const s = new ThermalStrategy({}, clock.now);
        expect(s.update(90, 100)).toBe('NONE');
        clock.advance(5000);
        expect(s.update(90, 100)).toBe('NONE');
    });

    test('迟滞带：-10% <= diff < 10% 不动作且清恢复计时', () => {
        const clock = makeClock(0);
        const s = new ThermalStrategy({ signalDrivenUpgrade: true }, clock.now);
        expect(s.update(89, 100)).toBe('NONE'); // -11%，开始恢复计时
        clock.advance(3000);
        expect(s.update(91, 100)).toBe('NONE'); // -9%，迟滞带，清计时
        clock.advance(1000);
        expect(s.update(89, 100)).toBe('NONE'); // 重新开始
        clock.advance(5000);
        expect(s.update(89, 100)).toBe('UP');
    });

    test('reset 清冷却与恢复计时', () => {
        const clock = makeClock(0);
        const s = new ThermalStrategy({}, clock.now);
        expect(s.update(110, 100)).toBe('DOWN');
        s.reset();
        expect(s.update(110, 100)).toBe('DOWN');
    });

    test('换阈值立即生效', () => {
        const clock = makeClock(0);
        const s = new ThermalStrategy({}, clock.now);
        expect(s.update(105, 100)).toBe('NONE'); // 5% < 10%
        s.setThreshold(5);
        expect(s.update(105, 100)).toBe('DOWN'); // 5% >= 5%
    });

    test('目标帧时间跟着当前帧率走（不缓存）', () => {
        const clock = makeClock(0);
        const s = new ThermalStrategy({ signalDrivenUpgrade: true }, clock.now);
        expect(s.update(20, 16.67)).toBe('DOWN'); // 60fps 预算，+20%
        clock.advance(10000); // 过冷却
        expect(s.update(20, 33.33)).toBe('NONE'); // 30fps 预算，-40%，开始恢复
        clock.advance(5000);
        expect(s.update(20, 33.33)).toBe('UP');
    });

    test('恢复确认窗口可独立设置', () => {
        const clock = makeClock(0);
        const s = new ThermalStrategy({ recoverWindowSeconds: 1, signalDrivenUpgrade: true }, clock.now);
        expect(s.update(89, 100)).toBe('NONE');
        clock.advance(1000);
        expect(s.update(89, 100)).toBe('UP');
    });
});
