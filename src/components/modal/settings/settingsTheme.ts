import type { CSSProperties } from 'react';
import type { Theme } from '../../../types';
import { getContrastRatio } from '../../../utils/themeColorMath';

// src/components/modal/settings/settingsTheme.ts
// 设置窗口的颜色变量（取自上游 0.7.21 的 settings kit）。窗口根节点写一次，卡片、分隔线、
// 开关轨道都从这些变量取色，明暗主题不再各写一份 Tailwind 字符串。

const ON_ACCENT_DARK = '#17171a';
const ON_ACCENT_LIGHT = '#ffffff';

const onAccentColor = (accent: string): string => (
    getContrastRatio(ON_ACCENT_DARK, accent) >= getContrastRatio(ON_ACCENT_LIGHT, accent) ? ON_ACCENT_DARK : ON_ACCENT_LIGHT
);

export const settingsTokens = (isDaylight: boolean, theme?: Theme): CSSProperties => {
    const accent = theme?.accentColor || (isDaylight ? '#18181b' : '#f4f4f5');
    return {
        '--st-win': isDaylight ? '#f3f3f4' : '#1a1a1d',
        '--st-side': isDaylight ? '#e9e9eb' : '#141416',
        '--st-card': isDaylight ? '#ffffff' : '#232327',
        '--st-menu': isDaylight ? '#ffffff' : '#2b2b30',
        '--st-raise': isDaylight ? '#ffffff' : '#45454c',
        '--st-knob': isDaylight ? '#ffffff' : '#ececee',
        '--st-pv': isDaylight ? '#ececef' : '#151517',
        '--st-ok': isDaylight ? '#1e9a5c' : '#56c98d',
        '--st-warn': isDaylight ? '#b97a10' : '#e3a949',
        '--st-err': isDaylight ? '#d04444' : '#ef6f6f',
        '--st-t1': 'var(--text-primary)',
        '--st-t2': 'color-mix(in srgb, var(--text-primary) 62%, transparent)',
        '--st-t3': 'color-mix(in srgb, var(--text-primary) 42%, transparent)',
        '--st-line': 'color-mix(in srgb, var(--text-primary) 8%, transparent)',
        '--st-line2': 'color-mix(in srgb, var(--text-primary) 16%, transparent)',
        '--st-fill': 'color-mix(in srgb, var(--text-primary) 7%, transparent)',
        '--st-fill2': 'color-mix(in srgb, var(--text-primary) 12%, transparent)',
        '--st-track': 'color-mix(in srgb, var(--text-primary) 17%, transparent)',
        '--st-accent': accent,
        '--st-on-accent': onAccentColor(accent),
    } as CSSProperties;
};
