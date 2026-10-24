import { expect, test } from '@playwright/test';
import { installBaseState, mockNeteaseApi, openApp, neteaseFixtures, svgDataUrl } from './helpers/appFixtures';

// test/ui/playerSidebarPlaylistLattice.spec.ts
// 播放器侧栏的歌单入口和首页一样：点击后把整张歌单写入播放队列并进入 Lattice 队列拼贴，
// 而不是打开 Bravais 海报墙集合页。这里用模拟登录的网易云验证「我喜欢的音乐」这一行。
// 音频地址故意不提供：本用例只关心队列与视图，起播失败不影响拼贴是否拿到队列。

const likedPlaylist = {
  id: 9003,
  name: '我喜欢的音乐',
  specialType: 5,
  coverImgUrl: svgDataUrl('Liked', '#e11d48'),
  trackCount: 2,
  creator: neteaseFixtures.profile,
};

const playlistPayload = neteaseFixtures.playlists.map(playlist => ({
  ...playlist,
  creator: neteaseFixtures.profile,
  description: `${playlist.name} fixture playlist`,
}));

const trackPayload = {
  songs: [
    {
      id: 7001,
      name: 'Cloud Archive',
      ar: [{ id: 11, name: 'Cloud Artist' }],
      al: { id: 101, name: 'Cloud Album', picUrl: svgDataUrl('Cloud', '#0891b2') },
      dt: 185000,
      t: 0,
    },
    {
      id: 7002,
      name: 'Starboard Lights',
      ar: [{ id: 12, name: 'Signal Bloom' }],
      al: { id: 102, name: 'Sunrise Circuit', picUrl: svgDataUrl('Sunrise', '#f59e0b') },
      dt: 225000,
      t: 0,
    },
  ],
  privileges: [],
};

test('player-sidebar liked playlist opens the Lattice collage with a queue', async ({ page }) => {
  await installBaseState(page, { neteaseMode: 'logged-in' });
  await page.addInitScript(() => {
    localStorage.setItem('open_player_on_launch', 'true');
  });
  await mockNeteaseApi(page, 'logged-in');
  // 后注册，覆盖共享 mock 里的歌单列表与曲目响应。
  await page.route('**/__mock_netease__/user/playlist**', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ playlist: [likedPlaylist, ...playlistPayload] }),
    });
  });
  await page.route('**/__mock_netease__/playlist/track/all**', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(trackPayload),
    });
  });
  await openApp(page);

  const sidebar = page.locator('aside[aria-label="在线音乐导航"]');
  await expect(sidebar).toBeVisible();
  await expect(sidebar.getByText('我喜欢的音乐')).toBeVisible();

  await sidebar.getByRole('button', { name: '我喜欢的音乐' }).click();

  await expect.poll(() => page.evaluate(() => window.location.hash)).toBe('#lattice');
  await expect(page.locator('.lattice-poster').first()).toBeVisible();
  await expect(page.locator('.lattice-root .lattice-empty')).toHaveCount(0);
});
