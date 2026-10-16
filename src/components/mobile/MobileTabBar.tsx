import React from 'react';
import { Home, LayoutGrid, Search, Settings } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useAppViewStore } from '../../stores/useAppViewStore';
import { useCollectionNavigationStore } from '../../stores/useCollectionNavigationStore';
import {
    type SearchReturnView,
    type SearchSource,
    useSearchNavigationStore,
} from '../../stores/useSearchNavigationStore';
import { openSettings } from '../../stores/useSettingsModalStore';
import { useThemeSettingsStore } from '../../stores/useThemeSettingsStore';
import { useIsMobileTabBarVisible } from '../../hooks/useMobileShellLayout';
import { MOBILE_TAB_BAR_HEIGHT_PX } from '../../utils/mobileShellLayout';

// src/components/mobile/MobileTabBar.tsx
// 移动壳（<1024）的底部 Tab 栏：首页 / 队列拼贴 / 搜索 / 设置。
//
// 四个入口全部复用现有导航动作，不新造路由：首页 = navigateDirectHome（清集合与搜索、替换
// 当前历史记录，不堆积记录）、队列拼贴 = navigateToLattice（FM 下由它自己提示并拒绝）、
// 搜索 = navigateToSearch（全屏搜索页本来就长在 home 视图上）、设置 = openSettings（模态）。
//
// 在场判定走 useIsMobileTabBarVisible 单一出口（宽度 + 页面 + 窗口形态）；贴底一族的上抬
// 由 usePlayerBottomBarBottomPx 消费同一个判定，所以栏在不在场和谁让位永远一致。
//
// 高度常量与几何解释见 src/utils/mobileShellLayout.ts。

export type MobileTabBarProps = {
    /** 直接回首页（清掉集合栈与搜索页，替换当前历史记录）。 */
    onHome: () => void;
    /** 进入队列拼贴。 */
    onLattice: () => void;
    /** 打开全屏搜索页；沿用应用内保留的上一次查询词。 */
    onSearch: (params: { query: string; sourceTab: SearchSource; returnView: SearchReturnView }) => void;
};

const MobileTabBar: React.FC<MobileTabBarProps> = ({ onHome, onLattice, onSearch }) => {
    const { t } = useTranslation();
    const isVisible = useIsMobileTabBarVisible();
    const view = useAppViewStore(state => state.view);
    const isSearchOpen = useSearchNavigationStore(state => state.isSearchOpen);
    const hasCollection = useCollectionNavigationStore(state => Boolean(state.snapshot?.stack.length));
    const isDaylight = useThemeSettingsStore(state => state.isDaylight);

    if (!isVisible) {
        return null;
    }

    const isHomeActive = view === 'home' && !isSearchOpen;

    const handleHome = () => {
        // 已经站在首页根部（没有集合、也没有搜索页）时不动作：别往历史里压重复记录。
        if (view === 'home' && !isSearchOpen && !hasCollection) return;
        onHome();
    };

    const handleLattice = () => {
        if (view === 'lattice') return;
        onLattice();
    };

    const handleSearch = () => {
        if (isSearchOpen) return;
        const searchState = useSearchNavigationStore.getState();
        onSearch({
            query: searchState.searchQuery,
            sourceTab: searchState.searchSourceTab,
            returnView: 'home',
        });
    };

    const items = [
        { id: 'home', label: t('mobileTabBar.home'), icon: Home, active: isHomeActive, onClick: handleHome },
        { id: 'lattice', label: t('mobileTabBar.lattice'), icon: LayoutGrid, active: view === 'lattice', onClick: handleLattice },
        { id: 'search', label: t('mobileTabBar.search'), icon: Search, active: isSearchOpen, onClick: handleSearch },
        { id: 'settings', label: t('mobileTabBar.settings'), icon: Settings, active: false, onClick: () => { openSettings(); } },
    ];

    return (
        <nav
            data-testid="mobile-tab-bar"
            aria-label={t('mobileTabBar.ariaLabel')}
            className={`fixed inset-x-0 bottom-0 z-40 touch-manipulation select-none border-t backdrop-blur-xl lg:hidden ${
                isDaylight ? 'border-white/20 bg-white/60' : 'border-white/5 bg-black/40'
            }`}
            style={{
                paddingBottom: 'var(--safe-bottom)',
                paddingLeft: 'var(--safe-left)',
                paddingRight: 'var(--safe-right)',
            }}
        >
            <div className="flex items-stretch" style={{ height: MOBILE_TAB_BAR_HEIGHT_PX }}>
                {items.map(item => (
                    <button
                        key={item.id}
                        type="button"
                        onClick={item.onClick}
                        aria-label={item.label}
                        aria-current={item.active ? 'page' : undefined}
                        className="flex flex-1 flex-col items-center justify-center gap-0.5 outline-none transition-opacity active:opacity-60"
                        style={{
                            color: item.active
                                ? 'var(--text-primary, #e4e4e7)'
                                : 'var(--text-secondary, rgba(228,228,231,0.62))',
                        }}
                    >
                        <item.icon size={22} strokeWidth={item.active ? 2.4 : 2} />
                        <span className="text-[10px] font-medium leading-none">{item.label}</span>
                    </button>
                ))}
            </div>
        </nav>
    );
};

export default React.memo(MobileTabBar);
