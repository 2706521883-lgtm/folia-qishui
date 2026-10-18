// electron/qqRecommendRoute.cjs
//
// QQ 音乐的推荐流（首页缝里的「推荐流」）。
//
// qq-music-api 3.1.4 没有暴露私人 FM / 猜你喜欢的路由，但它的服务层导出 UCommon，
// 可以按上游 musicu.fcg 的协议直接发模块请求。这里在它启动时往同一个 Koa router 上补一条：
//
//   GET /getPersonalFm?num=20&from=0
//
// 先走「猜你喜欢」（music.radioProxy.MbTrackRadioSvr / get_radio_track，from 偏移）；
// 上游空结果时退回「雷达推荐」（music.recommend.TrackRelationServer / GetRadarSong，Page 页码）。
// 两条都拿不到时返回空 tracks，让调用方的队列自然收尾，而不是把后端 500 抛给界面。
//
// 响应统一成 { response: { tracks, source, hasMore, nextFrom } }，tracks 是上游原始歌曲对象，
// 由 renderer 的 qqNormalize 正规化（与歌单 / 搜索共用同一条路径）。

const QQ_PERSONAL_FM_PATH = '/getPersonalFm';
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const DEFAULT_RADIO_ID = 99; // 猜你喜欢
// 雷达推荐上游固定一页 10 首左右；调用方传 page，老调用方只传 from 时按这个页大小折算。
const DEFAULT_RADAR_PAGE_SIZE = 10;

const clampInt = (value, min, max, fallback) => {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
};

const buildRadioPayload = ({ limit, offset }) => ({
    comm: { ct: 24, cv: 0 },
    'music.radioProxy.MbTrackRadioSvr': {
        module: 'music.radioProxy.MbTrackRadioSvr',
        method: 'get_radio_track',
        param: {
            id: DEFAULT_RADIO_ID,
            num: limit,
            from: offset,
            scene: 0,
            song_ids: [],
        },
    },
});

const buildRadarPayload = ({ page }) => ({
    comm: { ct: 24, cv: 0 },
    'music.recommend.TrackRelationServer': {
        module: 'music.recommend.TrackRelationServer',
        method: 'GetRadarSong',
        param: {
            Page: page,
            ReqType: 0,
            FavSongs: [],
            EntranceSongs: [],
        },
    },
});

const readRadioTracks = response => {
    const root = response && response.data ? response.data : {};
    const node = root['music.radioProxy.MbTrackRadioSvr'] || {};
    const payload = node.data || node;
    const tracks = payload.tracks ?? payload.songlist ?? payload.songs;
    return Array.isArray(tracks) ? tracks : [];
};

const readRadarTracks = response => {
    const root = response && response.data ? response.data : {};
    const node = root['music.recommend.TrackRelationServer'] || {};
    const payload = node.data || node;
    const entries = payload.VecSongs ?? payload.vecSongs;
    const tracks = Array.isArray(entries)
        ? entries.map(entry => (entry && entry.Track ? entry.Track : entry)).filter(Boolean)
        : [];
    return {
        tracks,
        hasMore: Boolean(payload.HasMore ?? payload.hasMore),
    };
};

const requestModule = (services, data) => services.UCommon({
    method: 'get',
    params: { format: 'json', data: JSON.stringify(data) },
    option: {},
});

const errorMessage = error => (
    error instanceof Error && error.message ? error.message : String(error || 'unknown error')
);

/**
 * 创建 /getPersonalFm 的 Koa handler。services 由 qqApiStartup 从包内解析后传入，
 * 单测可以直接给一个假的 UCommon。
 */
const createPersonalFmHandler = ({ services, logger = console } = {}) => async ctx => {
    const limit = clampInt(ctx.query.num, 1, MAX_LIMIT, DEFAULT_LIMIT);
    const offset = clampInt(ctx.query.from, 0, 100000, 0);
    const requestedPage = clampInt(ctx.query.page, 1, 10000, 0);
    const radarPage = requestedPage || Math.floor(offset / DEFAULT_RADAR_PAGE_SIZE) + 1;
    const errors = [];

    if (services && typeof services.UCommon === 'function') {
        try {
            const response = await requestModule(services, buildRadioPayload({ limit, offset }));
            const tracks = readRadioTracks(response);
            if (tracks.length > 0) {
                ctx.status = 200;
                ctx.body = {
                    response: {
                        tracks,
                        source: 'radio',
                        hasMore: true,
                        nextFrom: offset + tracks.length,
                    },
                };
                return;
            }
        } catch (error) {
            errors.push(`get_radio_track: ${errorMessage(error)}`);
        }

        try {
            const response = await requestModule(services, buildRadarPayload({ page: radarPage }));
            const { tracks, hasMore } = readRadarTracks(response);
            ctx.status = 200;
            ctx.body = {
                response: {
                    tracks,
                    source: 'radar',
                    hasMore,
                    nextFrom: offset + tracks.length,
                    nextPage: radarPage + 1,
                },
            };
            return;
        } catch (error) {
            errors.push(`GetRadarSong: ${errorMessage(error)}`);
        }
    } else {
        errors.push('qq-music-api service layer is unavailable');
    }

    // 推荐源不可用不是协议错误：记录一条精简日志，给界面一个空批次。
    logger.warn('[QQ API] personal FM unavailable:', errors.join('; '));
    ctx.status = 200;
    ctx.body = { response: { tracks: [], source: 'unavailable', hasMore: false, nextFrom: offset, nextPage: radarPage } };
};

/**
 * 把路由挂到 qq-music-api 的 router 上。路由在 app.listen 之后、第一次请求之前同步注册，
 * 所以不需要重启或改包。重复调用是幂等的。
 */
const registerQqPersonalFmRoute = ({ router, services, logger = console } = {}) => {
    if (!router || typeof router.get !== 'function') return false;
    if (router.__foliaPersonalFmRegistered) return true;
    router.get(QQ_PERSONAL_FM_PATH, createPersonalFmHandler({ services, logger }));
    router.__foliaPersonalFmRegistered = true;
    return true;
};

module.exports = {
    QQ_PERSONAL_FM_PATH,
    DEFAULT_LIMIT,
    MAX_LIMIT,
    buildRadioPayload,
    buildRadarPayload,
    readRadioTracks,
    readRadarTracks,
    createPersonalFmHandler,
    registerQqPersonalFmRoute,
};
