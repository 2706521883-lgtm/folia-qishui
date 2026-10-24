import React from 'react';
import FloatingPlayerControls from '../../FloatingPlayerControls';
import MobileTabBar from '../../mobile/MobileTabBar';
import SearchWorkspace from '../search/SearchWorkspace';
import DevDebugOverlay from '../../DevDebugOverlay';
import MemoryMonitorWindow from '../../debug/MemoryMonitorWindow';
import NowPlayingToast from './NowPlayingToast';
import type { AppOverlaysModel } from './buildAppOverlaysModel';
import { countRender } from '../../../dev/renderCount';
import { useAppChromeStore } from '../../../stores/useAppChromeStore';
import { useDesktopSettingsStore } from '../../../stores/useDesktopSettingsStore';
import { useLatticeControlsStore } from '../../../stores/useLatticeControlsStore';

// Centralized app-level overlay renderer so App.tsx does not mount leaf overlays directly.
type AppOverlaysProps = {
    model: AppOverlaysModel;
};

const AppOverlays: React.FC<AppOverlaysProps> = ({ model }) => {
    countRender('AppOverlays');
    const isCurrentSongPosterVisible = useLatticeControlsStore(state => state.isCurrentSongPosterVisible);
    // Desktop modes are display layers: the floating player bar is not part of them.
    const wallpaperMode = useDesktopSettingsStore(state => state.wallpaperMode);
    const desktopLyricModeActive = useAppChromeStore(state => state.desktopLyricModeActive);
    const {
        searchOverlay,
        debugOverlay,
        memoryMonitor,
        floatingControls,
        nowPlayingToast,
        mobileTabBar,
    } = model;

    return (
        <>
            {searchOverlay && <SearchWorkspace {...searchOverlay} />}

            {debugOverlay && <DevDebugOverlay {...debugOverlay} />}

            {memoryMonitor && <MemoryMonitorWindow {...memoryMonitor} />}

            {floatingControls
                && !wallpaperMode
                && !desktopLyricModeActive
                && (floatingControls.currentView !== 'lattice' || !isCurrentSongPosterVisible)
                && <FloatingPlayerControls {...floatingControls} />}

            {nowPlayingToast && <NowPlayingToast {...nowPlayingToast} />}

            {mobileTabBar && <MobileTabBar {...mobileTabBar} />}
        </>
    );
};

export default React.memo(AppOverlays);
