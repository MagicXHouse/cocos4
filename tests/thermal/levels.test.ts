import { buildLevels } from '../../cocos/thermal/actions/levels';

describe('buildLevels', () => {
    test('正常：原值 + 中间档 + 地板，降序排列', () => {
        expect(buildLevels(1.0, [0.85, 0.7], 0.3)).toEqual([1, 0.85, 0.7, 0.3]);
    });

    test('原值已在地板以下：单元素 no-op（不把值抬上去）', () => {
        expect(buildLevels(0.2, [0.85, 0.7], 0.3)).toEqual([0.2]);
    });

    test('NaN 原值：退化为单元素，不产生损坏的档位表', () => {
        const out = buildLevels(Number.NaN, [0.85, 0.7], 0.3);
        expect(out.length).toBe(1);
        expect(Number.isNaN(out[0])).toBe(true);
    });

    test('NaN 地板：退化为单元素', () => {
        expect(buildLevels(1.0, [0.85], Number.NaN).length).toBe(1);
    });

    test('非法档位被跳过，合法档位照常保留', () => {
        expect(buildLevels(1.0, [Number.NaN, 0.7], 0.3)).toEqual([1, 0.7, 0.3]);
    });
});
