import type { TFunction } from 'i18next';
import { describe, expect, it } from 'vitest';
import type { LibraryLoginSessionSnapshot, LibraryProviderSwitchRequest } from '@/library/core/contracts/account';
import { translateLoginSession, translateProviderSwitch } from '@/library/core/bindings/useLibraryAccount';
import { resolveLoginBackendState, resolveLoginSessionCopy } from '@/library/core/model/accountRules';
import type { ProviderAccountSummary } from '@/types/onlineMusic';
import {
    canRunLogout,
    projectAccountSwitcherRows,
    projectBravaisFailureHelp,
    projectBravaisLoginForm,
    projectBravaisSelfCheck,
    resolveBravaisAccountForm,
} from '@/library/suites/bravais/bravaisAccountModel';
import { resolveSeamTarget, resolveStageSeamTarget, resolveVariantWidth } from '@/library/suites/bravais/bravaisSeamTarget';

// test/unit/library/bravais/bravaisAccountModel.test.ts
// B10 账户的纯投影：缝里的登录态（二维码位的四种形态、状态行与语气、选方式的两步、重试与冷却秒数、后端故障换成原因与
// 重启、失败帮助按声明——简单办法、自检摘要、收起的诊断与反馈）、确认态与它对登录态的优先、登录界面不该显示的阶段；首页窄缝切换器的行（当前、账户状态、选它会做什么、
// 只有当前且已登录的平台能登出、登出在途时禁用）；缝的开口（登录 / 确认压过层上的一切，拉到完整宽度）。

const t = ((key: string, values?: Record<string, unknown>) => (
    values ? `${key}${JSON.stringify(values)}` : key
)) as unknown as TFunction;

const FEATURES = { diagnostics: true, backendRestart: true };
const NO_FEATURES = { diagnostics: false, backendRestart: false };
const HEALTHY = { supported: true, status: 'running' as const, error: null, restarting: false };

type SessionInput = Partial<Omit<LibraryLoginSessionSnapshot, 'copy' | 'backend'>> & {
    backendHealth?: Parameters<typeof resolveLoginBackendState>[1];
};

const session = ({ backendHealth = HEALTHY, ...input }: SessionInput = {}): LibraryLoginSessionSnapshot => {
    const providerId = input.providerId ?? 'gamma';
    const base = {
        id: 7,
        providerId,
        phase: 'waiting' as const,
        methods: [],
        selectedMethodId: null,
        qrImageUrl: 'data:image/png;base64,key-1',
        failure: null,
        retryCooldownSeconds: null,
        ...input,
        selfCheck: input.selfCheck ?? null,
        backend: resolveLoginBackendState(providerId, backendHealth),
    };
    return { ...base, copy: resolveLoginSessionCopy(base) };
};

const view = (input?: SessionInput) => translateLoginSession(t, session(input));

const QQ_METHODS = [
    { id: 'qq', labelKey: 'qq.method', iconKey: 'qq' },
    { id: 'wechat', labelKey: 'wechat.method', iconKey: 'wechat' },
];

describe('projectBravaisLoginForm', () => {
    it('shows the QR, the status line and no secondary buttons while waiting', () => {
        const form = projectBravaisLoginForm(view(), FEATURES);
        expect(form).toMatchObject({
            kind: 'login',
            providerId: 'gamma',
            sessionId: 7,
            phase: 'waiting',
            title: 'home.loginTitle',
            status: 'home.scanQr',
            tone: 'normal',
            qr: { kind: 'image', url: 'data:image/png;base64,key-1' },
            methods: null,
            retry: null,
            restart: null,
            failureHelp: null,
            closeLabel: 'home.closeLogin',
        });
        expect(projectBravaisLoginForm(view({ phase: 'loading', qrImageUrl: '' }), FEATURES).qr).toEqual({ kind: 'loading' });
        expect(projectBravaisLoginForm(view({ phase: 'scanned' }), FEATURES).status).toBe('home.qrScanned');
    });

    it('asks for a sign-in method first: a placeholder instead of a QR, no status, no retry', () => {
        const form = projectBravaisLoginForm(view({ phase: 'choosing-method', methods: QQ_METHODS, qrImageUrl: '' }), FEATURES);
        expect(form.qr).toEqual({ kind: 'choose-method', text: 'home.qqLoginMethodPending' });
        expect(form.status).toBeNull();
        expect(form.retry).toBeNull();
        expect(form.methods).toEqual({
            title: 'home.qqLoginMethodTitle',
            hint: 'home.qqLoginMethodHint',
            current: null,
            options: [
                { id: 'qq', label: 'qq.method', iconKey: 'qq', selected: false },
                { id: 'wechat', label: 'wechat.method', iconKey: 'wechat', selected: false },
            ],
        });
        // 选过之后：二维码出来，「当前方式」说明出现，选中的那项按下。
        const chosen = projectBravaisLoginForm(view({ methods: QQ_METHODS, selectedMethodId: 'wechat' }), FEATURES);
        expect(chosen.qr.kind).toBe('image');
        expect(chosen.methods?.current).toBe('home.qqLoginMethodCurrent{"method":"wechat.method"}');
        expect(chosen.methods?.options.map(option => option.selected)).toEqual([false, true]);
    });

    it('offers retry after an expiry or a failure; a scanned-then-failed session reads as an error', () => {
        const expired = projectBravaisLoginForm(view({ phase: 'expired' }), FEATURES);
        expect(expired.retry).toEqual({ label: 'home.retryQr', disabled: false, cooldownSeconds: null });
        expect(expired.tone).toBe('normal');
        // 没扫过码的过期不算失败：没有失败帮助。
        expect(expired.failureHelp).toBeNull();

        const failed = projectBravaisLoginForm(view({ phase: 'expired', failure: 'expired-after-scan' }), FEATURES);
        expect(failed.tone).toBe('error');
        // 扫过码才过期的那句提示在收起的诊断与反馈里。
        expect(failed.failureHelp?.escalation.prompt).toBe('home.qrDiagnosticsPromptScanned');
        expect(projectBravaisLoginForm(view({ phase: 'error', failure: 'check-error' }), FEATURES)).toMatchObject({
            tone: 'error',
            status: 'home.loginError',
            failureHelp: { escalation: { label: 'home.qrDiagnosticsToggle', prompt: 'home.qrDiagnosticsPrompt' } },
        });
        expect(projectBravaisLoginForm(view({ phase: 'confirmed' }), FEATURES).tone).toBe('success');
    });

    it('keeps the retry button but disables it during the backend cooldown, with the seconds', () => {
        const form = projectBravaisLoginForm(view({ phase: 'error', failure: 'canceled-on-device', retryCooldownSeconds: 12 }), FEATURES);
        expect(form.retry).toEqual({ label: 'home.retryQr', disabled: true, cooldownSeconds: 12 });
        expect(form.status).toBe('home.qrCanceledOnDeviceCooldown{"seconds":12}');
        // 手机上取消是用户自己的操作：不给失败帮助。
        expect(form.failureHelp).toBeNull();
    });

    it('leaves the failure help and the backend restart out unless the suite declares them', () => {
        expect(projectBravaisLoginForm(view({ phase: 'error', failure: 'check-error' }), NO_FEATURES).failureHelp).toBeNull();
        // QQ 和别的平台一样给（什么时候给由 core 的 canShowLoginDiagnostics 决定，不按 provider 判断）。
        expect(projectBravaisLoginForm(view({ providerId: 'qq', phase: 'error', failure: 'check-error' }), FEATURES).failureHelp)
            .toMatchObject({ escalation: { prompt: 'home.qrDiagnosticsPrompt' } });
        const down = { supported: true, status: 'error' as const, error: 'xeapi key missing', restarting: false };
        expect(projectBravaisLoginForm(view({ providerId: 'netease', phase: 'error', failure: 'start-error', backendHealth: down }), NO_FEATURES).restart)
            .toBeNull();
    });

    it('replaces the QR with the cause and a restart when the NetEase backend is down', () => {
        const down = { supported: true, status: 'error' as const, error: 'xeapi key missing', restarting: false };
        const form = projectBravaisLoginForm(view({ providerId: 'netease', phase: 'error', failure: 'start-error', qrImageUrl: '', backendHealth: down }), FEATURES);
        expect(form.qr).toEqual({ kind: 'backend-failure', title: 'home.loginBackendDown', detail: 'xeapi key missing' });
        expect(form.status).toBeNull();
        expect(form.retry).toBeNull();
        // 后端没拉起来时也给失败帮助：重启解决不了时，报告里有拉起的每一步与错误原文。
        expect(form.failureHelp?.escalation.prompt).toBe('home.qrDiagnosticsPrompt');
        expect(form.restart).toEqual({ label: 'home.restartBackend', restarting: false });
        const restarting = projectBravaisLoginForm(
            view({ providerId: 'netease', phase: 'error', failure: 'start-error', backendHealth: { ...down, restarting: true } }),
            FEATURES,
        );
        expect(restarting.restart).toEqual({ label: 'home.restartingBackend', restarting: true });
    });
});

describe('the failure help in the login form', () => {
    it('puts the simple fixes first, then the automatic check, and folds the diagnostics behind "still not working?"', () => {
        const help = projectBravaisFailureHelp(view({ phase: 'error', failure: 'connection-reset' }), FEATURES);
        expect(help).toEqual({
            tips: { title: 'home.qrTipsTitle', items: ['home.qrTipRestart', 'home.qrTipSwitchNetwork'] },
            selfCheck: null,
            escalation: { label: 'home.qrDiagnosticsToggle', prompt: 'home.qrDiagnosticsPrompt' },
        });
        // 没有失败形态、或 suite 没声明诊断：没有。
        expect(projectBravaisFailureHelp(view({ phase: 'error' }), FEATURES)).toBeNull();
        expect(projectBravaisFailureHelp(view({ phase: 'error', failure: 'connection-reset' }), NO_FEATURES)).toBeNull();
    });

    it('shows the automatic check while it runs, its error, or its verdict with the per-layer results', () => {
        const running = projectBravaisFailureHelp(view({ phase: 'error', failure: 'check-error', selfCheck: { status: 'running' } }), FEATURES);
        expect(running?.selfCheck).toEqual({
            state: 'running',
            title: 'home.qrSelfCheckTitle',
            summary: 'home.qrSelfCheckRunning',
            proxyNote: null,
            items: [],
        });
        expect(projectBravaisSelfCheck({
            title: 'Check', running: false, runningText: 'Checking…', verdict: null, proxyNote: null, error: 'could not finish', items: [],
        })).toEqual({ state: 'failed', title: 'Check', summary: 'could not finish', proxyNote: null, items: [] });
        expect(projectBravaisSelfCheck(null)).toBeNull();
    });

    it('keeps the error code and host after a failed or warned layer, and only the label for a passed one', () => {
        const projected = projectBravaisSelfCheck({
            title: 'Check',
            running: false,
            runningText: 'Checking…',
            verdict: 'Cut during the TLS handshake',
            proxyNote: 'A proxy is on',
            error: null,
            items: [
                { id: 'dns', state: 'ok', detail: null, label: 'DNS' },
                { id: 'ipv4', state: 'fail', detail: 'probe.example: ECONNRESET (tls)', label: 'IPv4 connection' },
                { id: 'clock', state: 'warn', detail: '+5 min', label: 'System clock' },
            ],
        });
        expect(projected).toEqual({
            state: 'done',
            title: 'Check',
            summary: 'Cut during the TLS handshake',
            proxyNote: 'A proxy is on',
            items: [
                { id: 'dns', state: 'ok', text: 'DNS', title: 'DNS' },
                { id: 'ipv4', state: 'fail', text: 'IPv4 connection: probe.example: ECONNRESET (tls)', title: 'IPv4 connection: probe.example: ECONNRESET (tls)' },
                { id: 'clock', state: 'warn', text: 'System clock: +5 min', title: 'System clock: +5 min' },
            ],
        });
    });
});

describe('resolveBravaisAccountForm', () => {
    const labels = { confirm: 'Switch', cancel: 'Cancel' };
    const providers = [{ providerId: 'beta', shortName: 'Beta', displayName: 'Beta Music' }] as ProviderAccountSummary[];
    const request: LibraryProviderSwitchRequest = { id: 3, from: 'alpha', to: 'beta', reason: 'switch' };
    const pending = translateProviderSwitch(t, request, providers);

    it('projects a pending switch into the confirm form and puts it before a login', () => {
        const confirm = {
            kind: 'confirm',
            requestId: 3,
            providerId: 'beta',
            reason: 'switch',
            title: 'home.switchOnlineProvider',
            description: 'home.confirmOnlineProviderSwitch{"provider":"Beta"}',
            confirmLabel: 'Switch',
            cancelLabel: 'Cancel',
        };
        expect(resolveBravaisAccountForm({ login: null, pendingSwitch: pending, features: FEATURES, confirmLabels: labels })).toEqual(confirm);
        expect(resolveBravaisAccountForm({ login: view(), pendingSwitch: pending, features: FEATURES, confirmLabels: labels })).toEqual(confirm);
    });

    it('shows a login only while the login interface should be visible', () => {
        expect(resolveBravaisAccountForm({ login: view(), pendingSwitch: null, features: FEATURES, confirmLabels: labels })?.kind).toBe('login');
        for (const phase of ['resolving-methods', 'confirmed'] as const) {
            expect(resolveBravaisAccountForm({ login: view({ phase }), pendingSwitch: null, features: FEATURES, confirmLabels: labels })).toBeNull();
        }
        expect(resolveBravaisAccountForm({ login: null, pendingSwitch: null, features: FEATURES, confirmLabels: labels })).toBeNull();
    });
});

const provider = (providerId: string, input: Partial<ProviderAccountSummary> = {}): ProviderAccountSummary => ({
    providerId,
    displayName: `${providerId} display`,
    shortName: providerId.toUpperCase(),
    availability: { configured: true },
    status: 'anonymous',
    user: null,
    collections: [],
    ...input,
});

describe('projectAccountSwitcherRows', () => {
    const providers = [
        provider('alpha', { status: 'authenticated', user: { id: 1, nickname: 'Ada', avatarUrl: 'http://img.example/ada.jpg' } as ProviderAccountSummary['user'] }),
        provider('beta', { status: 'authenticated', user: { id: 2, nickname: 'Bea' } as ProviderAccountSummary['user'] }),
        provider('gamma'),
        provider('modo', { requiresAccount: false, status: 'unknown' }),
        provider('off', { availability: { configured: false, reason: 'not-configured' } }),
        provider('gone', { availability: { configured: false, reason: 'runtime-unavailable' } }),
    ];
    const idle = { providerId: null, status: 'idle' as const };

    it('lists every usable provider with the current mark, the account status and what picking it does', () => {
        const rows = projectAccountSwitcherRows({ providers, activeProviderId: 'alpha', logout: idle, t });
        // 运行时不可用的不列（与 grid 的切换器一致）。
        expect(rows.map(row => row.providerId)).toEqual(['alpha', 'beta', 'gamma', 'modo', 'off']);
        expect(rows.map(row => row.current)).toEqual([true, false, false, false, false]);
        expect(rows.map(row => row.detail)).toEqual([
            'Ada', 'Bea', 'libraryBravaisAccount.notSignedIn', 'home.providerNoAccount', 'libraryBravaisAccount.notConfigured',
        ]);
        // fb8：界面上只显示区分所必需的小字（昵称、无需登录、未配置）；「未登录」不写字（行尾是登录图标）。
        expect(rows.map(row => row.note)).toEqual(['Ada', 'Bea', '', 'home.providerNoAccount', 'libraryBravaisAccount.notConfigured']);
        expect(rows.map(row => row.nickname)).toEqual(['Ada', 'Bea', null, null, null]);
        expect(rows.map(row => row.avatarUrl)).toEqual(['http://img.example/ada.jpg', null, null, null, null]);
        expect(rows.map(row => row.direct)).toEqual([true, true, false, true, false]);
        expect(rows.map(row => row.configured)).toEqual([true, true, true, true, false]);
        expect(rows.map(row => row.actionLabel)).toEqual([
            '',
            'home.switchToProvider{"provider":"BETA"}',
            'home.loginToProvider{"provider":"GAMMA"}',
            'home.switchToProvider{"provider":"MODO"}',
            '',
        ]);
    });

    it('offers logout only on the current signed-in provider (canLogoutProvider)', () => {
        const rows = projectAccountSwitcherRows({ providers, activeProviderId: 'alpha', logout: idle, t });
        expect(rows.filter(row => row.logout).map(row => row.providerId)).toEqual(['alpha']);
        expect(rows[0].logout).toEqual({ label: 'account.logout', disabled: false });
        expect(canRunLogout(rows[0])).toBe(true);
        expect(canRunLogout(rows[1])).toBe(false);
        // 当前平台未登录 / 无账户：没有登出。
        expect(projectAccountSwitcherRows({ providers, activeProviderId: 'gamma', logout: idle, t }).some(row => row.logout)).toBe(false);
        expect(projectAccountSwitcherRows({ providers, activeProviderId: 'modo', logout: idle, t }).some(row => row.logout)).toBe(false);
    });

    it('disables logout while one is pending and says which one is signing out', () => {
        const rows = projectAccountSwitcherRows({ providers, activeProviderId: 'alpha', logout: { providerId: 'alpha', status: 'pending' }, t });
        expect(rows[0].logout).toEqual({ label: 'libraryBravaisAccount.loggingOut', disabled: true });
        expect(canRunLogout(rows[0])).toBe(false);
    });
});

describe('the seam opening for the account forms', () => {
    const input = { surface: 'home' as const, level: 'hidden' as const, viewportWidth: 1440 };

    it('pulls the seam to the full width for a login or a confirm, whatever the layer and the level', () => {
        expect(resolveSeamTarget(input)).toEqual({ width: 0, variant: 'none' });
        expect(resolveStageSeamTarget(input, null)).toEqual(resolveSeamTarget(input));
        expect(resolveStageSeamTarget(input, 'login')).toEqual({ width: 300, variant: 'login' });
        expect(resolveStageSeamTarget({ surface: 'collection', level: 'spine', viewportWidth: 1440, formOpen: true, panelOpen: true }, 'confirm'))
            .toEqual({ width: 300, variant: 'confirm' });
        expect(resolveVariantWidth('login', 1440)).toBe(300);
        expect(resolveVariantWidth('confirm', 600)).toBe(300);
    });
});
