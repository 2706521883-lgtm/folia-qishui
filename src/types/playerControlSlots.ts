// src/types/playerControlSlots.ts
// 进度条胶囊右侧两个可自定义槽位的跨层合同。
//
// 只放 id、默认值和校验：store 需要它们来持久化，但不该为此依赖组件层的图标模块。
// 图标和 handler 解析在 src/components/floating-player/playerControlSlotActions.ts。

export type PlayerControlSlotActionId =
    | 'loop'
    | 'prev'
    | 'next'
    | 'shuffle'
    | 'like'
    | 'lyrics-timeline'
    | 'volume'
    | 'queue'
    | 'song-wall'
    | 'sleep-timer'
    /**
     * 不是可指派的槽位动作：只有播放条右侧那颗固定的「队列」按钮用它。
     * 它对应面板页签自己的去处（`panel-queue` 命令 = 开面板并切到队列页签），
     * 与 `queue`（命令面板的队列 surface）不是一件事，所以没进 `PLAYER_CONTROL_SLOT_OPTIONS`，
     * 也没进 `PLAYER_CONTROL_SLOT_ACTION_IDS` —— 设置里不该冒出第二个队列选项，
     * 持久化校验也不该放进一个界面上选不到的值。
     */
    | 'panel-queue';

export const PLAYER_CONTROL_SLOT_ACTION_IDS: readonly PlayerControlSlotActionId[] = [
    'loop',
    'prev',
    'next',
    'shuffle',
    'like',
    'lyrics-timeline',
    'volume',
    'queue',
    'song-wall',
    'sleep-timer',
];

/** 默认保持改动前的样子：循环模式 + 歌词时间轴。 */
export const DEFAULT_PLAYER_CONTROL_SLOT_PRIMARY: PlayerControlSlotActionId = 'loop';
export const DEFAULT_PLAYER_CONTROL_SLOT_SECONDARY: PlayerControlSlotActionId = 'lyrics-timeline';

export const isPlayerControlSlotActionId = (value: unknown): value is PlayerControlSlotActionId => (
    typeof value === 'string' && (PLAYER_CONTROL_SLOT_ACTION_IDS as readonly string[]).includes(value)
);
