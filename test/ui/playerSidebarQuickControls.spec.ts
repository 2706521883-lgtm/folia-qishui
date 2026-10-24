import { expect, test } from '@playwright/test';
import { installBaseState, mockNeteaseApi, openApp } from './helpers/appFixtures';

// test/ui/playerSidebarQuickControls.spec.ts
// 播放器右上角侧栏的「快捷控制」在播放面板关着的时候也要能打开音频效果器。
// 对话框以前只挂在面板的控制页里：点按只会把 store 置位，面板打开前什么也不渲染。

test('player-sidebar audio effects tile opens the dialog with the panel closed', async ({ page }) => {
  await installBaseState(page, { neteaseMode: 'logged-in' });
  await page.addInitScript(() => {
    // 侧栏的标题键没有英文资源，只有 ui.* 会跟着语言走；钉住中文，断言才不混着两种语言。
    localStorage.setItem('folia_app_language', 'zh-CN');
    localStorage.setItem('open_player_on_launch', 'true');
  });
  await mockNeteaseApi(page, 'logged-in');
  await openApp(page);

  const sidebar = page.locator('aside[aria-label="在线音乐导航"]');
  await expect(sidebar).toBeVisible();

  await sidebar.getByRole('button', { name: '快捷控制' }).click();
  await sidebar.getByRole('button', { name: '音频效果器' }).click();

  // 不经过左下角的面板开关，对话框直接出现在应用层。
  await expect(page.getByRole('heading', { name: '音频效果器' })).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page.getByRole('heading', { name: '音频效果器' })).toBeHidden();
});
