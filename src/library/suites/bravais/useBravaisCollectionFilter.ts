import { useLibrarySessionQuery } from '../../core/bindings/useLibrarySessionQuery';
import { useBravaisSeamFilter } from './useBravaisSeamFilter';

// src/library/suites/bravais/useBravaisCollectionFilter.ts
// 集合页与歌手页的过滤（设计稿 §7.6「过滤：缝里的输入位」）：过滤词在浏览会话里（换 suite 不丢，与网格、TUI 同一个
// port），输入是缝自己的输入位（BravaisSeamFilterField），墙上打字经命令面板的 ownInput 交过来（useBravaisSeamFilter）。
// committedQuery 是墙与范围实际用的过滤词（防抖、输入法组词期间按住组词开始前的那一个）。

export const useBravaisCollectionFilter = ({
    sessionKey,
    isActive,
    allowTyping = true,
}: {
    sessionKey: string;
    isActive: boolean;
    /** 专辑以外的歌单固定全屏墙面，没有过滤输入位，关掉墙上的打字过滤。 */
    allowTyping?: boolean;
}) => {
    const { query, setQuery, port } = useLibrarySessionQuery(sessionKey);
    const committedQuery = useBravaisSeamFilter({ port, query, isActive, allowTyping });
    return { query, setQuery, committedQuery };
};
