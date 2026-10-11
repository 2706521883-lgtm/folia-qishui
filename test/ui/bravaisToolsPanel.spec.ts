import { expect, test, type Page } from '@playwright/test';
import { installBaseState, mockNeteaseApi, openApp, svgDataUrl } from './helpers/appFixtures';

// test/ui/bravaisToolsPanel.spec.ts
// bravais 右下角工具面板在真实应用里的接线（设计稿 §7.5「浮层控件」）：快捷动作经 stage 契约的 tools 端口落到命令面板的
// 同一条命令（队列洗牌 playback-shuffle、生成主题 theme-generate-current，可用性也是命令面板那一份），音量滑条读写
// 应用的音量 store（与播放条、播放页面板同一份）。前往 Lattice 的翻牌交接在 wallHandoff.spec。

test.use({ screenshot: 'only-on-failure' });

const stage = (page: Page) => page.locator('[data-library-stage="bravais"]');
const panel = (page: Page) => page.getByRole('menu', { name: 'Wall tools', exact: true });
const quick = (page: Page, id: string) => panel(page).locator(`[data-wall-tools-quick="${id}"]`);

const boot = async (page: Page) => {
    await installBaseState(page, { neteaseMode: 'guest' });
    await page.addInitScript(() => {
        localStorage.setItem('library_suite', 'bravais');
        localStorage.setItem('player_volume', '0.5');
    });
    await mockNeteaseApi(page, 'guest');
    await openApp(page);
    await expect(stage(page)).toHaveAttribute('data-bravais-layer', /^home:/, { timeout: 20_000 });
    await expect(stage(page)).not.toHaveAttribute('data-bravais-settling', /.*/, { timeout: 15_000 });
};

/** 播放 store 的队列（12 首、第一首在播、没有歌词）与当前状态。 */
const seedQueue = (page: Page) => page.evaluate(async (covers) => {
    const path = '/src/stores/usePlaybackStore.ts';
    const { usePlaybackStore } = await import(/* @vite-ignore */ path);
    const queue = covers.map((coverUrl, index) => ({
        id: 7000 + index,
        name: `Tools Track ${index + 1}`,
        artists: [{ id: 1, name: 'Tools Artist' }],
        album: { id: 1, name: 'Tools Album', coverUrl },
        durationMs: 180_000,
    }));
    usePlaybackStore.setState({ playQueue: queue, currentSong: queue[0] });
}, Array.from({ length: 12 }, (_, index) => svgDataUrl(String(index + 1), `hsl(${(index * 37) % 360} 60% 42%)`)));

const queueIds = (page: Page) => page.evaluate(async () => {
    const path = '/src/stores/usePlaybackStore.ts';
    const { usePlaybackStore } = await import(/* @vite-ignore */ path);
    return (usePlaybackStore.getState().playQueue as { id: number }[]).map(song => song.id);
});

const volumeState = (page: Page) => page.evaluate(async () => {
    const path = '/src/stores/useAudioSettingsStore.ts';
    const { useAudioSettingsStore } = await import(/* @vite-ignore */ path);
    const { volume, isMuted } = useAudioSettingsStore.getState();
    return { volume, isMuted };
});

test('[bravais] the tools panel shuffles the real queue once, gates the theme on lyrics and drives the app volume', async ({ page }) => {
    await boot(page);
    await page.getByRole('button', { name: 'Wall tools', exact: true }).click();
    await expect(panel(page)).toBeVisible();

    // 空队列：不能洗牌（命令面板同一份可用性 + 队列至少两首）。
    await expect(quick(page, 'shuffle-queue')).toBeDisabled();
    await seedQueue(page);
    await expect(quick(page, 'shuffle-queue')).toBeEnabled();
    const before = await queueIds(page);
    await quick(page, 'shuffle-queue').click();
    // 打乱一次：正在播放的那首留在队首，其余换了顺序，同一批歌；面板不收起。
    await expect.poll(async () => (await queueIds(page)).join(',')).not.toBe(before.join(','));
    const after = await queueIds(page);
    expect(after[0]).toBe(before[0]);
    expect([...after].sort()).toEqual([...before].sort());
    await expect(panel(page)).toBeVisible();

    // 有歌但没有歌词（也不是纯音乐）：生成主题不可用，写原因（命令 theme-generate-current 的同一个判定）。
    await expect(quick(page, 'generate-theme')).toBeDisabled();
    await expect(quick(page, 'generate-theme')).toHaveAttribute('aria-description', 'Needs a playing song with lyrics (or pure music)');

    // 音量：方向键改的是应用的音量 store。
    const slider = panel(page).getByRole('slider', { name: 'Volume', exact: true });
    await expect(slider).toHaveAttribute('aria-valuetext', '50%');
    await slider.focus();
    await page.keyboard.press('ArrowUp');
    await expect.poll(() => volumeState(page)).toEqual({ volume: 0.55, isMuted: false });
    await panel(page).getByRole('button', { name: 'Mute', exact: true }).click();
    await expect.poll(() => volumeState(page)).toEqual({ volume: 0.55, isMuted: true });
    await panel(page).getByRole('button', { name: 'Unmute', exact: true }).click();
    await expect.poll(() => volumeState(page)).toEqual({ volume: 0.55, isMuted: false });
});
