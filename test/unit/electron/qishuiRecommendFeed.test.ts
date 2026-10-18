import { createRequire } from 'node:module';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// test/unit/electron/qishuiRecommendFeed.test.ts
// 协议层推荐流分页的唯一可执行证据：provider 测试把 requestQishui 整个 mock 掉，
// 看不到「cursor 永远为 0 / 缓存只按 limit / 虚拟歌单 hasMore:false」这些真正根因。

const require = createRequire(import.meta.url);

type FeedSong = { id: string; providerSongId: string; name: string; cover: string; duration: number };
type FeedPage = {
    songs: FeedSong[];
    rawCount: number;
    hasMore?: boolean;
    nextCursor?: string;
    nextCursorKey?: string;
    source?: string;
};
type FeedSession = { pages: number; served: number; songs: FeedSong[]; flow: string };

const api = require('../../../electron/qishui/qishui-api.js') as {
    handleQishuiRecommendFeed: (
        opts: Record<string, unknown>,
        cookieText: string,
        deps?: { status?: unknown; fetchPage?: (session: FeedSession, limit: number) => Promise<FeedPage> },
    ) => Promise<{
        configured: boolean;
        songs: FeedSong[];
        tracks: FeedSong[];
        total?: number;
        offset: number;
        limit: number;
        nextOffset: number;
        hasMore: boolean;
        source?: string;
    }>;
    _test: {
        clearQishuiRuntimeCaches: () => void;
        extractQishuiFeedPageMeta: (payload: unknown) => { nextCursor: string; hasMore?: boolean };
        mapQishuiFeedItems: (items: unknown[], query: string, directPlayable: boolean) => Array<{ id: string }>;
        buildQishuiFeedPlaylist: (songs: unknown[]) => Record<string, unknown>;
        buildQishuiFeedWebPayload: (session: Record<string, unknown>) => Record<string, unknown>;
        QISHUI_FEED_TOTAL_CAP: number;
        qishuiRecommendFlow: (value: unknown) => string;
        qishuiRecommendFeedSessions: Map<string, Record<string, any>>;
    };
};

const bridge = require('../../../electron/qishuiApiBridge.cjs') as {
    QISHUI_OPERATIONS: string[];
    _test: { QISHUI_RESULT_FAILURES: Record<string, (result: unknown) => boolean> };
};

const { _test: t, handleQishuiRecommendFeed } = api;

const status = { configured: true, loggedIn: true, webSession: true, tokenConfigured: false };
const cookie = 'sessionid=feed-test-session';

const song = (id: string): FeedSong => ({
    id, providerSongId: id, name: `Song ${id}`, cover: '', duration: 180,
});

const pageOf = (ids: string[], hasMore = true): FeedPage => ({
    songs: ids.map(song), rawCount: ids.length, hasMore, source: 'test',
});

beforeEach(() => {
    t.clearQishuiRuntimeCaches();
});

describe('Qishui feed meta parsing', () => {
    it('reads the next cursor and has_more from the documented field families', () => {
        expect(t.extractQishuiFeedPageMeta({ data: { next_cursor: 'abc', has_more: true } }))
            .toEqual({ nextCursor: 'abc', nextCursorKey: 'next_cursor', hasMore: true });
        expect(t.extractQishuiFeedPageMeta({ data: { page_info: { load_mark: 12, hasMore: false } } }))
            .toEqual({ nextCursor: '12', nextCursorKey: 'load_mark', hasMore: false });
        expect(t.extractQishuiFeedPageMeta({ nextCursor: 'root-cursor', hasMore: true }))
            .toEqual({ nextCursor: 'root-cursor', nextCursorKey: 'nextCursor', hasMore: true });
        // 没有游标时必须是空串，不能把 undefined 写进会话。
        expect(t.extractQishuiFeedPageMeta({ data: { items: [] } }))
            .toEqual({ nextCursor: '', nextCursorKey: '', hasMore: undefined });
    });

    it('locks the reference request body: played_media continues the feed', () => {
        const first = t.buildQishuiFeedWebPayload({ pages: 0, playedMedia: [] });
        expect(first).toMatchObject({
            is_first_request: true, played_media: [], is_did_first_request: false,
            feed_counts: { mix_session_count: 1 },
        });

        const next = t.buildQishuiFeedWebPayload({
            pages: 1,
            playedMedia: [{ id: '1', type: 'track' }, { id: '2', type: 'track' }],
            cursor: 'c1',
            cursorKey: 'load_mark',
        });
        expect(next).toMatchObject({
            is_first_request: false,
            played_media: [{ id: '1', type: 'track' }, { id: '2', type: 'track' }],
            is_did_first_request: false,
            load_mark: 'c1',
        });
        expect(next).not.toHaveProperty('cursor');
    });
});

describe('Qishui feed mapping filters', () => {
    it('drops synthetic ids and non-track cards instead of inventing playable media ids', () => {
        const items = [
            { id: '1', name: 'Real track', duration: 180 },
            { name: 'No id at all', duration: 180 },
            { id: 'p1', name: 'Playlist card', type: 'playlist' },
            { id: 'm1', name: 'Mix card', type: 'mix' },
        ];
        expect(t.mapQishuiFeedItems(items, 'feed', true).map(item => item.id)).toEqual(['1']);
    });

    it('accepts the track_id field used by the reference mapper', () => {
        expect(t.mapQishuiFeedItems([{ type: 'track', track_id: 123, name: 'Track id only' }], 'feed', true)
            .map(item => item.id)).toEqual(['123']);
    });
});

describe('Qishui feed session paging', () => {
    it('advances Personal FM in distinct batches', async () => {
        const fetchPage = vi.fn(async (session: FeedSession) => {
            const from = session.pages * 2;
            return pageOf([String(from + 1), String(from + 2)]);
        });

        const first = await handleQishuiRecommendFeed(
            { limit: 2, flow: 'fm', advance: true }, cookie, { status, fetchPage },
        );
        const second = await handleQishuiRecommendFeed(
            { limit: 2, flow: 'fm', advance: true }, cookie, { status, fetchPage },
        );

        expect(first.songs.map(item => item.id)).toEqual(['1', '2']);
        expect(first.nextOffset).toBe(2);
        expect(second.songs.map(item => item.id)).toEqual(['3', '4']);
        expect(second.nextOffset).toBe(4);
        expect(fetchPage).toHaveBeenCalledTimes(2);
    });

    it('serializes concurrent advance calls so they never return the same batch', async () => {
        const fetchPage = vi.fn(async (session: FeedSession) => {
            const from = session.pages * 2;
            return pageOf([String(from + 1), String(from + 2)]);
        });
        const [first, second] = await Promise.all([
            handleQishuiRecommendFeed({ limit: 2, flow: 'fm', advance: true }, cookie, { status, fetchPage }),
            handleQishuiRecommendFeed({ limit: 2, flow: 'fm', advance: true }, cookie, { status, fetchPage }),
        ]);
        const ids = [...first.songs, ...second.songs].map(item => item.id);
        expect(new Set(ids).size).toBe(4);
        expect(ids.sort()).toEqual(['1', '2', '3', '4']);
    });

    it('ignores advance on non-FM flows', async () => {
        const fetchPage = vi.fn(async () => pageOf(['1', '2']));
        const peek = await handleQishuiRecommendFeed(
            { limit: 2, flow: 'peek', advance: true }, cookie, { status, fetchPage },
        );
        expect(peek.songs.map(item => item.id)).toEqual(['1', '2']);
        expect(peek.nextOffset).toBe(0);
    });

    it('propagates the cursor field name through the session', async () => {
        const fetchPage = vi.fn(async () => ({
            songs: [song('1')], rawCount: 1, hasMore: true,
            nextCursor: 'c1', nextCursorKey: 'load_mark', source: 'test',
        }));
        await handleQishuiRecommendFeed({ limit: 1, flow: 'fm', advance: true }, cookie, { status, fetchPage });
        const session = [...t.qishuiRecommendFeedSessions.values()][0];
        expect(session.cursor).toBe('c1');
        expect(session.cursorKey).toBe('load_mark');
    });

    it('restarts an exhausted FM segment instead of livelocking on repeats', async () => {
        const fetchPage = vi.fn(async () => pageOf(['1', '2']));
        const first = await handleQishuiRecommendFeed(
            { limit: 2, flow: 'fm', advance: true }, cookie, { status, fetchPage },
        );
        expect(first.songs.map(item => item.id)).toEqual(['1', '2']);

        const second = await handleQishuiRecommendFeed(
            { limit: 2, flow: 'fm', advance: true }, cookie, { status, fetchPage },
        );
        expect(second.songs).toEqual([]);

        const session = [...t.qishuiRecommendFeedSessions.values()][0];
        session.cooldownUntil = 0;
        const third = await handleQishuiRecommendFeed(
            { limit: 2, flow: 'fm', advance: true }, cookie, { status, fetchPage },
        );
        expect(third.songs.map(item => item.id)).toEqual(['1', '2']);
    });

    it('reports no more when a playlist page yields no songs', async () => {
        const fetchPage = vi.fn(async () => pageOf(['1', '2']));
        await handleQishuiRecommendFeed(
            { limit: 2, offset: 0, flow: 'playlist', advance: false }, cookie, { status, fetchPage },
        );
        const empty = await handleQishuiRecommendFeed(
            { limit: 2, offset: 2, flow: 'playlist', advance: false }, cookie, { status, fetchPage },
        );
        expect(empty.songs).toEqual([]);
        expect(empty.hasMore).toBe(false);
    });

    it('keeps nextOffset monotonic after trimming the FM buffer', async () => {
        const fetchPage = vi.fn(async () => pageOf(['x']));
        await handleQishuiRecommendFeed({ limit: 1, flow: 'fm', advance: true }, cookie, { status, fetchPage });
        const session = [...t.qishuiRecommendFeedSessions.values()][0];
        session.served = 320;
        session.totalServed = 320;
        const buffered = Array.from({ length: 340 }, (_, index) => song('t' + index));
        session.songs = buffered;
        session.seen = new Set(buffered.map(item => item.id));
        session.hasMore = true;

        const page = await handleQishuiRecommendFeed(
            { limit: 20, flow: 'fm', advance: true }, cookie, { status, fetchPage },
        );
        expect(page.songs).toHaveLength(20);
        expect(page.offset).toBe(320);
        expect(page.nextOffset).toBe(340);
        expect(page.nextOffset).toBeGreaterThan(page.offset);
    });

    it('peeks the next FM batch without consuming it', async () => {
        const fetchPage = vi.fn(async (session: FeedSession) => {
            const from = session.pages * 2;
            return pageOf([String(from + 1), String(from + 2)]);
        });
        await handleQishuiRecommendFeed({ limit: 2, flow: 'fm', advance: true }, cookie, { status, fetchPage });

        const preview = await handleQishuiRecommendFeed(
            { limit: 2, flow: 'fm', advance: false }, cookie, { status, fetchPage },
        );
        expect(preview.songs.map(item => item.id)).toEqual(['3', '4']);
        expect(preview.nextOffset).toBe(2);

        // 预览没有推进 served，真正的播放仍然拿到同一批。
        const consumed = await handleQishuiRecommendFeed(
            { limit: 2, flow: 'fm', advance: true }, cookie, { status, fetchPage },
        );
        expect(consumed.songs.map(item => item.id)).toEqual(['3', '4']);
        expect(consumed.nextOffset).toBe(4);
    });

    it('pages the virtual playlist by offset and stops at the finite cap', async () => {
        const fetchPage = vi.fn(async (session: FeedSession) => {
            const from = session.pages * 4;
            return pageOf([1, 2, 3, 4].map(step => String(from + step)));
        });

        const first = await handleQishuiRecommendFeed(
            { limit: 4, offset: 0, flow: 'playlist', advance: false }, cookie, { status, fetchPage },
        );
        expect(first.songs.map(item => item.id)).toEqual(['1', '2', '3', '4']);
        expect(first).toMatchObject({ total: t.QISHUI_FEED_TOTAL_CAP, nextOffset: 4, hasMore: true });

        const second = await handleQishuiRecommendFeed(
            { limit: 4, offset: 4, flow: 'playlist', advance: false }, cookie, { status, fetchPage },
        );
        expect(second.songs.map(item => item.id)).toEqual(['5', '6', '7', '8']);
        expect(second.nextOffset).toBe(8);

        fetchPage.mockClear();
        const beyond = await handleQishuiRecommendFeed(
            { limit: 50, offset: t.QISHUI_FEED_TOTAL_CAP, flow: 'playlist', advance: false }, cookie, { status, fetchPage },
        );
        expect(beyond).toMatchObject({ songs: [], hasMore: false, nextOffset: t.QISHUI_FEED_TOTAL_CAP });
        expect(fetchPage).not.toHaveBeenCalled();
    });

    it('rebuilds a fresh/expired session when an offset page is requested', async () => {
        const fetchPage = vi.fn(async (session: FeedSession) => {
            const from = session.pages * 20;
            return pageOf(Array.from({ length: 20 }, (_, index) => String(from + index + 1)));
        });
        const page = await handleQishuiRecommendFeed(
            { limit: 50, offset: 50, flow: 'playlist', advance: false }, cookie, { status, fetchPage },
        );
        expect(page.songs).toHaveLength(50);
        expect(page.songs[0].id).toBe('51');
        expect(page.nextOffset).toBe(100);
        expect(page.hasMore).toBe(true);
    });

    it('keeps looking past a duplicate page instead of ending the feed early', async () => {
        let round = 0;
        const fetchPage = vi.fn(async () => {
            round += 1;
            return round === 1 ? pageOf(['A']) : pageOf(['A', 'B']);
        });

        const page = await handleQishuiRecommendFeed(
            { limit: 3, offset: 0, flow: 'playlist', advance: false }, cookie, { status, fetchPage },
        );
        expect(page.songs.map(item => item.id)).toEqual(['A', 'B']);
        expect(page.nextOffset).toBe(2);
        expect(fetchPage).toHaveBeenCalledTimes(2);
    });

    it('drops the buffered session when the runtime caches are cleared (logout / account switch)', async () => {
        let round = 0;
        const fetchPage = vi.fn(async (session: FeedSession) => {
            round += 1;
            return pageOf([String(session.pages + 1)]);
        });
        const first = await handleQishuiRecommendFeed(
            { limit: 1, flow: 'fm', advance: true }, cookie, { status, fetchPage },
        );
        expect(first.songs[0].id).toBe('1');

        t.clearQishuiRuntimeCaches();
        const again = await handleQishuiRecommendFeed(
            { limit: 1, flow: 'fm', advance: true }, cookie, { status, fetchPage },
        );
        expect(again.songs[0].id).toBe('1');
        expect(round).toBe(2);
    });
});

describe('Qishui feed collection card', () => {
    it('exposes a bounded, read-only virtual playlist', () => {
        expect(t.buildQishuiFeedPlaylist([])).toMatchObject({
            id: 'qishui-feed',
            name: '汽水推荐流',
            trackCount: t.QISHUI_FEED_TOTAL_CAP,
            virtual: true,
            owned: false,
            playbackMode: 'recommend-match',
        });
    });
});

describe('Qishui feed bridge contract', () => {
    it('registers feed.recommend and treats an empty page without error as success', () => {
        // QISHUI_OPERATIONS 同时是 desktop IPC 与 qishui-server /rpc 的白名单：
        // 缺了它，server 形态会直接 404。
        expect(bridge.QISHUI_OPERATIONS).toContain('feed.recommend');
        expect(new Set(bridge.QISHUI_OPERATIONS).size).toBe(bridge.QISHUI_OPERATIONS.length);

        const fails = bridge._test.QISHUI_RESULT_FAILURES['feed.recommend'];
        expect(fails({ songs: [], hasMore: false })).toBe(false);
        expect(fails({ songs: [], error: 'QISHUI_COOKIE_REQUIRED' })).toBe(true);
        // 有歌时的非致命 warning 不能把整页判失败。
        expect(fails({ songs: [{ id: '1' }], error: 'warning' })).toBe(false);
    });
});
