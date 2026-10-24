import React from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ArrowUpDown, Check, Moon, RefreshCw, Sun } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Theme } from '../../../types';
import type { ThemeSourceModel } from '../../../hooks/themeControllerState';
import { useThemeQuickEditorStore } from '../../../stores/useThemeQuickEditorStore';
import { useThemeSyncAction } from '../../../hooks/useThemeSyncAction';

// src/components/panelTab/controls/ThemeQuickRow.tsx
// The current-theme line from the controls tab: daylight toggle, quick editor and sync state.
// The Qishui sidebar reuses it under its theme-source picker.
export type ThemeQuickRowProps = {
    theme: Theme;
    themeSourceModel: ThemeSourceModel;
    defaultTheme: Theme;
    daylightTheme: Theme;
    isDaylight: boolean;
    onToggleDaylight: () => void;
};

const ThemeQuickRow: React.FC<ThemeQuickRowProps> = ({
    theme,
    themeSourceModel,
    defaultTheme,
    daylightTheme,
    isDaylight,
    onToggleDaylight,
}) => {
    const { t } = useTranslation();
    const openThemeQuickEditor = useThemeQuickEditorStore(state => state.openEditor);
    const { themeSyncState, runThemeSync } = useThemeSyncAction();

    const formatThemeDisplayName = (name: string) => {
        if (themeSourceModel.activeSource !== 'default') {
            return name;
        }

        return name === defaultTheme.name
            ? t('theme.midnightDefault')
            : (name === daylightTheme.name ? t('theme.daylightDefault') : name);
    };

    const activeThemeSource = themeSourceModel.current;
    const currentEditableSource = themeSourceModel.editableSource;
    const themeDisplayName = formatThemeDisplayName(activeThemeSource.label || theme.name);

    const openCurrentThemeQuickEditor = () => {
        if (currentEditableSource) {
            openThemeQuickEditor(currentEditableSource);
        }
    };

    return (
        <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
                <button
                    type="button"
                    onClick={onToggleDaylight}
                    className={`rounded-md p-1 transition-all ${isDaylight ? 'text-amber-500' : 'text-blue-300'}`}
                    title={isDaylight ? t('theme.switchToDark') : t('theme.switchToLight')}
                    aria-label={isDaylight ? t('theme.switchToDark') : t('theme.switchToLight')}
                >
                    {isDaylight ? <Sun size={14} /> : <Moon size={14} />}
                </button>
                {currentEditableSource ? (
                    <button
                        type="button"
                        onClick={openCurrentThemeQuickEditor}
                        className={`max-w-[120px] truncate rounded-md px-1.5 py-1 text-left text-xs font-bold transition-colors ${isDaylight ? 'hover:bg-black/10' : 'hover:bg-white/10'}`}
                        title={currentEditableSource === 'custom'
                            ? (t('options.customThemeQuickEditTitle') || 'Edit Custom Theme')
                            : (t('options.aiThemeQuickEditTitle') || 'Edit AI Theme')}
                    >
                        {themeDisplayName}
                    </button>
                ) : (
                    <span className="max-w-[120px] truncate text-xs font-bold">
                        {themeDisplayName}
                    </span>
                )}
                {themeSourceModel.activeSource !== 'default' && (
                    <button
                        onClick={() => void runThemeSync()}
                        disabled={themeSyncState === 'syncing'}
                        className={`rounded-full p-1 transition-colors disabled:cursor-wait ${isDaylight ? 'hover:bg-black/10' : 'hover:bg-white/10'}`}
                        title={themeSyncState === 'syncing'
                            ? t('options.syncing')
                            : themeSyncState === 'complete'
                                ? t('ui.synced')
                                : t('commandPalette.commands.sync-now.title')}
                    >
                        <AnimatePresence mode="wait" initial={false}>
                            <motion.span
                                key={themeSyncState}
                                initial={{ opacity: 0, scale: 0.55, rotate: -35 }}
                                animate={{ opacity: 1, scale: 1, rotate: 0 }}
                                exit={{ opacity: 0, scale: 0.55, rotate: 35 }}
                                transition={{ duration: 0.16, ease: 'easeOut' }}
                                className="block"
                            >
                                {themeSyncState === 'syncing' ? (
                                    <RefreshCw size={12} className="animate-spin" />
                                ) : themeSyncState === 'complete' ? (
                                    <Check size={12} className="text-green-500" strokeWidth={3} />
                                ) : (
                                    <ArrowUpDown size={12} />
                                )}
                            </motion.span>
                        </AnimatePresence>
                    </button>
                )}
            </div>
        </div>
    );
};

export default ThemeQuickRow;
