// src/services/onlineMusic/qishuiAudioCapability.ts

/**
 * 「这台浏览器放不放得了 AAC」的能力探针。
 *
 * 为什么必须真放一段才知道：汽水的音频是 MP4 容器里的 AAC-LC，而缺解码器的环境里
 * （实测 VS Code 内置浏览器 Code/1.141.2）`canPlayType('audio/mp4; codecs="mp4a.40.2"')` 照样回
 * "probably"、`MediaSource.isTypeSupported` 也回 true，只有真实 <audio> 元素会报
 * MEDIA_ERR_SRC_NOT_SUPPORTED / DEMUXER_ERROR_NO_SUPPORTED_STREAMS。
 *
 * 探针结果决定要不要让**服务器**转码（qishui-server.cjs 的 /a?fmt=mp3）。
 * 拿不准的一律算「支持」：误判成不支持会让每台机器都白白转码，代价比偶尔漏判大得多。
 */

/** 0.4s 的 AAC-LC（44.1kHz 立体声 32kbps、moov 前置），放不出来正好是汽水那条路会失败的那个形态。 */
const AAC_PROBE_SRC = 'data:audio/mp4;base64,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';

/** 超过这个时间还没消息就当支持：慢机器不该被误判成放不了。 */
const PROBE_TIMEOUT_MS = 1500;

const defaultCreateAudio = (): HTMLAudioElement | null => {
    try {
        return typeof Audio === 'function' ? new Audio() : null;
    } catch {
        return null;
    }
};

/**
 * 用真实 <audio> 元素探一次。返回 true = 能放 AAC；false = 放不了，该请服务器转码。
 * createAudio 只是为了单测能塞假元素，正常调用不用传。
 */
export const probeAacPlayback = (
    createAudio: () => HTMLAudioElement | null = defaultCreateAudio,
    timeoutMs = PROBE_TIMEOUT_MS,
): Promise<boolean> => {
    const audio = createAudio();
    // 非浏览器环境没有 Audio：当作支持（服务器转码是给浏览器准备的，别让 Node 侧白白触发）。
    if (!audio) return Promise.resolve(true);
    return new Promise<boolean>(resolve => {
        let settled = false;
        const finish = (result: boolean) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            // 收摊：探针样本不该继续占着解码/网络资源。
            try { audio.removeAttribute('src'); audio.load(); } catch { /* 假元素或已卸载 */ }
            resolve(result);
        };
        const timer = setTimeout(() => finish(true), timeoutMs);
        audio.addEventListener('loadedmetadata', () => finish(true));
        audio.addEventListener('error', () => finish(false));
        audio.preload = 'metadata';
        audio.src = AAC_PROBE_SRC;
    });
};

let cachedProbe: Promise<boolean> | null = null;

/** 整个会话只探一次：每首歌都探一遍毫无意义，而探针本身要几十毫秒。 */
export const canPlayAac = (): Promise<boolean> => {
    // 探针自己出问题（构造失败、事件不响应）不许连累播放：一律当支持。
    cachedProbe ??= probeAacPlayback().catch(() => true);
    return cachedProbe;
};

/** 放不了 AAC 时，音频地址要带 fmt=mp3 让服务器转码。 */
export const shouldRequestTranscodedAudio = async (): Promise<boolean> => !(await canPlayAac());
