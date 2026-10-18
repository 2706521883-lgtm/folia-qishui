import { describe, expect, it, vi } from 'vitest';

// test/unit/electron/qqRecommendRoute.test.ts
// QQ 推荐流路由：把 qq-music-api 的 UCommon 包成 /getPersonalFm，先猜你喜欢、空结果退回雷达。
// 这里只测路由自身的协议与降级；真实的 QQ 会话与上游响应由桌面端的 live 验证覆盖。

const {
    QQ_PERSONAL_FM_PATH,
    buildRadioPayload,
    buildRadarPayload,
    readRadioTracks,
    readRadarTracks,
    createPersonalFmHandler,
    registerQqPersonalFmRoute,
} = require('../../../electron/qqRecommendRoute.cjs') as {
    QQ_PERSONAL_FM_PATH: string;
    buildRadioPayload: (options: { limit: number; offset: number }) => any;
    buildRadarPayload: (options: { page: number }) => any;
    readRadioTracks: (response: any) => any[];
    readRadarTracks: (response: any) => { tracks: any[]; hasMore: boolean };
    createPersonalFmHandler: (options: { services: any; logger?: any }) => (ctx: any) => Promise<void>;
    registerQqPersonalFmRoute: (options: { router: any; services: any; logger?: any }) => boolean;
};

const ctx = (query: Record<string, string> = {}) => ({ query, status: 200, body: null as any });

const uCommonReturning = (...values: any[]) => {
    const mock = vi.fn();
    values.forEach(value => {
        if (value instanceof Error) mock.mockRejectedValueOnce(value);
        else mock.mockResolvedValueOnce(value);
    });
    return mock;
};

const radioResponse = (tracks: any[]) => ({
    data: {
        'music.radioProxy.MbTrackRadioSvr': { data: { tracks } },
    },
});

const radarResponse = (tracks: any[], hasMore = true) => ({
    data: {
        'music.recommend.TrackRelationServer': {
            data: {
                VecSongs: tracks.map(track => ({ Track: track })),
                HasMore: hasMore,
            },
        },
    },
});

describe('qqRecommendRoute', () => {
    it('builds the upstream payloads used by the QQ recommendation modules', () => {
        expect(buildRadioPayload({ limit: 5, offset: 10 })).toMatchObject({
            'music.radioProxy.MbTrackRadioSvr': {
                module: 'music.radioProxy.MbTrackRadioSvr',
                method: 'get_radio_track',
                param: { id: 99, num: 5, from: 10, scene: 0, song_ids: [] },
            },
        });
        expect(buildRadarPayload({ page: 3 })).toMatchObject({
            'music.recommend.TrackRelationServer': {
                method: 'GetRadarSong',
                param: { Page: 3, ReqType: 0, FavSongs: [], EntranceSongs: [] },
            },
        });
    });

    it('reads tracks from both upstream response shapes', () => {
        expect(readRadioTracks(radioResponse([{ mid: 'a' }]))).toEqual([{ mid: 'a' }]);
        expect(readRadarTracks(radarResponse([{ mid: 'b' }], false))).toEqual({ tracks: [{ mid: 'b' }], hasMore: false });
    });

    it('serves 猜你喜欢 first and clamps the requested window', async () => {
        const UCommon = uCommonReturning(radioResponse([{ mid: 'a' }, { mid: 'b' }]));
        const handler = createPersonalFmHandler({ services: { UCommon } });
        const context = ctx({ num: '999', from: '-8' });

        await handler(context);

        expect(context.status).toBe(200);
        expect(context.body).toEqual({
            response: { tracks: [{ mid: 'a' }, { mid: 'b' }], source: 'radio', hasMore: true, nextFrom: 2 },
        });
        const request = UCommon.mock.calls[0][0];
        const payload = JSON.parse(request.params.data);
        expect(payload['music.radioProxy.MbTrackRadioSvr'].param).toMatchObject({ num: 50, from: 0 });
    });

    it('falls back to 雷达推荐 when 猜你喜欢 returns no tracks', async () => {
        const UCommon = uCommonReturning(radioResponse([]), radarResponse([{ mid: 'r1' }], true));
        const handler = createPersonalFmHandler({ services: { UCommon } });
        const context = ctx({ num: '20', from: '40' });

        await handler(context);

        expect(context.body).toEqual({
            response: { tracks: [{ mid: 'r1' }], source: 'radar', hasMore: true, nextFrom: 41, nextPage: 6 },
        });
        const radarPayload = JSON.parse(UCommon.mock.calls[1][0].params.data);
        expect(radarPayload['music.recommend.TrackRelationServer'].param.Page).toBe(5);
    });

    it('uses an explicit radar page when the caller passes one', async () => {
        const UCommon = uCommonReturning(radioResponse([]), radarResponse([{ mid: 'r4' }], true));
        const handler = createPersonalFmHandler({ services: { UCommon } });
        const context = ctx({ num: '10', from: '0', page: '4' });

        await handler(context);

        expect(context.body.response).toMatchObject({ source: 'radar', nextPage: 5 });
        const radarPayload = JSON.parse(UCommon.mock.calls[1][0].params.data);
        expect(radarPayload['music.recommend.TrackRelationServer'].param.Page).toBe(4);
    });

    it('returns an empty batch instead of failing the backend when both sources are unavailable', async () => {
        const UCommon = uCommonReturning(new Error('radio down'), new Error('radar down'));
        const logger = { warn: vi.fn() };
        const handler = createPersonalFmHandler({ services: { UCommon }, logger });
        const context = ctx({ num: '5', from: '5' });

        await handler(context);

        expect(context.status).toBe(200);
        expect(context.body).toEqual({
            response: { tracks: [], source: 'unavailable', hasMore: false, nextFrom: 5, nextPage: 1 },
        });
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('personal FM unavailable'), expect.any(String));
    });

    it('registers the route once on the package router', () => {
        const routes = new Map<string, unknown>();
        const router = { get: vi.fn((path: string, handler: unknown) => routes.set(path, handler)) };
        const services = { UCommon: vi.fn() };

        expect(registerQqPersonalFmRoute({ router, services })).toBe(true);
        expect(registerQqPersonalFmRoute({ router, services })).toBe(true);

        expect(router.get).toHaveBeenCalledTimes(1);
        expect(router.get).toHaveBeenCalledWith(QQ_PERSONAL_FM_PATH, expect.any(Function));
        expect(routes.has(QQ_PERSONAL_FM_PATH)).toBe(true);
    });
});
