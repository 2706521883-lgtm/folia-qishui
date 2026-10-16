import type { ProviderErrorCode } from '../../types/onlineMusic';
import { OnlineProviderError } from '../../types/onlineMusic';
import { shouldRequestTranscodedAudio } from './qishuiAudioCapability';

// src/services/onlineMusic/qishuiTransport.ts

// 冻结契约：下面的 operation 名与参数名就是桌面端 preload 接受的那一套，渲染层只有这一份真值。
export type QishuiOperation =
    | 'status'
    | 'login.qr'
    | 'login.check'
    | 'login.logout'
    | 'search'
    | 'artist'
    | 'song.detail'
    | 'album'
    | 'lyric'
    | 'song.url'
    | 'feed'
    | 'user.playlists'
    | 'playlist.tracks'
    | 'track.liked'
    | 'track.like'
    | 'playlist.collect'
    | 'playlist.addSong'
    | 'album.collect'
    | 'report.play'
    | 'comments'
    | 'comment.create';

export type QishuiParams = Record<string, unknown>;

export type QishuiBridgeResult =
    | { ok: true; data: unknown }
    | { ok: false; error: { code: string; message: string } };

// 服务器形态（路线 A / M1）：PC 上 `npx electron electron/qishui-server.cjs` 把同一个桥包成带令牌的
// HTTP RPC，这些变量的值只在**没有** Electron 桥时才用得上（桌面版完全忽略它们）。
const readServerEnv = (name: 'VITE_QISHUI_API_BASE' | 'VITE_QISHUI_API_TOKEN'): string => {
    const viteValue = typeof import.meta !== 'undefined' && import.meta.env?.MODE !== 'test'
        ? String((import.meta as ImportMeta & { env?: Record<string, string> }).env?.[name] || '')
        : '';
    const processValue = typeof process !== 'undefined' ? String(process.env?.[name] || '') : '';
    return (viteValue || processValue).trim();
};

const getServerBase = (): string => readServerEnv('VITE_QISHUI_API_BASE').replace(/\/+$/, '');

const hasDesktopBridge = (): boolean => (
    typeof window !== 'undefined' && typeof window.electron?.qishuiRequest === 'function'
);

// 两条路都没有时给 not-configured（面板里显示「未配置」）而不是 runtime-unavailable（整个藏起来）：
// 藏起来会让「服务器没配/没起」看起来像「这个音源不存在」，和酷狗/QQ 的呈现也对不上。
export const getQishuiTransportAvailability = () => (
    hasDesktopBridge() || getServerBase()
        ? { configured: true } as const
        : { configured: false, reason: 'not-configured' } as const
);

const PROVIDER_ERROR_CODES = new Set<ProviderErrorCode>([
    'auth-required', 'unsupported', 'not-public', 'unavailable', 'not-playable',
    'preview-only', 'region-restricted', 'network', 'invalid-response',
]);
const AUTH_ERROR_CODES = new Set(['QISHUI_TOKEN_REQUIRED', 'QISHUI_COOKIE_REQUIRED', 'QISHUI_LOGIN_REQUIRED']);
const REQUEST_ERROR_CODES = new Set(['QISHUI_QR_TOKEN_REQUIRED']);

// 主进程桥会把抛出的错误码统一成小写短横线形式（QISHUI_COOKIE_REQUIRED -> qishui-cookie-required），
// 而 200 + error 的数据级错误还是原始大写形式，所以匹配前先归一化。
const normalizeQishuiErrorCode = (value: unknown) => String(value ?? '').trim().toLowerCase().replace(/[_\s]+/g, '-');

// 上游用的是自己的错误词表，落到 ProviderErrorCode 之外的类型会直接导致类型检查失败，
// 所以未知错误码一律折算成 Omni 已经会展示的最接近的那个。
export const toQishuiErrorCode = (code: unknown): ProviderErrorCode => {
    const dashed = normalizeQishuiErrorCode(code);
    if (PROVIDER_ERROR_CODES.has(dashed as ProviderErrorCode)) return dashed as ProviderErrorCode;
    const upper = dashed.toUpperCase().replace(/-/g, '_');
    if (REQUEST_ERROR_CODES.has(upper) || /QR_TOKEN_REQUIRED/.test(upper)) return 'invalid-response';
    if (AUTH_ERROR_CODES.has(upper) || /(^|_)LOGIN(_|$)|COOKIE_REQUIRED|TOKEN_REQUIRED/.test(upper)) return 'auth-required';
    if (/MISSING_|_EMPTY|NOT_FOUND|INCOMPLETE|_FAILED/.test(upper)) return 'invalid-response';
    // 手机端点「取消登录」时主进程用 mfa-cancelled 抛错：这不是环境不可用，而是本次登录作废，
    // 归到 auth-required，登录弹窗才会走「可以立刻重试、不给诊断入口」那条分支。
    if (upper === 'MFA_CANCELLED' || upper === 'MFA_CANCELED') return 'auth-required';
    return 'unavailable';
};

// 服务器形态的请求：响应与 IPC 是同一个信封，所以下面的错误映射两条路完全共用。
const requestQishuiServer = async <T>(base: string, operation: QishuiOperation, params: QishuiParams): Promise<T> => {
    const token = readServerEnv('VITE_QISHUI_API_TOKEN');
    let response: Response;
    try {
        response = await fetch(`${base}/rpc/${encodeURIComponent(operation)}`, {
            method: 'POST',
            headers: token
                ? { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }
                : { 'Content-Type': 'application/json' },
            body: JSON.stringify(params),
        });
    } catch {
        // 进程没起 / 地址写错 / 被挡：都算 network，消息里带上 base，日志里一眼能看出在打哪儿。
        throw new OnlineProviderError('network', `Qishui server unreachable (${base})`, 'qishui', 'server-unreachable');
    }
    // 401 是「设备令牌不对」，不是汽水账号没登录：归到 auth-required 会弹出扫码框，而扫码救不了它。
    if (response.status === 401) {
        throw new OnlineProviderError('unavailable', 'Qishui server rejected the device token (check VITE_QISHUI_API_TOKEN)', 'qishui', 'server-auth-required');
    }
    let payload: QishuiBridgeResult;
    try { payload = await response.json() as QishuiBridgeResult; }
    catch { throw new OnlineProviderError('invalid-response', `Qishui server returned HTTP ${response.status}`, 'qishui'); }
    // 400/403/404/503 也带信封（例如 403 会写明是音频 host 白名单拒的），里面的 code 比 HTTP 状态更具体。
    if (!payload.ok) throw new OnlineProviderError(toQishuiErrorCode(payload.error.code), payload.error.message, 'qishui', payload.error.code);
    return payload.data as T;
};

/**
 * 服务器形态专属：客户端放不了 AAC 时（能力探针说的，不是 canPlayType 说的）给音频地址打上
 * `fmt=mp3`，让服务器按需转码。桌面 Electron 走 IPC 桥，地址是桥自己的 loopback、不含 `/a?`，
 * 所以永远不会被碰到；能放 AAC 的浏览器（iOS Safari、真 Chrome）也保持原样、零成本。
 */
const withAudioFormatFallback = async <T>(data: T): Promise<T> => {
    if (!data || typeof data !== 'object') return data;
    const payload = data as { url?: unknown; localProxy?: unknown };
    if (payload.localProxy !== true || typeof payload.url !== 'string' || !payload.url.includes('/a?')) return data;
    if (!(await shouldRequestTranscodedAudio())) return data;
    return { ...(data as Record<string, unknown>), url: payload.url + '&fmt=mp3' } as T;
};

export async function requestQishui<T = unknown>(operation: QishuiOperation, params: QishuiParams = {}): Promise<T> {
    if (hasDesktopBridge()) {
        let result: QishuiBridgeResult;
        try { result = await window.electron!.qishuiRequest(operation, params); }
        catch { throw new OnlineProviderError('network', 'Qishui desktop request failed', 'qishui'); }
        // 原始错误码随 cause 一起带出：映射会丢掉 `mfa-cancelled` 这类上游专有词，调用方偶尔需要它。
        if (!result.ok) throw new OnlineProviderError(toQishuiErrorCode(result.error.code), result.error.message, 'qishui', result.error.code);
        return result.data as T;
    }
    const base = getServerBase();
    if (!base) {
        throw new OnlineProviderError('unavailable', 'Qishui Music requires the desktop app or VITE_QISHUI_API_BASE', 'qishui');
    }
    const data = await requestQishuiServer<T>(base, operation, params);
    return operation === 'song.url' ? await withAudioFormatFallback(data) : data;
}

// 汽水的 handler 也会用 200 + `error` 字段来拒绝请求；不在这里抛，调用方会把拒绝当成空结果页。
export function throwQishuiDataError(data: unknown): void {
    const record = data && typeof data === 'object' ? data as Record<string, unknown> : {};
    if (!record.error) return;
    throw new OnlineProviderError(toQishuiErrorCode(record.error), String(record.message || record.error), 'qishui');
}
