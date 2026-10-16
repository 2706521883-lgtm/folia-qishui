import { describe, expect, it, vi } from 'vitest';
import { probeAacPlayback } from '../../../src/services/onlineMusic/qishuiAudioCapability';

/**
 * 假的 <audio>：只实现探针用到的那些，事件由测试自己 emit。
 * 真元素在 node 里根本没有，而探针的全部要害就是「什么事件算支持、什么算不支持」。
 */
const fakeAudio = () => {
    const listeners: Record<string, Array<() => void>> = {};
    const element = {
        preload: '',
        src: '',
        addEventListener: (type: string, handler: () => void) => {
            (listeners[type] ||= []).push(handler);
        },
        removeAttribute: vi.fn(),
        load: vi.fn(),
        emit: (type: string) => { (listeners[type] || []).forEach(handler => handler()); },
    };
    return element;
};

describe('probeAacPlayback', () => {
    it('非浏览器环境没有 Audio：当作支持，别让 Node 侧白白触发转码', async () => {
        await expect(probeAacPlayback(() => null)).resolves.toBe(true);
    });

    it('loadedmetadata = 能放', async () => {
        const audio = fakeAudio();
        const probe = probeAacPlayback(() => audio as never);
        audio.emit('loadedmetadata');
        await expect(probe).resolves.toBe(true);
    });

    it('error = 放不了（这就是 VS Code 内置浏览器里的那条路）', async () => {
        const audio = fakeAudio();
        const probe = probeAacPlayback(() => audio as never);
        audio.emit('error');
        await expect(probe).resolves.toBe(false);
    });

    it('既不报错也不出声（事件不来）时超时算支持：慢机器不该被误判成放不了', async () => {
        const audio = fakeAudio();
        await expect(probeAacPlayback(() => audio as never, 10)).resolves.toBe(true);
    });

    it('先到先算，之后的事件不翻案；出结果后会把样本收摊', async () => {
        const audio = fakeAudio();
        const probe = probeAacPlayback(() => audio as never);
        audio.emit('error');
        audio.emit('loadedmetadata');
        await expect(probe).resolves.toBe(false);
        expect(audio.removeAttribute).toHaveBeenCalledWith('src');
        expect(audio.load).toHaveBeenCalled();
    });

    it('探针把样本设成 data: URL 且预载只取元数据', async () => {
        const audio = fakeAudio();
        void probeAacPlayback(() => audio as never);
        expect(audio.src.startsWith('data:audio/mp4;base64,')).toBe(true);
        expect(audio.preload).toBe('metadata');
    });
});
