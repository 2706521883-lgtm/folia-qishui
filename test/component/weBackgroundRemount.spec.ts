import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures';

// test/component/weBackgroundRemount.spec.ts
// 切换歌词样式时壁纸「模糊一下」的回归闸门：模式切换会重建整个 visualizer 子树，背景层重挂载时
// 必须复用仍在运行的采集流——不重开 getUserMedia、不退回低清预览图（那张预览图就是用户看到的模糊
// 画面）。探针是 dev/probes/weBackgroundRemount.probe.tsx，采集用 canvas.captureStream 造假。

const poster = '[data-we-poster]';

/** 视频元素拿到帧的标志：videoWidth 来自已解码的帧，没有流时一直是 0。 */
const videoWidth = (locator: Locator) => locator.evaluate(element => (element as HTMLVideoElement).videoWidth);

/**
 * 预览图出现次数。必须在页面脚本之前装上：冷启动那张预览图跟着第一次 commit 一起进 DOM，
 * 等用例跑起来再 observe 就已经错过它了（探针自己的 useLayoutEffect 也来不及）。
 */
const watchPosters = (page: Page) => page.addInitScript(() => {
    const watch = { appearances: 0 };
    (window as unknown as { __wePosterWatch: typeof watch }).__wePosterWatch = watch;
    new MutationObserver(records => {
        for (const record of records) {
            for (const node of Array.from(record.addedNodes)) {
                if (node instanceof Element && (node.matches('[data-we-poster]') || node.querySelector('[data-we-poster]'))) {
                    watch.appearances += 1;
                }
            }
        }
    }).observe(document, { childList: true, subtree: true });
});

const posterAppearances = (page: Page) => page.evaluate(() => (
    (window as unknown as { __wePosterWatch: { appearances: number } }).__wePosterWatch.appearances
));

test('切歌词样式复用采集流、不退回低清预览图', async ({ mount, page }) => {
    await watchPosters(page);
    const component = await mount('weBackgroundRemount');
    const video = component.locator('video');

    // 冷启动：先等采集接上。此前那张预览图是设计内的回退，不计入回归。
    await expect.poll(() => videoWidth(video)).toBeGreaterThan(0);
    const coldStartPosters = await posterAppearances(page);
    expect(coldStartPosters).toBe(1);

    expect(await page.evaluate(() => {
        window.__weRemountProbe!.firstStream = (document.querySelector('video') as HTMLVideoElement).srcObject as MediaStream;
        return window.__weRemountProbe!.getUserMediaCalls;
    })).toBe(1);

    await component.getByRole('button', { name: 'Switch lyric style' }).click();

    // 新视频元素接的是同一条流：重挂载复用了缓存，而不是关掉重开。
    await expect.poll(() => page.evaluate(() => (
        (document.querySelector('video') as HTMLVideoElement).srcObject === window.__weRemountProbe!.firstStream
    ))).toBe(true);
    await expect.poll(() => videoWidth(video)).toBeGreaterThan(0);

    const afterSwitch = await page.evaluate(() => ({
        posters: (window as unknown as { __wePosterWatch: { appearances: number } }).__wePosterWatch.appearances,
        calls: window.__weRemountProbe!.getUserMediaCalls,
        posterInDom: Boolean(document.querySelector('[data-we-poster]')),
    }));
    expect(afterSwitch.posters).toBe(coldStartPosters);
    expect(afterSwitch.posterInDom).toBe(false);
    expect(afterSwitch.calls).toBe(1);
});

test('采集接上之前的预览图回退仍然有效', async ({ mount, page }) => {
    await watchPosters(page);
    const component = await mount('weBackgroundRemount');

    // 冷启动第一帧就是回退态（此时还没有流），预览图必须在，接上后让位给实时画面。
    await expect.poll(() => posterAppearances(page)).toBe(1);
    await expect.poll(() => videoWidth(component.locator('video'))).toBeGreaterThan(0);
    await expect(component.locator(poster)).toHaveCount(0);
});
