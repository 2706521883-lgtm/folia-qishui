import React, { useCallback, useSyncExternalStore } from 'react';
import { Blinds, Crosshair, PanelsTopLeft, Shuffle, Sparkles, Volume1, Volume2, VolumeX } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import WallBackButton from '../../../components/wall/WallBackButton';
import WallToolsButton, { type WallToolsEntry, type WallToolsQuickAction } from '../../../components/wall/WallToolsButton';
import { useAudioSettingsStore } from '../../../stores/useAudioSettingsStore';
import { useLibraryWallLookStore } from '../../../stores/useLibraryWallLookStore';
import { PRIMARY_MODIFIER_LABEL } from '../../../utils/platform';
import type { LibraryWallLook } from '../../../utils/libraryWallLook';
import type { LibraryStageToolsPort, LibraryStageToolsSnapshot } from '../../core/contracts/ports';
import { BRAVAIS_HELP_ROWS } from './bravaisHelp';
import { nextWallLook } from './bravaisLook';
import type { BravaisBackStep } from './bravaisBack';

// src/library/suites/bravais/BravaisStageChrome.tsx
// bravais 墙上的两颗浮层控件（实测反馈 1，设计稿 §7.5「浮层控件」），与 Lattice 共用 components/wall 的同一套：
// - 左上角隐藏式返回（WallBackButton concealed）：做什么由 stage 按 bravaisBack 定——不在首页根层时与缝里的 ‹ 同一个返回
//   （先关面板 / 表单，再退层），可访问名「返回」；首页根层有歌时回到播放页（「回到播放页」），没有歌时不画。
//   z-index 在缝之下：缝正好开在左上角时让缝的按钮在上面。
// - 右下角工具按钮（WallToolsButton）：面板按功能分三组——
//   1. 顶部一排图标快捷动作（一次性动作）：定位正在播放（外观动作 locate-playing）、队列洗牌、为当前歌曲生成主题（宿主经
//      stage 契约的 tools 端口，命令面板的同一条命令）、前往 Lattice（宿主的 onOpenLattice，首页工具格「队列拼贴」同一个入口）；
//   2. 音量滑条（连续量：读写应用的音量 store，与播放条 / 播放页面板同一份；拖动时经端口预览、松手才写；左侧图标静音切换）；
//   3. 「墙面外观」：透光（循环三档，面板不收起）、共享的叠色开关、开灯 / 关灯；帮助在右下角（行在 bravaisHelp）。
//   滑动打开命令面板。不碰相机与显示：定位走外观动作的同一个实现，透光写 app 层偏好（与命令面板的 wall-look 同一条路）。

const LOOK_LABEL_KEYS: Record<LibraryWallLook, string> = {
    solid: 'options.libraryWallLookSolid',
    partial: 'options.libraryWallLookPartial',
    clear: 'options.libraryWallLookClear',
};

const NO_TOOLS_SNAPSHOT: LibraryStageToolsSnapshot = { themeGeneration: 'unavailable', canShuffleQueue: false };
const noopSubscribe = () => () => {};
const readNoToolsSnapshot = () => NO_TOOLS_SNAPSHOT;

/** 音量图标随显示的值变（与播放页面板的音量行同一套：0 / 静音、小于一半、其余）。 */
const volumeIcon = (value: number) => (value === 0 ? VolumeX : value < 0.5 ? Volume1 : Volume2);

/** 拖动或按键改音量时先解除静音（拖到一个音量就是想听见它）。 */
const unmuteForVolumeChange = () => {
    const audio = useAudioSettingsStore.getState();
    if (audio.isMuted) audio.handleToggleMute();
};

type BravaisStageChromeProps = {
    isDaylight: boolean;
    /** 左上角返回此刻的去处（null：不画）；run 在点击时按最新状态再判一次。 */
    back: { step: BravaisBackStep; run: () => void } | null;
    /** 外观动作 locate-playing（useBravaisChromeActions 的那一份）。 */
    locatePlaying: { isAvailable: () => boolean; run: () => void };
    /** 进入 Lattice（stage 契约的 onOpenLattice）；缺省时快捷动作里没有这一格。 */
    onOpenLattice?: () => void;
    /** 宿主的工具端口（stage 契约的 tools：生成主题、队列洗牌、音量预览）；缺省时没有洗牌与主题两格，音量拖动时不预览。 */
    tools?: LibraryStageToolsPort;
    /**
     * 工具按钮此刻认领 App 的 dock（WallToolsDock）：墙显示着（首页层可交互、当前层归 bravais），或正在交接里离开（Lattice
     * 后认领、盖在上面，按钮不闪）。不在 dock 里（组件探针）时不看它。
     */
    toolsClaimed?: boolean;
};

const BravaisStageChrome: React.FC<BravaisStageChromeProps> = ({
    isDaylight,
    back,
    locatePlaying,
    onOpenLattice,
    tools,
    toolsClaimed = true,
}) => {
    const { t } = useTranslation();
    const look = useLibraryWallLookStore(state => state.look);
    const setLook = useLibraryWallLookStore(state => state.setLook);
    const volume = useAudioSettingsStore(state => state.volume);
    const isMuted = useAudioSettingsStore(state => state.isMuted);
    const toolsSnapshot = useSyncExternalStore(tools?.subscribe ?? noopSubscribe, tools?.getSnapshot ?? readNoToolsSnapshot);

    // 面板打开着渲染时才求值：正在播放的那首此刻在不在墙上（与命令面板里同一个判定）。
    const quickActions = useCallback((): WallToolsQuickAction[] => {
        const actions: WallToolsQuickAction[] = [{
            id: 'locate-playing',
            icon: Crosshair,
            label: t('libraryBravais.toolsLocate'),
            shortLabel: t('libraryBravais.toolsLocateShort'),
            kbd: ': + C',
            disabled: !locatePlaying.isAvailable(),
            onSelect: locatePlaying.run,
        }];
        if (tools) {
            const themeBusy = toolsSnapshot.themeGeneration === 'busy';
            actions.push({
                id: 'shuffle-queue',
                icon: Shuffle,
                label: t('libraryBravais.toolsShuffle'),
                shortLabel: t('libraryBravais.toolsShuffleShort'),
                kbd: ': + R',
                disabled: !toolsSnapshot.canShuffleQueue,
                status: toolsSnapshot.canShuffleQueue ? undefined : t('libraryBravais.toolsShuffleUnavailable'),
                // 不收起：洗完还能再洗一次，提示条报「播放队列已打乱」。
                keepOpen: true,
                onSelect: tools.shuffleQueue,
            }, {
                id: 'generate-theme',
                icon: Sparkles,
                label: t('libraryBravais.toolsTheme'),
                shortLabel: t('libraryBravais.toolsThemeShort'),
                disabled: toolsSnapshot.themeGeneration !== 'ready',
                busy: themeBusy,
                status: themeBusy
                    ? t('libraryBravais.toolsThemeBusy')
                    : toolsSnapshot.themeGeneration === 'unavailable' ? t('libraryBravais.toolsThemeUnavailable') : undefined,
                statusShort: t('libraryBravais.toolsThemeBusyShort'),
                // 不收起：让人看到「生成中」，生成完按钮恢复。
                keepOpen: true,
                onSelect: tools.generateTheme,
            });
        }
        if (onOpenLattice) {
            actions.push({
                id: 'open-lattice',
                icon: PanelsTopLeft,
                label: t('libraryBravais.toolsLattice'),
                shortLabel: t('libraryBravais.toolsLatticeShort'),
                kbd: `${PRIMARY_MODIFIER_LABEL} + B`,
                // 收起：dock 里的按钮是同一颗，进了 Lattice 不能还开着、换成 Lattice 的条目。
                onSelect: onOpenLattice,
            });
        }
        return actions;
    }, [locatePlaying, onOpenLattice, t, tools, toolsSnapshot]);

    const entries = useCallback((): WallToolsEntry[] => [
        {
            kind: 'slider',
            id: 'volume',
            label: t('ui.volume'),
            value: isMuted ? 0 : volume,
            icon: Volume2,
            iconFor: volumeIcon,
            iconAction: {
                label: isMuted ? t('libraryBravais.toolsUnmute') : t('libraryBravais.toolsMute'),
                pressed: isMuted,
                onPress: () => useAudioSettingsStore.getState().handleToggleMute(),
            },
            formatValue: value => (isMuted ? t('libraryBravais.toolsMuted') : `${Math.round(value * 100)}%`),
            onPreview: value => {
                unmuteForVolumeChange();
                tools?.previewVolume(value);
            },
            onCommit: value => {
                unmuteForVolumeChange();
                useAudioSettingsStore.getState().handleSetVolume(value);
            },
        },
        { kind: 'heading', id: 'appearance', label: t('libraryBravais.toolsAppearance') },
        {
            kind: 'action',
            id: 'wall-look',
            icon: Blinds,
            label: t('options.libraryWallLook'),
            value: t(LOOK_LABEL_KEYS[look]),
            keepOpen: true,
            onSelect: () => setLook(nextWallLook(look)),
        },
    ], [isMuted, look, setLook, t, tools, volume]);

    return (
        <>
            {back && (
                <WallBackButton
                    label={back.step === 'player' ? t('libraryBravaisHome.backToPlayer') : t('libraryBravais.seamBack')}
                    onBack={back.run}
                    concealed
                />
            )}
            <WallToolsButton
                idPrefix="bravais-tools"
                label={t('libraryBravais.tools')}
                claimed={toolsClaimed}
                isDaylight={isDaylight}
                quickActions={quickActions}
                entries={entries}
                help={BRAVAIS_HELP_ROWS.map(row => (
                    <li key={row.id} data-bravais-help={row.id}>
                        <span>{t(row.labelKey)}</span>
                        <kbd>{row.kbd(PRIMARY_MODIFIER_LABEL)}</kbd>
                    </li>
                ))}
            />
        </>
    );
};

export default React.memo(BravaisStageChrome);
