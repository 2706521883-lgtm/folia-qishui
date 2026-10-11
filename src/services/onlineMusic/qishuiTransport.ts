import type { ProviderErrorCode } from '../../types/onlineMusic';
import { OnlineProviderError } from '../../types/onlineMusic';

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

export const getQishuiTransportAvailability = () => (
    typeof window !== 'undefined' && typeof window.electron?.qishuiRequest === 'function'
        ? { configured: true } as const
        : { configured: false, reason: 'runtime-unavailable' } as const
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

export async function requestQishui<T = unknown>(operation: QishuiOperation, params: QishuiParams = {}): Promise<T> {
    if (!getQishuiTransportAvailability().configured) {
        throw new OnlineProviderError('unavailable', 'Qishui Music requires the desktop app', 'qishui');
    }
    let result: QishuiBridgeResult;
    try { result = await window.electron!.qishuiRequest(operation, params); }
    catch { throw new OnlineProviderError('network', 'Qishui desktop request failed', 'qishui'); }
    // 原始错误码随 cause 一起带出：映射会丢掉 `mfa-cancelled` 这类上游专有词，调用方偶尔需要它。
    if (!result.ok) throw new OnlineProviderError(toQishuiErrorCode(result.error.code), result.error.message, 'qishui', result.error.code);
    return result.data as T;
}

// 汽水的 handler 也会用 200 + `error` 字段来拒绝请求；不在这里抛，调用方会把拒绝当成空结果页。
export function throwQishuiDataError(data: unknown): void {
    const record = data && typeof data === 'object' ? data as Record<string, unknown> : {};
    if (!record.error) return;
    throw new OnlineProviderError(toQishuiErrorCode(record.error), String(record.message || record.error), 'qishui');
}
