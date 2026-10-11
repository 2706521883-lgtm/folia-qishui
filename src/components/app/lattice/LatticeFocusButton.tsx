import { Crosshair, Focus, ListMusic } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useLatticeControlsStore } from '../../../stores/useLatticeControlsStore';
import { useLatticeSettingsStore } from '../../../stores/useLatticeSettingsStore';
import { openCommandPaletteCommand } from '../../../stores/useAppViewStore';
import { PRIMARY_MODIFIER_LABEL } from '../../../utils/platform';
import WallToolsButton, { type WallToolsEntry } from '../../wall/WallToolsButton';

// src/components/app/lattice/LatticeFocusButton.tsx
// A compact Lattice-only utility panel. It borrows UnifiedPanel's anchored glass surface without
// bringing its cover, tabs or player-only state into the poster wall.
// 实测反馈 1 起按钮、面板、灯光 / 叠色开关、帮助的外壳都在共享的 components/wall/WallToolsButton（bravais 也用）；
// 这里只给 Lattice 自己的三行（聚焦当前歌曲、切歌自动聚焦、队列命令）与帮助内容。
export default function LatticeFocusButton({ isDaylight }: { isDaylight: boolean }) {
    const { t } = useTranslation();
    const focusCurrentSong = useLatticeControlsStore(state => state.focusCurrentSong);
    const autoFocusOnSongChange = useLatticeSettingsStore(state => state.autoFocusOnSongChange);
    const handleToggleAutoFocusOnSongChange = useLatticeSettingsStore(state => state.handleToggleAutoFocusOnSongChange);
    const queueShortcut = `${PRIMARY_MODIFIER_LABEL}+P`;

    const entries: WallToolsEntry[] = [
        {
            kind: 'action',
            id: 'focus-current',
            icon: Crosshair,
            label: t('home.latticeFocusCurrent'),
            kbd: ': + C',
            kbdHidden: true,
            disabled: !focusCurrentSong,
            onSelect: () => focusCurrentSong?.(),
        },
        {
            kind: 'toggle',
            id: 'auto-focus',
            icon: Focus,
            label: t('home.latticeAutoFocusOnSongChange'),
            checked: autoFocusOnSongChange,
            onToggle: handleToggleAutoFocusOnSongChange,
        },
        {
            kind: 'action',
            id: 'queue-command',
            icon: ListMusic,
            label: t('home.latticeOpenQueueCommand'),
            kbd: queueShortcut,
            onSelect: () => openCommandPaletteCommand('queue'),
        },
    ];

    return (
        <WallToolsButton
            idPrefix="lattice-tools"
            label={t('home.latticeTools')}
            isDaylight={isDaylight}
            entries={entries}
            help={(
                <>
                    <li>
                        <span>{t('home.latticeHelpPoster')}</span>
                        <span className="lattice-tools-help-key"><kbd>ESC</kbd>{t('home.latticeHelpReturn')}</span>
                    </li>
                    <li><span>{t('home.latticeHelpMove')}</span></li>
                    <li>
                        <span>{t('home.latticeHelpCommands')}</span>
                        <kbd>S</kbd>
                    </li>
                    <li>
                        <span>{t('home.latticeHelpOpen')}</span>
                        <kbd>{PRIMARY_MODIFIER_LABEL} + B</kbd>
                    </li>
                </>
            )}
        />
    );
}
