/*
 Copyright (c) 2026 Xiamen Yaji Software Co., Ltd.

 https://www.cocos.com/

 Permission is hereby granted, free of charge, to any person obtaining a copy
 of this software and associated documentation files (the "Software"), to deal
 in the Software without restriction, including without limitation the rights
 to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies
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

import { director } from '../game/director';
import { Camera } from '../misc/camera-component';
import type { Material } from '../asset/assets/material';
import type { IThermalFsr } from './types';

interface FsrSnapshot {
    enabled: boolean;
    material: Material | null;
    sharpness: number;
}

/** FSR 默认只在 scale <= 0.85 时开启（0.85 档降采样的收益刚好覆盖 FSR 的固定开销）。 */
const DEFAULT_MIN_SCALE = 0.85;

/**
 * @en Drives the custom pipeline's FSR pass from the thermal shading scale.
 *
 * The default custom pipeline builder ('Builtin') owns an **independent FSR pass**
 * (`BuiltinFsrPassBuilder`: `cc-fsr-easu` + `cc-fsr-rcas`, effect `pipeline/post-process/fsr1`).
 * It is NOT part of the deprecated `custom-pipeline-post-process` framework: no `cc.PostProcess`,
 * no `SettingPass`, no `passContext`. It only needs the camera's `BuiltinPipelineSettings.fsr`.
 *
 * This class therefore only does three things:
 *   1) make sure the camera has `BuiltinPipelineSettings` (attach it at runtime if missing);
 *   2) write `{ enabled, material, sharpness }` into `settings.fsr` while scale < 1;
 *   3) restore the original settings when scale goes back (or when FSR is disabled).
 *
 * @zh 用温控的 shadingScale 驱动自定义管线的 FSR pass。
 *
 * 默认自定义管线 builder（'Builtin'）自带一个**独立 FSR pass**（`BuiltinFsrPassBuilder`：
 * `cc-fsr-easu` + `cc-fsr-rcas`，effect 为 `pipeline/post-process/fsr1`），它**不属于**已废弃的
 * `custom-pipeline-post-process` 框架（不用 cc.PostProcess / SettingPass / passContext），
 * 只依赖相机的 `BuiltinPipelineSettings.fsr`。
 *
 * 所以本类只做三件事：
 *   1) 确保相机上有 `BuiltinPipelineSettings`（没有就运行时挂一个）；
 *   2) scale < 1 期间把 `{ enabled, material, sharpness }` 写进 `settings.fsr`；
 *   3) scale 回到 1（或 FSR 被关掉）时还原相机原来的设置。
 *
 * SCOPE: FSR upscales the 3D render target that shadingScale shrinks. It cannot compensate a
 * Canvas/UI camera, because the UI pass is rendered after the 3D upscale at native resolution.
 * For 2D/UI-heavy games disable FSR (enableFsr=false) and rely on the frame-rate lever.
 *
 * SCOPE：FSR 只升采样 shadingScale 缩小的那张 3D RT；UI 在升采样之后按原生分辨率绘制，补不了。
 * 2D/UI 为主的游戏应关掉 FSR（enableFsr=false），只用帧率杠杆。
 */
export class ThermalFsr implements IThermalFsr {
    private _material: Material | null;
    private _sharpness: number;
    private _minScale: number;
    private _settings: any = null;
    private _snapshot: FsrSnapshot | null = null;
    /** E06：缓存的目标相机。换场景/销毁后必须重新解析，否则会一直写旧相机的 settings。 */
    private _camera: any = null;
    private _warnedMaterial = false;
    private _warnedComponent = false;
    private _lastScale = 1;
    private _enabled = true;

    constructor (material: Material | null = null, sharpness = 0.8, minScale = DEFAULT_MIN_SCALE) {
        this._material = material;
        this._sharpness = sharpness;
        this._minScale = Math.min(1, Math.max(0, minScale));
    }

    public setMaterial (material: Material | null): void {
        this._material = material;
        if (this._lastScale < 1) {
            this.apply(this._lastScale);
        }
    }

    /**
     * @en Sets the smallest shading scale at which FSR is enabled (`scale <= minScale`).
     * Raise it to 1.0 to always enable FSR when down-scaling; lower it (e.g. 0.7) when the FSR
     * cost outweighs the saving of the first tier.
     * @zh 设置启用 FSR 的最大 scale（`scale <= minScale` 才开）。设为 1.0 = 只要降分辨率就开；
     * 设为 0.7 = 0.85 档先用纯降采样、0.7 档才开 FSR。
     */
    public setMinScale (minScale: number): void {
        this._minScale = Math.min(1, Math.max(0, minScale));
        if (this._lastScale < 1) {
            this.apply(this._lastScale);
        }
    }

    public isEnabled (): boolean {
        return this._enabled;
    }

    /**
     * @en Whether FSR would be ON at the given shading scale (used by the effectiveness probe to
     * detect a step that crosses the FSR threshold).
     * @zh 给定 shadingScale 下 FSR 是否会开（供有效性探针判断某一步是否跨过 FSR 阈值）。
     */
    public wouldEnableAt (scale: number): boolean {
        return this._enabled && scale < 1 && scale <= this._minScale;
    }

    public apply (scale: number): void {
        this._lastScale = scale;
        if (!this._enabled) {
            return;
        }
        // scale 没降，或降得还不够（净收益覆盖不了 FSR 固定开销）：还原相机原来的 FSR 设置。
        if (scale >= 1 || scale > this._minScale) {
            if (this._settings) {
                this._restore(this._settings);
            }
            return;
        }
        const settings = this._ensureSettings();
        if (!settings) {
            return;
        }
        if (!this._snapshot) {
            this._snapshot = {
                enabled: settings.fsr.enabled,
                material: settings.fsr.material,
                sharpness: settings.fsr.sharpness,
            };
        }
        const material = this._material ?? settings.fsr.material;
        if (!material) {
            if (!this._warnedMaterial) {
                this._warnedMaterial = true;
                // eslint-disable-next-line no-console
                console.warn('[Thermal] FSR material is not set; shadingScale falls back to plain downsampling. '
                    + 'Load the FSR material and pass it to thermal.setFsrMaterial().');
            }
            return;
        }
        settings.fsr.enabled = true;
        settings.fsr.material = material;
        settings.fsr.sharpness = this._sharpness;
    }

    /**
     * @en Enables/disables FSR. Disabling restores the camera's original FSR settings.
     * @zh 启用/禁用 FSR。禁用时还原相机原来的 FSR 设置。
     */
    public setEnabled (enabled: boolean): void {
        if (this._enabled === enabled) {
            return;
        }
        this._enabled = enabled;
        if (!enabled) {
            this.restore();
        }
    }

    public restore (): void {
        if (this._settings && this._snapshot && this._isCacheValid()) {
            this._restore(this._settings);
        }
        this._settings = null;
        this._snapshot = null;
        this._camera = null;
        this._lastScale = 1;
    }

    /**
     * @en Whether the cached camera/settings still belong to the current scene. A destroyed camera
     * (scene switch) or a different active scene invalidates the cache; the next apply() re-resolves.
     * @zh 缓存的目标相机是否仍属于当前场景。相机被销毁（换场景）或活动场景不同都算失效，
     * 下一次 apply() 会重新解析，避免把 FSR 写到旧场景的相机上。
     */
    private _isCacheValid (): boolean {
        if (!this._settings || !this._camera) {
            return false;
        }
        const node = this._camera.node;
        if (!node) {
            return false;
        }
        // 测试替身没有 isValid（undefined）：当作有效，只在明确失效时重建。
        if (node.isValid === false) {
            return false;
        }
        const scene = director.getScene();
        if (scene && node.scene && node.scene !== scene) {
            return false;
        }
        return true;
    }

    /** 丢弃缓存（旧相机已不在当前场景）：不还原旧快照，避免把旧场景的 FSR 设置写到新相机上 */
    private _dropCache (): void {
        this._settings = null;
        this._snapshot = null;
        this._camera = null;
    }

    private _restore (settings: any): void {
        if (!this._snapshot) {
            return;
        }
        settings.fsr.enabled = this._snapshot.enabled;
        settings.fsr.material = this._snapshot.material;
        settings.fsr.sharpness = this._snapshot.sharpness;
    }

    /**
     * 挑 FSR 的目标相机：优先透视相机（3D），避免 Canvas 的 UI 正交相机排在场景前面时被误选。
     * 场景没有 `getComponentsInChildren` 时（测试替身）退回 `getComponentInChildren`。
     */
    private _pickCamera (scene: any): any {
        let cams: any[] = [];
        if (typeof scene.getComponentsInChildren === 'function') {
            cams = scene.getComponentsInChildren(Camera) || [];
        }
        for (let i = 0; i < cams.length; i++) {
            if (cams[i] && cams[i].projection === Camera.ProjectionType.PERSPECTIVE) {
                return cams[i];
            }
        }
        if (cams.length > 0) {
            return cams[0];
        }
        return typeof scene.getComponentInChildren === 'function' ? scene.getComponentInChildren(Camera) : null;
    }

    /**
     * 拿到相机上的 PipelineSettings（`BuiltinPipelineSettings` 组件上的那一份）。
     * 失败时返回 null，并且**不置粘性降级**：下次 apply() 会重试（组件类可能晚一帧才可用）。
     */
    private _ensureSettings (): any {
        if (this._settings) {
            if (this._isCacheValid()) {
                return this._settings;
            }
            // E06：换场景后旧相机已销毁（或已不是当前场景）——旧快照不能拿去还原新相机，直接丢弃重解析。
            this._dropCache();
        }
        const scene = director.getScene();
        if (!scene) {
            return null;
        }
        const camera = this._pickCamera(scene as any);
        if (!camera) {
            return null;
        }
        const renderCamera: any = camera.camera;
        let comp: any = null;
        try {
            comp = camera.node.getComponent('BuiltinPipelineSettings');
        } catch (e) {
            comp = null;
        }
        if (!comp) {
            try {
                comp = camera.node.addComponent('BuiltinPipelineSettings');
            } catch (e) {
                comp = null;
            }
            if (!comp) {
                if (!this._warnedComponent) {
                    this._warnedComponent = true;
                    // eslint-disable-next-line no-console
                    console.warn('[Thermal] BuiltinPipelineSettings is unavailable; FSR falls back to plain downsampling '
                        + 'for now (will retry on the next scale change). Enable the `custom-pipeline-builtin-scripts` feature '
                        + 'if you expect FSR to work.');
                }
                return null;
            }
        }
        let settings: any = comp && typeof comp.getPipelineSettings === 'function'
            ? comp.getPipelineSettings()
            : null;
        if (!settings && renderCamera) {
            settings = renderCamera.pipelineSettings;
        }
        if (!settings) {
            return null;
        }
        if (!settings.fsr) {
            settings.fsr = { enabled: false, material: null, sharpness: 0.8 };
        }
        if (renderCamera) {
            renderCamera.pipelineSettings = settings;
        }
        this._settings = settings;
        this._camera = camera;
        return settings;
    }
}
