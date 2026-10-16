import React from 'react';
import { useTranslation } from 'react-i18next';
import { resolvePlayerControlSlot, type PlayerControlSlotActionId, type PlayerControlSlotContext } from './playerControlSlotActions';

// src/components/floating-player/PlayerControlSlotButton.tsx
// 进度条胶囊右侧的一个可自定义槽位。样式沿用原来写死的循环 / 歌词时间轴按钮。

interface PlayerControlSlotButtonProps {
    actionId: PlayerControlSlotActionId;
    context: PlayerControlSlotContext;
    primaryColor: string;
    isDaylight?: boolean;
    /** 定位模式或播放源不可控时，整排按钮一起失效。 */
    controlsDisabled?: boolean;
    /**
     * 是否打 `data-ponder-slot` 标记。可配置槽位必须打：那是槽位配置的唯一真源，
     * 思索和它那几条计数断言都按它数数。固定按钮（播放条上的「队列拼贴」）复用的只是
     * 这一份渲染，它不占槽位，打上标记会让播放条凭空多出一个槽位。
     */
    markAsPonderSlot?: boolean;
    /**
     * 覆盖提示文本。槽位在设置里各有各的叫法（`song-wall` 是「播放队列（海报）」），
     * 但固定按钮对应的是队列面板里那颗「队列拼贴」——两处说的是一件事，用词得一致；
     * 而且「播放队列（海报）」和 `queue` 槽位的「播放队列」几乎同名，读屏和选择器都分不开。
     */
    labelKeyOverride?: string;
    className?: string;
}

const PlayerControlSlotButton: React.FC<PlayerControlSlotButtonProps> = ({
    actionId,
    context,
    primaryColor,
    isDaylight,
    controlsDisabled = false,
    markAsPonderSlot = true,
    labelKeyOverride,
    className = '',
}) => {
    const { t } = useTranslation();
    const slot = resolvePlayerControlSlot(actionId, context);
    const Icon = slot.icon;
    const disabled = slot.disabled || controlsDisabled;
    const label = t(labelKeyOverride ?? slot.labelKey);

    // 三段视觉：已开启（循环非 off / 已喜爱）高亮，不可用压暗，其余是低透明度的常态。
    const stateClass = disabled
        ? 'cursor-not-allowed opacity-20'
        : slot.active
            ? (isDaylight ? 'bg-black/10 text-black' : 'bg-white/20')
            : `opacity-40 hover:opacity-100 ${isDaylight ? 'hover:bg-black/5' : 'hover:bg-white/10'}`;

    return (
        <button
            type="button"
            // 思索教程按它认这个槽位放的是哪个动作。纯标记，不参与任何行为。
            data-ponder-slot={markAsPonderSlot ? actionId : undefined}
            onClick={(e) => {
                e.stopPropagation();
                if (disabled) {
                    return;
                }
                slot.onActivate();
            }}
            disabled={disabled}
            className={`rounded-full p-2 transition-colors ${stateClass} ${className}`}
            style={{ color: primaryColor }}
            title={label}
            aria-label={label}
        >
            <Icon
                size={20}
                className="sm:h-[18px] sm:w-[18px]"
                fill={slot.filled ? 'currentColor' : 'none'}
            />
        </button>
    );
};

export default PlayerControlSlotButton;
