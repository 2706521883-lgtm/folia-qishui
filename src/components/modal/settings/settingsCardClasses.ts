// src/components/modal/settings/settingsCardClasses.ts
// The card and toggle-track classes the options panel dresses its sections with.
//
// Declared here rather than inline in SettingsModal because a settings section can now be rendered
// outside it — the command palette hosts GridViewSettingsSection on a surface — and a section that
// carries the panel's look must not depend on a second hand-kept copy of these strings.
// LabSettingsModal keeps its own pair on purpose: it sits on a different panel background.

// The colors come from the settings window's variables (settingsTheme.ts), so light and dark share
// one string and a custom theme's accent reaches the controls. `isDaylight` stays in the signature
// because every caller already passes it and a few surfaces render outside the settings window.
export const settingsCardClassFor = (isDaylight: boolean) => (
    isDaylight
        ? 'bg-[color:var(--st-card,#ffffff)] border-[color:var(--st-line,rgba(0,0,0,0.08))]'
        : 'bg-[color:var(--st-card,#232327)] border-[color:var(--st-line,rgba(255,255,255,0.08))]'
);

export const settingsToggleOffClassFor = (isDaylight: boolean) => (
    isDaylight ? 'bg-[color:var(--st-track,#d4d4d8)]' : 'bg-[color:var(--st-track,rgba(255,255,255,0.17))]'
);

// Hairline between rows inside a settings card.
export const settingsDividerClassFor = (isDaylight: boolean) => (
    isDaylight ? 'border-[color:var(--st-line,rgba(0,0,0,0.08))]' : 'border-[color:var(--st-line,rgba(255,255,255,0.08))]'
);
