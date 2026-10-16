import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

// test/component/weSessionUnmountStop.spec.ts
// 「背景层卸载后会话不会一直挂着」的回归闸门：切走背景类型、离开播放页时 WeBackground 是被卸载的
// （停会话的 effect 跑不到），所以卸载后要在宽限期内停掉会话；而切歌词样式引起的卸载-重挂载必须
// 取消这次停，否则每换一次样式引擎就要重启一次。探针：dev/probes/weSessionUnmountStop.probe.tsx。

const calls = (page: Page) => page.evaluate(() => ({ ...window.__weSessionProbe! }));

// 「Mount background」是「Unmount background」的子串，必须精确匹配。
const mountBackground = (page: Page) => page.getByRole('button', { name: 'Mount background', exact: true }).click();
const unmountBackground = (page: Page) => page.getByRole('button', { name: 'Unmount background', exact: true }).click();

test('卸载后 3 秒内没有重新挂载就停会话', async ({ mount, page }) => {
    await mount('weSessionUnmountStop');

    await mountBackground(page);
    await expect.poll(async () => (await calls(page)).stops).toBe(0);

    await unmountBackground(page);
    // 宽限期内不动：切歌样式那种「卸载即重挂载」的抖动不能被当成离开。
    await page.waitForTimeout(1200);
    expect((await calls(page)).stops).toBe(0);

    await expect.poll(async () => (await calls(page)).stops, { timeout: 6000 }).toBe(1);
});

test('宽限期内重新挂载会取消这次停（切歌词样式不重启引擎）', async ({ mount, page }) => {
    await mount('weSessionUnmountStop');

    await mountBackground(page);
    await unmountBackground(page);
    await page.waitForTimeout(1000);
    await mountBackground(page);

    await page.waitForTimeout(4000);
    const after = await calls(page);
    expect(after.stops).toBe(0);
    expect(after.starts).toBe(0);
});
