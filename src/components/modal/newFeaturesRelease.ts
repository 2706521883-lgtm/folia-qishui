import { ListChecks, ListMusic, MonitorOff, ShieldCheck, Sparkles, Timer } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

// src/components/modal/newFeaturesRelease.ts

type NewFeatureCard = {
    id: string;
    icon: LucideIcon;
    daylightIconClassName: string;
    darkIconClassName: string;
};

type NewFeaturesRelease = {
    i18nKey: string;
    /** 重大更新：介绍上方显示「<代号> Update · 重大更新」标签；代号不翻译，文案在 help.majorUpdateLabel。 */
    majorUpdate?: { codename: string };
    features: NewFeatureCard[];
};

// Defines the current release's cards; their localized text lives under i18nKey in every locale.
export const NEW_FEATURES_RELEASE: NewFeaturesRelease = {
    i18nKey: 'releaseNotes.v0_3_4',
    features: [
        { id: 'recommendFeed', icon: Sparkles, daylightIconClassName: 'text-violet-600', darkIconClassName: 'text-violet-400' },
        { id: 'recommendAppend', icon: ListMusic, daylightIconClassName: 'text-sky-600', darkIconClassName: 'text-sky-400' },
        { id: 'recommendTimeout', icon: Timer, daylightIconClassName: 'text-amber-600', darkIconClassName: 'text-amber-400' },
        { id: 'recommendDedupe', icon: ListChecks, daylightIconClassName: 'text-emerald-600', darkIconClassName: 'text-emerald-400' },
        { id: 'qqRoute', icon: ShieldCheck, daylightIconClassName: 'text-cyan-600', darkIconClassName: 'text-cyan-400' },
        { id: 'pauseVisualizer', icon: MonitorOff, daylightIconClassName: 'text-rose-600', darkIconClassName: 'text-rose-400' },
    ],
};
