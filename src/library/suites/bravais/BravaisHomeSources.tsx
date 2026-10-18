import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { LocalLibraryGroup, LocalPlaylist, LocalSong } from '../../../types';
import type { LibraryCollectionDescriptor } from '../../core/contracts/collection';
import type { LibraryDirectoryBatchController, LibraryHiddenScope } from '../../core/contracts/directory';
import type { LibraryLocalCatalogSnapshot } from '../../core/contracts/home';
import type {
    LibraryHomeActionsController,
    LibraryHomeCard,
    LibraryHomeListState,
    LibraryHomeOnlineSource,
    LibraryHomeTabKey,
    LibraryLocalDirectoryTreesResource,
    LibraryNavidromeHomeResource,
} from '../../core/contracts/homeModel';
import type { LibraryDeclaredActions, LibraryHomeActionId } from '../../core/contracts/suite';
import type { LibraryAccountController } from '../../core/contracts/account';
import { isPersonalFmCard } from '../../core/model/homeCards';
import { resolveLocalHomeActions, type LocalHomeRow } from '../../core/model/localHomeModel';
import { isNavidromeHomeSection, resolveNavidromeCollectionType } from '../../core/model/navidromeHomeModel';
import type { LibraryHomeOnlineList } from '../../core/bindings/useLibraryHomeOnline';
import { usePlaybackStore } from '../../../stores/usePlaybackStore';
import { getPlaybackSourceRef } from '../../../utils/appPlaybackGuards';
import { useLibraryHomeLocal, useLocalDirectoryTrees, useLocalHomeBatchConfig } from '../../core/bindings/useLibraryHomeLocal';
import { useLibraryHomeNavidrome } from '../../core/bindings/useLibraryHomeNavidrome';
import { useLibraryHomeActions } from '../../core/bindings/useLibraryHomeActions';
import { useLibraryHomeListRegistration } from '../../core/bindings/useLibraryHomeSurfaceRegistration';
import type { BravaisHomeAction, BravaisHomeTool } from './bravaisHomeModels';
import type { BravaisSeamMenuItem } from './bravaisSeamModels';
import type { BravaisHomeChrome } from './useBravaisHomeChrome';
import BravaisHomeDirectory from './BravaisHomeDirectory';
import { useBravaisHomeAccount } from './useBravaisHomeAccount';

// src/library/suites/bravais/BravaisHomeSources.tsx
// bravais 首页三个来源的墙（设计稿 §10.5）：在线（账户歌单 / 电台 / 收藏专辑）、本地（文件夹 / 专辑 / 歌手 / 歌单
// 四行是缝里的二级切换）、Navidrome（五个 section）。与 TUI 的 LibraryTuiHomeLists 同一个结构：每个来源只在显示时
// 挂载（Navidrome 概览、本地文件夹树都是进页签时 ensure），数据、section、动作与打开都来自 Library Core 的首页模型与
// 首页资源；每个来源把自己的列表交给首页 surface 句柄（useLibraryHomeListRegistration），行为探针读它。
// 墙本身（目录会话、批量、隐藏、层描述）是 BravaisHomeDirectory。私人 FM 卡直接播放（openOnlineCard 判定），不进新层。
// 特殊集合的直达入口：在线页签看当前页签自己的卡（我喜欢的音乐、云盘在歌单页签，私人 FM、每日推荐在电台页签——电台数据
// 只在电台页签读，别的页签不为入口多发请求）；本地看文件夹与歌单两行（全部歌曲、「我喜欢」），Navidrome 看歌单 section
// （随机、收藏），都不限当前 section。

type BravaisHomeSourceCommonProps = {
    chrome: BravaisHomeChrome;
    directoryKey: string;
    hiddenScope: LibraryHiddenScope;
    declaredActions: LibraryDeclaredActions;
    isInteractive: boolean;
    homeActions: LibraryHomeActionsController;
    onOpenGridView: (collection: LibraryCollectionDescriptor) => void;
};

const LOCAL_ACTION_IDS: Record<string, LibraryHomeActionId> = {
    'import-folder': 'home-import-folder',
    'refresh-folders': 'home-refresh-folders',
    'import-playlist': 'home-import-playlist',
};

export const BravaisHomeOnline: React.FC<BravaisHomeSourceCommonProps & {
    tab: LibraryHomeTabKey;
    online: LibraryHomeOnlineSource;
    list: LibraryHomeOnlineList;
    /** B10：账户 controller（窄缝里的平台切换与登出）。 */
    account: LibraryAccountController;
}> = ({ tab, online, list, account: accountController, homeActions, onOpenGridView, ...common }) => {
    const { t } = useTranslation();
    // 合并歌单可能在当前平台未登录时也有内容（其他平台已登录）：这时仍然铺墙，不把登录面板挡在前面。
    const showList = online.accountView === 'authenticated' || list.items.length > 0;
    useLibraryHomeListRegistration({
        enabled: showList,
        getState: (): LibraryHomeListState => ({
            tab,
            directoryKey: common.directoryKey,
            hiddenScope: common.hiddenScope,
            sections: [],
            items: list.items,
            isLoading: list.isLoading,
            actions: [],
            batchSelectionType: null,
        }),
        setSection: () => false,
        runAction: () => false,
    });
    // 未登录 / 无账户 / 解析中：墙空着，缝里说原因（平台切换与登录在 B10 的账户位里）。
    // fb3（用户实测）：未登录时不再显示「先搜几首喜欢的歌试试看」（grid / TUI 仍用 home.guestTitle），缝里只有
    // 「连接在线平台」入口；登录过期仍要说。
    const emptyMessage = online.accountView === 'guest'
        ? (online.needsRelogin ? t('status.loginExpired') : undefined)
        : online.accountView === 'resolving' ? t('home.loadingLibrary') : list.emptyMessage;
    // B10：账户位里的平台切换（account-select / account-logout）。
    const account = useBravaisHomeAccount(accountController, online);
    // 推荐流已经在播（FM 模式 + 当前队列里有当前平台的歌）时，再点按钮是把下一批接到队尾，
    // 而不是重新开始一条新队列；其他情况仍然从第一首开始。
    // 看整个队列而不只看 currentSong：某首歌播放失败被跨音源兜底替换后，currentSong 的
    // sourceRef 可能已经变成兜底平台（例如 QQ 的歌用了酷狗的音源），但队列仍然是这个平台的推荐流。
    const isFmMode = usePlaybackStore(state => state.isFmMode);
    const playQueue = usePlaybackStore(state => state.playQueue);
    const canAppend = isFmMode && playQueue.some(song => {
        const source = getPlaybackSourceRef(song);
        return source.kind === 'online' && source.providerId === online.providerId;
    });
    const { snapshot: homeActionSnapshot } = useLibraryHomeActions(homeActions);
    // QQ 的 personal-FM 路由是主进程在包内注册的，注册失败时账号/搜索仍然可用，只有推荐流是死入口。
    // 读到 unavailable 就把按钮禁用，避免用户点了才看到错误。
    const [qqFeedUnavailable, setQqFeedUnavailable] = useState(false);
    useEffect(() => {
        if (online.providerId !== 'qq') {
            setQqFeedUnavailable(false);
            return undefined;
        }
        let cancelled = false;
        const applyStatus = (status: ElectronQqApiStatus | undefined) => {
            if (!cancelled) setQqFeedUnavailable(status?.personalFmRoute === 'unavailable');
        };
        // The main process rebroadcasts on every backend start/stop; subscribe as well as probe so a
        // restart that loses the route updates the button without remounting the home tab.
        const unsubscribe = window.electron?.onQqApiStatusChanged?.(applyStatus);
        void window.electron?.getQqApiStatus?.()
            .then(applyStatus)
            .catch(() => {
                // A status probe failure is not evidence that the route is missing.
            });
        return () => {
            cancelled = true;
            unsubscribe?.();
        };
    }, [online.providerId]);
    const latest = useRef({ homeActions, providerId: online.providerId, onOpenGridView, canAppend });
    latest.current = { homeActions, providerId: online.providerId, onOpenGridView, canAppend };
    // 推荐流：任何实现了连续个性化推荐（getPersonalFm）且已登录的平台，都在缝的中段给同一个入口。
    // 第一次点直接开始该平台的推荐播放（与私人 FM 同一条路径：getPersonalFm -> playPersonalFm）；
    // 已经在播时再点，取下一批接到队尾，可以连点几次先把队列垫长。队列快结束时
    // usePlaybackQueueController 仍会自动续批；各平台自己的叫法（私人FM / 猜你喜欢…）
    // 不进按钮，只保留统一的「推荐流」。
    const feedAction = useMemo<BravaisHomeAction | null>(() => {
        if (!online.hasPersonalFm || online.accountView !== 'authenticated') return null;
        const busy = homeActionSnapshot.personalFmBusy;
        const disabled = online.providerId === 'qq' && qqFeedUnavailable;
        const title = disabled
            ? t('libraryBravaisHome.recommendFeedUnavailable', '该平台的推荐流暂不可用')
            : busy
                ? t('libraryBravaisHome.recommendFeedBusy', '正在加载推荐…')
                : t('libraryBravaisHome.recommendFeedTitle', { provider: online.providerLabel, defaultValue: `${online.providerLabel} · 推荐流` });
        return {
            id: 'recommend-feed',
            label: t('libraryBravaisHome.recommendFeed', '推荐流'),
            title,
            busy,
            disabled,
            run: () => {
                const { homeActions: actions, canAppend: append } = latest.current;
                // 首次也开始在后台播放，不把用户从书库拉去播放页；再点则继续追加。
                void (append ? actions.loadMorePersonalFm() : actions.playPersonalFm({ shouldNavigateToPlayer: false }));
            },
        };
    }, [homeActionSnapshot.personalFmBusy, online.accountView, online.hasPersonalFm, online.providerId, online.providerLabel, qqFeedUnavailable, t]);
    const onOpen = useMemo(() => (card: Parameters<LibraryHomeActionsController['openOnlineCard']>[0]) => {
        const { homeActions: actions, providerId, onOpenGridView: open } = latest.current;
        void actions.openOnlineCard(card, providerId, open);
    }, []);
    return (
        <BravaisHomeDirectory
            {...common}
            layerKey={`home:${tab}`}
            source="online"
            section={tab}
            items={showList ? list.items : []}
            isLoading={showList && list.isLoading}
            emptyMessage={emptyMessage}
            meta={online.providerLabel}
            account={account}
            action={feedAction}
            panelTitle={list.title}
            onOpen={onOpen}
            isDirect={isPersonalFmCard}
        />
    );
};

export const BravaisHomeLocal: React.FC<BravaisHomeSourceCommonProps & {
    meta: string;
    localSongs: LocalSong[];
    localPlaylists: LocalPlaylist[];
    catalog: LibraryLocalCatalogSnapshot;
    activeRow: number;
    setActiveRow: (row: LocalHomeRow) => void;
    treesResource: LibraryLocalDirectoryTreesResource;
    directoryActions?: LibraryDirectoryBatchController;
}> = ({ meta, localSongs, localPlaylists, catalog, activeRow, setActiveRow, treesResource, directoryActions, homeActions, onOpenGridView, ...common }) => {
    const { t } = useTranslation();
    const playlistFileInputRef = useRef<HTMLInputElement>(null);
    const directoryTrees = useLocalDirectoryTrees(treesResource, localSongs);
    const local = useLibraryHomeLocal({ localSongs, localPlaylists, catalog, activeRow });
    const { snapshot: actionState } = useLibraryHomeActions(homeActions);
    const batchConfig = useLocalHomeBatchConfig({
        controller: directoryActions,
        selectionType: local.batchSelectionType,
        trees: directoryTrees.trees,
        reloadTrees: directoryTrees.reload,
        reloadAllTrees: directoryTrees.reloadAll,
    });
    const activeSection = local.activeSection;
    const localActions = resolveLocalHomeActions(actionState)
        .filter(action => common.declaredActions.actions.includes(LOCAL_ACTION_IDS[action.id]));
    const runAction = (id: string) => {
        if (id === 'import-folder') void homeActions.importFolder();
        else if (id === 'refresh-folders') void homeActions.refreshFolders();
        else if (id === 'import-playlist') playlistFileInputRef.current?.click();
    };
    const runActionRef = useRef(runAction);
    runActionRef.current = runAction;
    const isEmptyLibrary = directoryTrees.loaded && localSongs.length === 0 && directoryTrees.trees.length === 0;

    useLibraryHomeListRegistration({
        enabled: !isEmptyLibrary,
        getState: (): LibraryHomeListState => ({
            tab: 'local',
            directoryKey: common.directoryKey,
            hiddenScope: common.hiddenScope,
            sections: local.sections.map(section => ({ id: section.key, label: section.label, active: section.key === activeSection.key })),
            items: activeSection.cards,
            isLoading: false,
            actions: localActions.map(action => ({ id: action.id, label: t(action.labelKey), disabled: action.disabled })),
            batchSelectionType: batchConfig ? batchConfig.selectionType : null,
            ...(activeSection.key === 'folders' ? { directoryTrees: directoryTrees.trees } : {}),
        }),
        setSection: id => {
            const section = local.sections.find(candidate => candidate.key === id);
            if (!section) return false;
            setActiveRow(section.row);
            return true;
        },
        runAction: id => {
            const action = localActions.find(candidate => candidate.id === id);
            if (!action || action.disabled) return false;
            runAction(id);
            return true;
        },
        importPlaylistFile: common.declaredActions.actions.includes('home-import-playlist')
            ? async file => (await homeActions.importPlaylistFile(file)).ok
            : undefined,
    });

    // 缝：四行是二级切换（整面翻牌，不换层）；「⋯」里是导入文件夹、刷新、导入歌单文件。
    const sections = useMemo(() => local.sections.map(section => ({
        key: section.key,
        label: section.label,
        active: section.key === activeSection.key,
    })), [activeSection.key, local.sections]);
    const sectionsRef = useRef({ sections: local.sections, setActiveRow });
    sectionsRef.current = { sections: local.sections, setActiveRow };
    const onSelectSection = useMemo(() => (key: string) => {
        const section = sectionsRef.current.sections.find(candidate => candidate.key === key);
        if (section) sectionsRef.current.setActiveRow(section.row);
    }, []);
    const menuKey = localActions.map(action => `${action.id}:${action.labelKey}:${action.disabled}`).join('|');
    const menu = useMemo<BravaisSeamMenuItem[]>(() => localActions.map(action => ({
        id: `home-${action.id}`,
        label: t(action.labelKey),
        disabled: action.disabled,
        run: () => runActionRef.current(action.id),
    // localActions 每次渲染都是新数组：按内容比较。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    })), [menuKey, t]);
    const latest = useRef({ homeActions, onOpenGridView });
    latest.current = { homeActions, onOpenGridView };
    const onOpen = useMemo(() => (card: { raw?: unknown }) => {
        latest.current.homeActions.openLocalGroup(card.raw as LocalLibraryGroup, latest.current.onOpenGridView);
    }, []);
    // 直达入口（全部歌曲、本地「我喜欢」）不限当前 section：文件夹与歌单两行的卡片。
    const shortcutCards = useMemo(
        () => local.sections.filter(entry => entry.key === 'folders' || entry.key === 'playlists').flatMap(entry => entry.cards),
        [local.sections],
    );

    return (
        <>
            <input
                ref={playlistFileInputRef}
                type="file"
                accept=".m3u,.m3u8,audio/x-mpegurl,application/vnd.apple.mpegurl"
                hidden
                data-bravais-playlist-file
                onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = '';
                    if (file) void homeActions.importPlaylistFile(file);
                }}
            />
            <BravaisHomeDirectory
                {...common}
                layerKey="home:local"
                source="local"
                section={activeSection.key}
                items={isEmptyLibrary ? [] : activeSection.cards}
                isLoading={false}
                emptyMessage={isEmptyLibrary ? t('localMusic.noLocalMusic') : activeSection.emptyMessage}
                meta={meta}
                sections={isEmptyLibrary ? undefined : sections}
                onSelectSection={onSelectSection}
                menu={menu}
                batchConfig={isEmptyLibrary ? undefined : batchConfig}
                panelTitle={activeSection.label}
                onOpen={onOpen}
                shortcutCards={isEmptyLibrary ? NO_CARDS : shortcutCards}
            />
        </>
    );
};

export const BravaisHomeNavidrome: React.FC<BravaisHomeSourceCommonProps & {
    meta: string;
    overview: LibraryNavidromeHomeResource;
}> = ({ meta, overview, homeActions, onOpenGridView, ...common }) => {
    const { t } = useTranslation();
    const navidrome = useLibraryHomeNavidrome(overview);
    const { config, section, setSection, isLoading } = navidrome;
    const canRefresh = common.declaredActions.actions.includes('home-refresh-navidrome');
    const actions = canRefresh ? navidrome.actions : [];

    useLibraryHomeListRegistration({
        enabled: Boolean(config),
        getState: (): LibraryHomeListState => ({
            tab: 'navidrome',
            directoryKey: common.directoryKey,
            hiddenScope: common.hiddenScope,
            sections: navidrome.sections.map(entry => ({ id: entry.key, label: entry.label, active: entry.active })),
            items: navidrome.items,
            isLoading,
            actions: actions.map(action => ({ id: action.id, label: t(action.labelKey) || action.fallbackLabel || '', disabled: action.disabled })),
            batchSelectionType: null,
        }),
        setSection: id => {
            if (!isNavidromeHomeSection(id)) return false;
            setSection(id);
            return true;
        },
        runAction: id => {
            const action = actions.find(candidate => candidate.id === id);
            if (!action || action.disabled) return false;
            void navidrome.refresh();
            return true;
        },
    });

    const latest = useRef({ navidrome, homeActions, onOpenGridView });
    latest.current = { navidrome, homeActions, onOpenGridView };
    const sections = useMemo(() => navidrome.sections.map(entry => ({ key: entry.key, label: entry.label, active: entry.active })), [navidrome.sections]);
    const onSelectSection = useMemo(() => (key: string) => {
        if (isNavidromeHomeSection(key)) latest.current.navidrome.setSection(key);
    }, []);
    const refresh = actions[0];
    const refreshLabel = refresh ? t(refresh.labelKey) || refresh.fallbackLabel || '' : null;
    const hasConfig = Boolean(config);
    const sourceTools = useMemo<BravaisHomeTool[]>(() => (refreshLabel !== null && hasConfig ? [{
        id: 'refresh-navidrome',
        label: refreshLabel,
        busy: isLoading,
        disabled: isLoading,
        run: () => void latest.current.navidrome.refresh(),
    }] : []), [hasConfig, isLoading, refreshLabel]);
    const onOpen = useMemo(() => (card: Parameters<LibraryHomeActionsController['openNavidromeCard']>[0]) => {
        const { navidrome: current, homeActions: actionsController, onOpenGridView: open } = latest.current;
        actionsController.openNavidromeCard(card, resolveNavidromeCollectionType(current.section, card.id), open);
    }, []);
    // 直达入口（随机、收藏）在歌单 section 里：不经墙打开时按那张卡自己的 section 定集合类型（与在歌单墙上点它一样）。
    const openShortcut = useMemo(() => (card: Parameters<LibraryHomeActionsController['openNavidromeCard']>[0]) => {
        const { homeActions: actionsController, onOpenGridView: open } = latest.current;
        actionsController.openNavidromeCard(card, resolveNavidromeCollectionType('playlists', card.id), open);
    }, []);

    return (
        <BravaisHomeDirectory
            {...common}
            layerKey="home:navidrome"
            source="navidrome"
            section={section}
            items={config ? navidrome.items : []}
            isLoading={Boolean(config) && isLoading}
            emptyMessage={config ? navidrome.emptyMessage : t('navidrome.notConfigured') || 'Navidrome is not configured.'}
            meta={meta}
            sections={config ? sections : undefined}
            onSelectSection={onSelectSection}
            sourceTools={sourceTools}
            panelTitle={navidrome.title}
            onOpen={onOpen}
            shortcutCards={config ? navidrome.cardsBySection.playlists : NO_CARDS}
            openShortcut={openShortcut}
        />
    );
};

const NO_CARDS: LibraryHomeCard[] = [];
