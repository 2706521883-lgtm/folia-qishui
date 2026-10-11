import type { SongResult, StatusMessage } from '../../../types';
import type { LocalGridViewCollectionDescriptor } from './collection';

// src/library/core/contracts/ports.ts
// 宿主提供给 Library Core 的端口：播放端口（交给应用的播放控制器）与变更动作的来源端口
// （本地曲库、Navidrome、对话框、账户刷新、应用内通知）。Core 只依赖这些接口，不知道它们怎么实现。

/** 把「播放 / 入队」交给应用现有的播放控制器；核心层不知道队列怎么构造。 */
export interface LibraryPlaybackPort {
    playTrack(track: SongResult, queue: SongResult[]): void;
    playAll(tracks: SongResult[]): void;
    enqueueTrack(track: SongResult): void;
    /**
     * 整批入队。`suppressToast` 让队列不弹自己的「已加入」提示（调用方要报自己的，例如歌手页的「已加入 N 首热门歌曲」）；
     * 返回队列真正收下的条数（已在队列里的不算），宿主不报数时为 void。
     */
    enqueueAll(tracks: SongResult[], options?: LibraryEnqueueOptions): number | void;
    /**
     * fb3：暂停 / 继续正在播放的那首（宿主的播放开关）。「播放后进入的视图」是「留在原处」时，网格卡片上正在播放的
     * 那首的播放键改为它。宿主没给时为 undefined（卡片照旧「立即播放」）。
     */
    togglePlayback?(): void;
}

/**
 * 墙上工具面板的宿主动作（bravais 右下角工具面板，设计稿 §7.5「浮层控件」）：为当前歌曲生成主题、队列洗牌、拖动音量时的输出预览。
 * 宿主（library/app/useLibraryStageToolsPort）用命令面板的同一套命令实现前两项（`theme-generate-current`、`playback-shuffle`），
 * 可用性也是命令面板的那一份判定；端口身份稳定，此刻能不能做经 getSnapshot / subscribe 读（与账户 controller 同一种形状），
 * 不随可用性变化重建首页模型。音量本身的读写不经端口：suite 读写应用的音量 store（与播放条、播放页面板同一份）。
 */
export interface LibraryStageToolsPort {
    getSnapshot(): LibraryStageToolsSnapshot;
    subscribe(listener: () => void): () => void;
    /** 为当前歌曲生成主题（命令 theme-generate-current；不可用时什么都不做）。 */
    generateTheme(): void;
    /** 把当前播放队列打乱一次（命令 playback-shuffle；正在播放的那首留在队首）。不是「随机播放模式」——应用没有那种模式。 */
    shuffleQueue(): void;
    /** 拖动音量时的输出预览（不写偏好、不重渲染应用）；松手时调用方再写音量 store。 */
    previewVolume(volume: number): void;
}

export type LibraryStageToolsSnapshot = {
    /** 主题生成：ready 可以生成；busy 正在生成；unavailable 没有能生成主题的歌（没有歌，或没有歌词也不是纯音乐）。 */
    themeGeneration: 'ready' | 'busy' | 'unavailable';
    /** 队列洗牌此刻能不能做：私人 FM、队列不足两首、外部 Stage 播放时不能。 */
    canShuffleQueue: boolean;
};

/** 整批入队的选项（与应用播放控制器 addOnlineSongsToQueue 的同名选项一致）。 */
export type LibraryEnqueueOptions = { suppressToast?: boolean };

/** 「加入歌单」选择器里的一项。 */
export type LibraryPlaylistOption = { id: string | number; name: string; description?: string };

/** 本地曲库的来源动作；最后三个只打开宿主挂载的对话框。 */
export interface LibraryLocalMutationPort {
    removePlaylistSongs?: (playlistId: string, songIds: string[]) => Promise<void> | void;
    /** 重新读取本地曲库（歌单、歌曲）。 */
    refresh?: () => Promise<void> | void;
    renamePlaylist?: (playlistId: string, name: string) => Promise<void> | void;
    deletePlaylist?: (playlistId: string) => Promise<void> | void;
    deleteFolder?: (collection: LocalGridViewCollectionDescriptor) => Promise<void> | void;
    resyncFolder?: (collection: LocalGridViewCollectionDescriptor) => Promise<void> | void;
    resyncAllFolders?: () => Promise<void> | void;
    exportPlaylist?: (playlistId: string) => Promise<void> | void;
    editEntity?: (entityId: string) => Promise<void> | void;
    organizeFolder?: (collection: LocalGridViewCollectionDescriptor) => Promise<void> | void;
    matchSong?: (songId: string) => Promise<void> | void;
}

/** Navidrome 的来源动作。删歌按资源里的原始下标，不是界面上的显示下标。 */
export interface LibraryNavidromeMutationPort {
    availablePlaylists?: LibraryPlaylistOption[];
    removePlaylistSongs?: (playlistId: string, rawIndexes: number[]) => Promise<void> | void;
    renamePlaylist?: (playlistId: string, name: string) => Promise<void> | void;
    deletePlaylist?: (playlistId: string) => Promise<void> | void;
    addToPlaylist?: (playlistId: string | number, songs: SongResult[]) => Promise<void> | void;
    createPlaylist?: (name: string, songs: SongResult[]) => Promise<void> | void;
}

/**
 * 宿主提供的来源动作。在线集合的变更走 omni（由控制器注入），这里只有应用侧才做得到的事：
 * 本地曲库与 Navidrome 的读写、对话框、账户刷新和应用内通知。
 */
export interface LibraryMutationPort {
    local?: LibraryLocalMutationPort;
    navidrome?: LibraryNavidromeMutationPort;
    /** 集合在上游变了（删歌、订阅）：刷新账户里的歌单列表等。 */
    onCollectionMutated?: () => Promise<void> | void;
    /** renderer 把动作结果翻译成文案后经由这里显示；控制器自己只返回判别式。 */
    statusMessage?: (message: StatusMessage) => void;
    /** 收藏的专辑变了（订阅 / 取消订阅专辑）。 */
    notifyFavoriteAlbumsChanged?: () => void;
}
