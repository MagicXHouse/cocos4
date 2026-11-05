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
 * @en Builds the descending list of valid levels from the original value down to the floor.
 * It includes the original value, every tier strictly below it, and the floor as the last stop.
 * If the original value is already at or below the floor, a single-element list is returned (no-op).
 * Non-finite inputs (NaN/Infinity) degrade to a single-element list too: NaN would otherwise enter
 * the Set, make `sort` return NaN from its comparator, and silently corrupt the tier table.
 * @zh 构建从原值逐档降到地板的降序档位表：包含原值、所有严格低于原值的中间档、以及地板（末级）。
 * 若原值已低于或等于地板，则返回单元素列表（不动作）。
 * 非有限值（NaN/Infinity）同样退化为单元素列表：否则 NaN 会进 Set，让 sort 的比较函数返回 NaN，
 * 档位表被静默搞坏。
 */
export function buildLevels (original: number, tiers: number[], min: number): number[] {
    // 非有限值防御：原值或地板不是有效数字时，直接退化成 no-op，绝不产出损坏的档位表。
    if (!Number.isFinite(original) || !Number.isFinite(min)) {
        return [original];
    }
    // 原值已在地板以下：温控绝不能把值抬到游戏自身设定之上，动作变为 no-op。
    if (original <= min) {
        return [original];
    }
    const set = new Set<number>();
    set.add(original);
    for (const t of tiers) {
        // 非法档位直接跳过，避免污染排序结果
        if (!Number.isFinite(t)) {
            continue;
        }
        if (t < original && t >= min) {
            set.add(t);
        }
    }
    set.add(min);
    return Array.from(set).sort((a, b) => b - a);
}
