import { beforeEach, describe, expect, it, vi } from 'vitest';

// test/unit/onlineMusic/qishuiProvider.test.ts

// 只替换桥的请求函数，错误码映射与 200+error 的数据级判定仍走真实实现 ——
// 这两处是「未扫码却提示登录错误」那类线上问题的判断依据，不能被测试桩覆盖掉。
const request = vi.hoisted(() => vi.fn());
vi.mock('@/services/onlineMusic/qishuiTransport', async () => {
    const actual = await vi.importActual<typeof import('@/services/onlineMusic/qishuiTransport')>(
        '@/services/onlineMusic/qishuiTransport',
    );
    return { ...actual, requestQishui: request, getQishuiTransportAvailability: () => ({ configured: true }) };
});

import { OnlineProviderError } from '@/types/onlineMusic';
import { qishuiProvider } from '@/services/onlineMusic/qishuiProvider';
import { clearQishuiLibraryCache } from '@/services/onlineMusic/qishuiLibrary';
import { QISHUI_FEED_PLAYLIST_ID, QISHUI_LIKED_PLAYLIST_ID } from '@/services/onlineMusic/qishuiCatalog';
import { normalizeQishuiCollection, normalizeQishuiSong } from '@/services/onlineMusic/qishuiNormalize';
import { throwQishuiDataError, toQishuiErrorCode } from '@/services/onlineMusic/qishuiTransport';

// 形状取自真实抓包（`_probe/qishui-shapes.json`）：时长是秒，封面是绝对 https，未登录时 playable=false。
const track = {
    id: '7669756492397283344', name: '一撇一捺', artist: '吴炳文', artistId: 123,
    artists: [{ id: 123, name: '吴炳文' }], album: '测试专辑', albumId: '456',
    cover: 'https://p3-luna.douyinpic.com/img~c5_500x500.jpg', duration: 180, fee: 0,
    playable: false, playbackMode: 'recommend-match',
};

const qishuiSong = () => normalizeQishuiSong(track);

beforeEach(() => {
    request.mockReset();
    clearQishuiLibraryCache();
});

describe('Qishui bridge error codes', () => {
    it.each([
        ['QISHUI_COOKIE_REQUIRED', 'auth-required'],
        ['qishui-cookie-required', 'auth-required'],
        ['QISHUI_TOKEN_REQUIRED', 'auth-required'],
        ['QISHUI_LOGIN_REQUIRED', 'auth-required'],
        ['QISHUI_QR_TOKEN_REQUIRED', 'invalid-response'],
        ['MISSING_ARTIST_NAME', 'invalid-response'],
        ['ARTIST_SEARCH_FAILED', 'invalid-response'],
        ['preview-only', 'preview-only'],
        ['region-restricted', 'region-restricted'],
        ['mfa-cancelled', 'auth-required'],
        ['SOMETHING_ELSE', 'unavailable'],
    ])('folds %s into an Omni error code', (input, expected) => {
        expect(toQishuiErrorCode(input)).toBe(expected);
    });

    it('turns an in-band 200 + error payload into a provider error, and leaves clean payloads alone', () => {
        expect(() => throwQishuiDataError({ songs: [] })).not.toThrow();
        let thrown: unknown = null;
        try { throwQishuiDataError({ error: 'QISHUI_COOKIE_REQUIRED', message: '需要登录' }); }
        catch (error) { thrown = error; }
        expect(thrown).toBeInstanceOf(OnlineProviderError);
        expect(thrown).toMatchObject({ code: 'auth-required', message: '需要登录' });
    });
});

describe('Qishui provider contract', () => {
    it('declares only the capabilities the bridge actually implements', () => {
        expect(qishuiProvider).toMatchObject({ id: 'qishui', displayName: '汽水音乐', shortName: '汽水' });
        expect(qishuiProvider.capabilities).toMatchObject({
            search: true, playback: true, lyrics: true, wordByWordLyrics: true, auth: true,
            playlists: true, albums: true, artists: true, recommendations: true,
            userLibrary: true, likes: true, mutations: true, playlistTrackMutations: true,
        });
        // 汽水没有「我的专辑」列表接口（收藏只能写不能列），播放上报也被 Omni 钉在网易云上。
        expect(qishuiProvider.capabilities).not.toHaveProperty('userAlbums');
        expect(qishuiProvider.capabilities).not.toHaveProperty('playbackReports');
        expect(qishuiProvider.getAvailability!()).toEqual({ configured: true });
    });

    it('only calls a track unavailable when Qishui itself has no audio for it', () => {
        expect(qishuiProvider.playback!.getAvailability!(normalizeQishuiSong(track))).toEqual({ state: 'unknown' });
        expect(qishuiProvider.playback!.getAvailability!(
            normalizeQishuiSong({ ...track, restriction: { category: 'source_unavailable' } }),
        )).toEqual({ state: 'unavailable' });
    });
});

describe('Qishui search', () => {
    it('skips the bridge on a blank query and clamps the page size the protocol layer accepts', async () => {
        await expect(qishuiProvider.search!.searchSongs('   ', 50, 0))
            .resolves.toMatchObject({ items: [], total: 0, nextOffset: 0, hasMore: false });
        expect(request).not.toHaveBeenCalled();

        request.mockResolvedValue({ songs: [track], total: 51 });
        const page = await qishuiProvider.search!.searchSongs('一撇一捺', 50, 0);
        expect(request).toHaveBeenCalledWith('search', { keywords: '一撇一捺', limit: 18, offset: 0 });
        // 上游没给 hasMore 时按游标推：1 < 51，所以还有下一页。
        expect(page).toMatchObject({ total: 51, nextOffset: 1, hasMore: true });
        expect(page.items[0]).toMatchObject({ id: '7669756492397283344', durationMs: 180000 });
    });

    it('rejects a malformed result and a data-level refusal', async () => {
        request.mockResolvedValueOnce({});
        await expect(qishuiProvider.search!.searchSongs('测试', 12, 0))
            .rejects.toMatchObject({ code: 'invalid-response' });
        request.mockResolvedValueOnce({ songs: [], error: 'QISHUI_TOKEN_REQUIRED', message: '请登录' });
        await expect(qishuiProvider.search!.searchSongs('测试', 12, 0))
            .rejects.toMatchObject({ code: 'auth-required' });
    });
});

describe('Qishui playback', () => {
    it('never routes another provider through Qishui', async () => {
        await expect(qishuiProvider.playback!.getAudioSource!(
            { ...qishuiSong(), sourceRef: { kind: 'online', providerId: 'qq', mediaId: '1' } }, 'high',
        )).rejects.toMatchObject({ code: 'unsupported' });
        expect(request).not.toHaveBeenCalled();
    });

    it('keeps a preview out of the audio source and explains every refusal', async () => {
        request.mockResolvedValueOnce({ url: 'http://127.0.0.1:6777/audio', trial: true });
        await expect(qishuiProvider.playback!.getAudioSource!(qishuiSong(), 'high'))
            .rejects.toMatchObject({ code: 'preview-only' });

        request.mockResolvedValueOnce({ playable: false, url: '', restriction: { category: 'login_required' }, message: '请先登录' });
        await expect(qishuiProvider.playback!.getAudioSource!(qishuiSong(), 'high'))
            .rejects.toMatchObject({ code: 'auth-required', message: '请先登录' });

        request.mockResolvedValueOnce({ playable: false, url: '', message: '没有可播版本' });
        await expect(qishuiProvider.playback!.getAudioSource!(qishuiSong(), 'high'))
            .rejects.toMatchObject({ code: 'not-playable', message: '没有可播版本' });
    });

    it('returns the loopback proxy URL that the main process handed back', async () => {
        request.mockResolvedValueOnce({ url: 'http://127.0.0.1:6777/abc/audio?u=x', playable: true, duration: 180 });
        const source = await qishuiProvider.playback!.getAudioSource!(qishuiSong(), 'high');
        expect(source).toMatchObject({ url: 'http://127.0.0.1:6777/abc/audio?u=x', quality: 'high' });
        expect(typeof source!.fetchedAt).toBe('number');
        expect(request).toHaveBeenCalledWith('song.url', { id: '7669756492397283344', quality: 'high' });
    });
});

describe('Qishui lyrics', () => {
    it('asks for the source media ID and treats an empty lyric as a valid answer', async () => {
        request.mockResolvedValueOnce({ lyric: '[00:01.00]第一行', tlyric: '[00:01.00]First line', yrc: '', ytlrc: '' });
        const result = await qishuiProvider.lyrics!.getLyrics!(qishuiSong());
        expect(request).toHaveBeenCalledWith('lyric', { id: '7669756492397283344' });
        expect(result.mainText).toBe('[00:01.00]第一行');
        expect(result.translationText).toBe('[00:01.00]First line');
        expect(result.lyrics).not.toBeNull();

        request.mockResolvedValueOnce({ lyric: '', tlyric: '', yrc: '', ytlrc: '', source: 'none' });
        const empty = await qishuiProvider.lyrics!.getLyrics!(qishuiSong());
        expect(empty).toMatchObject({ mainText: '', lyrics: null });
    });

    it('refuses lyrics for a song that is not ours', async () => {
        await expect(qishuiProvider.lyrics!.getLyrics!(
            { ...qishuiSong(), sourceRef: { kind: 'online', providerId: 'netease', mediaId: '1' } },
        )).rejects.toMatchObject({ code: 'unsupported' });
    });
});

describe('Qishui login', () => {
    it('reads the login state from status only, and never reports a signed-in account as anonymous', async () => {
        request.mockResolvedValueOnce({ loggedIn: false });
        await expect(qishuiProvider.auth!.getLoginStatus!()).resolves.toBeNull();

        request.mockResolvedValueOnce({ loggedIn: true, userId: '9000000000000000001', nickname: '测试用户', vipType: 1 });
        await expect(qishuiProvider.auth!.getLoginStatus!())
            .resolves.toMatchObject({ id: '9000000000000000001', nickname: '测试用户', vipType: 1 });

        // 缺 id 也不能当成未登录，否则整库会被清空。
        request.mockResolvedValueOnce({ loggedIn: true, nickname: '匿名' });
        await expect(qishuiProvider.auth!.getLoginStatus!()).resolves.toMatchObject({ id: 'qishui-account' });
    });

    it('bridges the one-step QR payload into the two-step getQrKey/createQr contract', async () => {
        request.mockResolvedValueOnce({ token: 'qr-1', qrcode: 'data:image/png;base64,AAA', expireTime: 0 });
        const key = await qishuiProvider.auth!.getQrKey!();
        expect(key).toBe('qr-1');
        await expect(qishuiProvider.auth!.createQr!(key)).resolves.toBe('data:image/png;base64,AAA');
        // 上游没给有效期时按 5 分钟兜底。
        expect(qishuiProvider.auth!.getQrTtlMs!()).toBe(5 * 60 * 1000);

        request.mockResolvedValueOnce({ token: 'qr-2', qrcode: 'data:image/png;base64,BBB', ttlMs: 90_000 });
        await qishuiProvider.auth!.getQrKey!();
        expect(qishuiProvider.auth!.getQrTtlMs!()).toBe(90_000);

        await expect(qishuiProvider.auth!.createQr!('qr-unknown'))
            .rejects.toMatchObject({ code: 'invalid-response' });

        request.mockResolvedValueOnce({ token: 'qr-3', qrcode: 'data:image/png;base64,CCC' });
        const third = await qishuiProvider.auth!.getQrKey!();
        await qishuiProvider.auth!.cancelQr!(third);
        await expect(qishuiProvider.auth!.createQr!(third)).rejects.toMatchObject({ code: 'invalid-response' });
    });

    it('rejects an incomplete QR payload instead of showing a broken dialog', async () => {
        request.mockResolvedValueOnce({ token: 'qr-4' });
        await expect(qishuiProvider.auth!.getQrKey!()).rejects.toMatchObject({ code: 'invalid-response' });
    });

    it.each([
        ['waiting', 0, { state: 'waiting' }],
        ['scanned', 0, { state: 'scanned' }],
        ['confirmed', 0, { state: 'confirmed' }],
        ['expired', 2, { state: 'expired' }],
        // 回归：上游未扫码时返回 status:'new'，必须继续等，不能显示登录错误。
        ['new', 0, { state: 'waiting' }],
    ])('maps the scan status %s (errorCode %i)', async (status, errorCode, expected) => {
        request.mockResolvedValueOnce({ status, errorCode, message: 'success' });
        await expect(qishuiProvider.auth!.checkQr!('qr-x')).resolves.toEqual(expected);
    });

    it('only reports a login failure when the bridge gives a non-zero error code', async () => {
        request.mockResolvedValueOnce({ status: 'new', errorCode: 5, message: '登录失败' });
        await expect(qishuiProvider.auth!.checkQr!('qr-x')).resolves.toEqual({ state: 'error', message: '登录失败' });

        request.mockResolvedValueOnce({ status: 'rate_limited', errorCode: 7, retryAfterMs: 60_000, message: '操作太快' });
        await expect(qishuiProvider.auth!.checkQr!('qr-x'))
            .resolves.toEqual({ state: 'error', message: '操作太快', retryAfterMs: 60_000 });
    });

    it('restores a device-side cancellation as a retryable state', async () => {
        request.mockRejectedValueOnce(new OnlineProviderError('auth-required', '已取消', 'qishui', 'mfa-cancelled'));
        await expect(qishuiProvider.auth!.checkQr!('qr-x'))
            .resolves.toEqual({ state: 'error', reason: 'canceled-on-device', message: '已取消' });

        request.mockRejectedValueOnce(new OnlineProviderError('network', '桥断了', 'qishui'));
        await expect(qishuiProvider.auth!.checkQr!('qr-x')).resolves.toEqual({ state: 'error', message: '桥断了' });
    });

    it('drops the cached library when the account logs out', async () => {
        request.mockResolvedValue({ playlists: [{ id: 'p1', name: '汽水我的喜欢' }] });
        await qishuiProvider.library!.getUserPlaylists!('u1', 10, 0);
        await qishuiProvider.library!.getUserPlaylists!('u1', 10, 10);
        expect(request).toHaveBeenCalledTimes(1);

        request.mockResolvedValue({});
        await qishuiProvider.auth!.logout!();
        expect(request).toHaveBeenLastCalledWith('login.logout', {});
        request.mockResolvedValue({ playlists: [{ id: 'p1', name: '汽水我的喜欢' }] });
        await qishuiProvider.library!.getUserPlaylists!('u1', 10, 10);
        expect(request).toHaveBeenCalledTimes(3);
    });
});

describe('Qishui catalog', () => {
    it('pages playlist tracks and discards a cursor that would move backwards', async () => {
        request.mockResolvedValueOnce({ tracks: [track], total: 262 });
        const page = await qishuiProvider.catalog!.getPlaylistTracks!(QISHUI_LIKED_PLAYLIST_ID, 50, 0);
        expect(request).toHaveBeenCalledWith('playlist.tracks', { id: QISHUI_LIKED_PLAYLIST_ID, limit: 50, offset: 0 });
        expect(page).toMatchObject({ total: 262, nextOffset: 1, hasMore: true });

        // token 搜索路径的 nextOffset 忘了加自身 offset，游标不可信时只丢步长、保留 hasMore。
        request.mockResolvedValueOnce({ tracks: [track], total: 262, nextOffset: 0, hasMore: true });
        await expect(qishuiProvider.catalog!.getPlaylistTracks!(QISHUI_LIKED_PLAYLIST_ID, 50, 0))
            .resolves.toMatchObject({ nextOffset: 1, hasMore: true });
    });

    it('rejects a page without a track list', async () => {
        request.mockResolvedValueOnce({});
        await expect(qishuiProvider.catalog!.getPlaylistTracks!('qishui-liked', 50, 0))
            .rejects.toMatchObject({ code: 'invalid-response' });
    });

    it('reuses the collection card the caller already has', async () => {
        const card = normalizeQishuiCollection({ id: 'p1', name: '汽水我的喜欢', trackCount: 262 });
        await expect(qishuiProvider.catalog!.getPlaylistDetail!('p1', card)).resolves.toBe(card);
        expect(request).not.toHaveBeenCalled();

        request.mockResolvedValueOnce({ playlist: { id: 'p1', name: '汽水我的喜欢' } });
        await expect(qishuiProvider.catalog!.getPlaylistDetail!('p1'))
            .resolves.toMatchObject({ providerId: 'qishui', id: 'p1', type: 'playlist' });
    });

    it('needs an artist name remembered from a search result before opening an artist page', async () => {
        // 冷启动直接按 id 打开歌手页：协议层只给 id 会回 MISSING_ARTIST_NAME，所以这里提前拒绝。
        await expect(qishuiProvider.catalog!.getArtistSongs!('999', 10, 0))
            .rejects.toMatchObject({ code: 'invalid-response' });

        // 归一化过的歌曲会把歌手名记下来（track 里的 123/吴炳文）。
        qishuiSong();
        request.mockResolvedValueOnce({ artist: { id: 123, name: '吴炳文' }, songs: [track] });
        const page = await qishuiProvider.catalog!.getArtistSongs!('123', 10, 0);
        expect(request).toHaveBeenCalledWith('artist', { artistId: '123', artistName: '吴炳文', limit: 50 });
        expect(page).toMatchObject({ total: 1, hasMore: false });
        expect(page.items[0]).toMatchObject({ id: '7669756492397283344' });
    });

    it('treats an artist search miss as an empty artist page', async () => {
        qishuiSong();
        request.mockResolvedValueOnce({ error: 'QISHUI_ARTIST_SEARCH_FAILED' });
        await expect(qishuiProvider.catalog!.getArtistSongs!('123', 10, 0))
            .resolves.toMatchObject({ items: [], hasMore: false });
        request.mockResolvedValueOnce({ error: 'QISHUI_ARTIST_SEARCH_FAILED' });
        await expect(qishuiProvider.catalog!.getArtistDetail!('123')).resolves.toBeNull();
    });

    it('fetches an album once and pages it in memory', async () => {
        request.mockResolvedValueOnce({ songs: [track, { ...track, id: '2' }, { ...track, id: '3' }] });
        const page = await qishuiProvider.catalog!.getAlbumTracks!('456', 2, 1);
        expect(request).toHaveBeenCalledWith('album', { id: '456', limit: 120 });
        expect(page.items.map(item => item.id)).toEqual(['2', '3']);
        expect(page).toMatchObject({ total: 3, nextOffset: 3, hasMore: false });

        request.mockResolvedValueOnce({ album: { albumId: '456', name: '测试专辑' } });
        await expect(qishuiProvider.catalog!.getAlbumDetail!('456'))
            .resolves.toMatchObject({ providerId: 'qishui', id: '456', type: 'album', name: '测试专辑' });
    });

    it('pages the virtual feed through feed.recommend and stops at the finite cap', async () => {
        request.mockResolvedValueOnce({ songs: [track], total: 200, nextOffset: 1, hasMore: true });
        const page = await qishuiProvider.catalog!.getPlaylistTracks!(QISHUI_FEED_PLAYLIST_ID, 50, 0);
        expect(request).toHaveBeenLastCalledWith('feed.recommend', {
            limit: 50, offset: 0, flow: 'playlist', advance: false,
        });
        expect(page).toMatchObject({ total: 200, nextOffset: 1, hasMore: true });

        request.mockClear();
        await expect(qishuiProvider.catalog!.getPlaylistTracks!(QISHUI_FEED_PLAYLIST_ID, 50, 200))
            .resolves.toEqual({ items: [], total: 200, hasMore: false, nextOffset: 200 });
        expect(request).not.toHaveBeenCalled();
    });

    it('returns the virtual feed detail card without probing playlist.tracks for one track', async () => {
        request.mockClear();
        await expect(qishuiProvider.catalog!.getPlaylistDetail!(QISHUI_FEED_PLAYLIST_ID))
            .resolves.toMatchObject({
                providerId: 'qishui', id: QISHUI_FEED_PLAYLIST_ID, name: '汽水推荐流',
                trackCount: 200, isOwned: false,
            });
        expect(request).not.toHaveBeenCalled();
    });
});

describe('Qishui library', () => {
    it('walks the virtual liked playlist and de-duplicates its ids', async () => {
        request.mockResolvedValueOnce({ tracks: [track], total: 3 });
        request.mockResolvedValueOnce({ tracks: [track, { ...track, id: '2' }], total: 3 });
        await expect(qishuiProvider.library!.getLikedSongIds!('u1')).resolves.toEqual(['7669756492397283344', '2']);
        expect(request).toHaveBeenNthCalledWith(1, 'playlist.tracks', { id: QISHUI_LIKED_PLAYLIST_ID, limit: 100, offset: 0 });
        expect(request).toHaveBeenNthCalledWith(2, 'playlist.tracks', { id: QISHUI_LIKED_PLAYLIST_ID, limit: 100, offset: 1 });
    });
});

describe('Qishui mutations', () => {
    const owned = { providerId: 'qishui' as const, id: 'p1', type: 'playlist' as const, name: '我的歌单', isOwned: true };

    it('only allows adding to playlists the account owns', () => {
        expect(qishuiProvider.mutations!.canAddToPlaylist!(owned)).toBe(true);
        expect(qishuiProvider.mutations!.canAddToPlaylist!({ ...owned, isOwned: false })).toBe(false);
        expect(qishuiProvider.mutations!.canAddToPlaylist!({ ...owned, providerId: 'qq' as never })).toBe(false);
    });

    it('sends the like state and clears the cached library afterwards', async () => {
        request.mockResolvedValue({});
        await qishuiProvider.mutations!.likeSong!(qishuiSong(), true);
        expect(request).toHaveBeenCalledWith('track.like', { id: '7669756492397283344', liked: true });

        request.mockClear();
        await expect(qishuiProvider.mutations!.likeSong!(
            { ...qishuiSong(), sourceRef: { kind: 'online', providerId: 'netease', mediaId: '1' } }, true,
        )).rejects.toMatchObject({ code: 'unsupported' });
        expect(request).not.toHaveBeenCalled();
    });

    it('adds tracks one by one and refuses what the bridge cannot do', async () => {
        request.mockResolvedValue({});
        await qishuiProvider.mutations!.updatePlaylistTracks!('add', owned, [qishuiSong()]);
        expect(request).toHaveBeenCalledWith('playlist.addSong', { playlistId: 'p1', trackId: '7669756492397283344' });

        await expect(qishuiProvider.mutations!.updatePlaylistTracks!('del', owned, [qishuiSong()]))
            .rejects.toMatchObject({ code: 'unsupported' });
        await expect(qishuiProvider.mutations!.updatePlaylistTracks!('add', owned, Array(101).fill(qishuiSong())))
            .rejects.toMatchObject({ code: 'unsupported' });
        await expect(qishuiProvider.mutations!.updatePlaylistTracks!('add', { ...owned, isOwned: false }, [qishuiSong()]))
            .rejects.toMatchObject({ code: 'unsupported' });
        // 空列表不是错误，也不该产生任何请求。
        request.mockClear();
        await qishuiProvider.mutations!.updatePlaylistTracks!('del', owned, []);
        expect(request).not.toHaveBeenCalled();
    });

    it('collects playlists and albums with the field names the bridge expects', async () => {
        request.mockResolvedValue({});
        await qishuiProvider.mutations!.subscribePlaylist!(owned, true);
        expect(request).toHaveBeenCalledWith('playlist.collect', { id: 'p1', collected: true });
        await qishuiProvider.mutations!.subscribeAlbum!('456', false);
        expect(request).toHaveBeenCalledWith('album.collect', { id: '456', collected: false });
    });
});

describe('Qishui recommendations', () => {
    it('exposes the paginated feed as one virtual collection with a finite total', async () => {
        request.mockResolvedValueOnce({ songs: [track], total: 200, hasMore: true });
        const collections = await qishuiProvider.recommendations!.getRecommendedCollections!(5);
        expect(request).toHaveBeenCalledWith('feed.recommend', {
            limit: 5, offset: 0, flow: 'playlist', advance: false,
        });
        expect(collections).toHaveLength(1);
        expect(collections[0]).toMatchObject({
            providerId: 'qishui', id: QISHUI_FEED_PLAYLIST_ID, type: 'playlist', name: '汽水推荐流',
            trackCount: 200, coverUrl: track.cover, isOwned: false,
            providerData: { virtual: true, playbackMode: 'recommend-match' },
        });
    });

    it('keeps the entry visible on a transient failure and hides it only when signed out', async () => {
        request.mockRejectedValueOnce(new Error('feed unavailable'));
        await expect(qishuiProvider.recommendations!.getRecommendedCollections!(5))
            .resolves.toHaveLength(1);

        request.mockRejectedValueOnce(new OnlineProviderError('auth-required', '请登录', 'qishui'));
        await expect(qishuiProvider.recommendations!.getRecommendedCollections!(5)).resolves.toEqual([]);
    });

    it('advances a separate FM session and exposes a non-consuming preview', async () => {
        request.mockResolvedValueOnce({ songs: [track] });
        await expect(qishuiProvider.recommendations!.getPersonalFm!()).resolves.toHaveLength(1);
        expect(request).toHaveBeenLastCalledWith('feed.recommend', {
            limit: 20, flow: 'fm', advance: true,
        });

        request.mockResolvedValueOnce({ songs: [track] });
        await expect(qishuiProvider.recommendations!.getPersonalFmPreview!()).resolves.toHaveLength(1);
        expect(request).toHaveBeenLastCalledWith('feed.recommend', {
            limit: 1, flow: 'fm', advance: false,
        });

        request.mockRejectedValueOnce(new Error('feed unavailable'));
        await expect(qishuiProvider.recommendations!.getPersonalFm!()).resolves.toEqual([]);
    });
});
