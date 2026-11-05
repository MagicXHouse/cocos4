import { ThermalFsr } from '../../cocos/thermal/fsr';
import { director } from '../../cocos/game/director';
import { Camera } from '../../cocos/misc/camera-component';

describe('ThermalFsr', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('apply < 1 enables FSR, apply 1 restores the original settings', () => {
        const settings: any = { fsr: { enabled: false, material: null, sharpness: 0.8 } };
        const comp = { getPipelineSettings: () => settings };
        const camera: any = {
            node: { getComponent: () => comp, addComponent: () => comp },
            camera: { pipelineSettings: settings },
        };
        jest.spyOn(director, 'getScene').mockReturnValue({ getComponentInChildren: () => camera } as any);

        const material: any = { name: 'fsr' };
        const fsr = new ThermalFsr(material, 0.7);

        fsr.apply(0.85);
        expect(settings.fsr.enabled).toBe(true);
        expect(settings.fsr.material).toBe(material);
        expect(settings.fsr.sharpness).toBe(0.7);

        fsr.apply(1.0);
        expect(settings.fsr.enabled).toBe(false);
        expect(settings.fsr.material).toBe(null);
        expect(settings.fsr.sharpness).toBe(0.8);
    });

    test('setEnabled(false) restores and blocks apply; re-enable works', () => {
        const settings: any = { fsr: { enabled: false, material: null, sharpness: 0.8 } };
        const comp = { getPipelineSettings: () => settings };
        const camera: any = {
            node: { getComponent: () => comp, addComponent: () => comp },
            camera: { pipelineSettings: settings },
        };
        jest.spyOn(director, 'getScene').mockReturnValue({ getComponentInChildren: () => camera } as any);

        const material: any = { name: 'fsr' };
        const fsr = new ThermalFsr(material, 0.7);

        fsr.apply(0.85);
        expect(fsr.isEnabled()).toBe(true);
        expect(settings.fsr.enabled).toBe(true);

        fsr.setEnabled(false);
        expect(fsr.isEnabled()).toBe(false);
        expect(settings.fsr.enabled).toBe(false);
        expect(settings.fsr.material).toBe(null);

        fsr.apply(0.7); // disabled: no-op
        expect(settings.fsr.enabled).toBe(false);

        fsr.setEnabled(true);
        fsr.apply(0.7);
        expect(settings.fsr.enabled).toBe(true);
        expect(settings.fsr.material).toBe(material);
    });

    test('no scene is safe', () => {
        jest.spyOn(director, 'getScene').mockReturnValue(null);
        const fsr = new ThermalFsr(null, 0.8);
        expect(() => fsr.apply(0.85)).not.toThrow();
        expect(() => fsr.restore()).not.toThrow();
    });

    test('fsrMinScale gates the shallow tier (0.85 stays plain, 0.7 enables FSR)', () => {
        const settings: any = { fsr: { enabled: false, material: null, sharpness: 0.8 } };
        const comp = { getPipelineSettings: () => settings };
        const camera: any = {
            node: { getComponent: () => comp, addComponent: () => comp },
            camera: { pipelineSettings: settings },
        };
        jest.spyOn(director, 'getScene').mockReturnValue({ getComponentInChildren: () => camera } as any);

        const material: any = { name: 'fsr' };
        const fsr = new ThermalFsr(material, 0.8, 0.7);

        fsr.apply(0.85);
        expect(settings.fsr.enabled).toBe(false);

        fsr.apply(0.7);
        expect(settings.fsr.enabled).toBe(true);
        expect(settings.fsr.material).toBe(material);
    });

    test('a missing BuiltinPipelineSettings is retried instead of permanently downgraded', () => {        const settings: any = { fsr: { enabled: false, material: null, sharpness: 0.8 } };
        const comp = { getPipelineSettings: () => settings };
        let attempts = 0;
        const node: any = {
            getComponent: () => null,
            addComponent: () => {
                attempts += 1;
                if (attempts === 1) {
                    throw new Error('not ready yet');
                }
                return comp;
            },
        };
        const camera: any = { node, camera: { pipelineSettings: null } };
        jest.spyOn(director, 'getScene').mockReturnValue({ getComponentInChildren: () => camera } as any);
        jest.spyOn(console, 'warn').mockImplementation(() => { /* silence */ });

        const material: any = { name: 'fsr' };
        const fsr = new ThermalFsr(material, 0.8);

        fsr.apply(0.85);
        expect(settings.fsr.enabled).toBe(false); // first attempt failed
        expect(fsr.isEnabled()).toBe(true);       // but it is not a permanent downgrade

        fsr.apply(0.85);
        expect(settings.fsr.enabled).toBe(true);
        expect(settings.fsr.material).toBe(material);
    });

    test('E06：换场景后重新解析相机，FSR 不再写到旧相机上', () => {
        const settingsA: any = { fsr: { enabled: false, material: null, sharpness: 0.8 } };
        const compA = { getPipelineSettings: () => settingsA };
        const camA: any = {
            node: { isValid: true, getComponent: () => compA, addComponent: () => compA },
            camera: { pipelineSettings: settingsA },
        };
        const settingsB: any = { fsr: { enabled: false, material: null, sharpness: 0.8 } };
        const compB = { getPipelineSettings: () => settingsB };
        const camB: any = {
            node: { isValid: true, getComponent: () => compB, addComponent: () => compB },
            camera: { pipelineSettings: settingsB },
        };
        const sceneA: any = { getComponentInChildren: () => camA };
        const sceneB: any = { getComponentInChildren: () => camB };
        const sceneSpy = jest.spyOn(director, 'getScene').mockReturnValue(sceneA);

        const material: any = { name: 'fsr' };
        const fsr = new ThermalFsr(material, 0.8);

        fsr.apply(0.7);
        expect(settingsA.fsr.enabled).toBe(true);

        // 切场景：旧相机销毁，活动场景变成 B
        camA.node.isValid = false;
        sceneSpy.mockReturnValue(sceneB);
        fsr.apply(0.7);

        expect(settingsB.fsr.enabled).toBe(true);
        expect(settingsB.fsr.material).toBe(material);
    });

    test('prefers the perspective camera over an orthographic UI camera', () => {
        const settings: any = { fsr: { enabled: false, material: null, sharpness: 0.8 } };
        const comp = { getPipelineSettings: () => settings };
        const uiCam: any = {
            projection: Camera.ProjectionType.ORTHO,
            node: { getComponent: () => null, addComponent: () => null },
            camera: { pipelineSettings: null },
        };
        const mainCam: any = {
            projection: Camera.ProjectionType.PERSPECTIVE,
            node: { getComponent: () => comp, addComponent: () => comp },
            camera: { pipelineSettings: settings },
        };
        jest.spyOn(director, 'getScene').mockReturnValue({
            getComponentsInChildren: () => [uiCam, mainCam],
            getComponentInChildren: () => uiCam,
        } as any);

        const material: any = { name: 'fsr' };
        const fsr = new ThermalFsr(material, 0.8);
        fsr.apply(0.85);

        expect(settings.fsr.enabled).toBe(true);
        expect(uiCam.camera.pipelineSettings).toBeNull();
    });
});
