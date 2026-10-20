import { expect, test } from '@playwright/test';
import { APP_VERSION, waitForAppMounted } from '../helpers/appState';

// test/ui/wallpaperEngineBackground.spec.ts
// Locks the Wallpaper Engine entry point: the background type must be listed next to every other
// background in the picker, and selecting it must render its settings card. The browser build has no
// desktop capturer, so the card reports the platform notice there instead of offering the session
// controls — that is the state this spec can assert without a Windows desktop build.

test('lists the Wallpaper Engine background type and opens its settings card', async ({ page }) => {
    await page.addInitScript((version) => {
        localStorage.clear();
        localStorage.setItem('library_suite_prompt_seen', 'true');
        localStorage.setItem('i18nextLng', 'en');
        localStorage.setItem('visualizer_mode', 'classic');
        localStorage.setItem('static_mode', 'true');
        localStorage.setItem('folia_last_seen_ponder_onboarding_version', version);
    }, APP_VERSION);
    await page.route('**/__mock_netease__/**', async (route) => {
        await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });
    await page.goto('/');
    await waitForAppMounted(page);
    await page.evaluate(async () => {
        const storeModulePath = '/src/stores/useSettingsModalStore.ts';
        const { useSettingsModalStore } = await import(storeModulePath);
        useSettingsModalStore.getState().openSettings('options', 'visualizer', 'background');
    });

    // Wallpaper Engine has a dedicated entry above the ordinary background types; it is the only
    // place that also carries the library picker, while the panel's quick picker omits it.
    await expect(page.getByText('Wallpaper mode', { exact: true })).toBeVisible();
    await expect(page.getByText('Turn on wallpaper mode', { exact: true })).toBeVisible();

    // Scoped to the background chip row: the visualizer-mode row above it uses some of the same
    // labels (its "Common" chip), so the plain name lookup is ambiguous.
    const backgroundGroup = page.locator('div.space-y-2\\.5').filter({ hasText: 'Background Type' });

    // Every built-in background type offers a chip; the engine one sits last because of its order.
    for (const label of ['Common', 'Monet', 'Nomand', 'Latent', 'Embed', 'Sora', 'Wallpaper Engine']) {
        await expect(backgroundGroup.getByRole('button', { name: label, exact: true })).toBeVisible();
    }

    await backgroundGroup.getByRole('button', { name: 'Wallpaper Engine', exact: true }).click();

    // The card carries its own title, so scope by it: the shared background card above has sliders
    // with the same labels as the engine ones (both call theirs "Opacity").
    const card = page.locator('div.space-y-5').filter({ hasText: 'Wallpaper Engine Background' });

    await expect(card.getByText('Wallpaper Engine Background', { exact: true })).toBeVisible();
    await expect(card.getByRole('button', { name: 'Detect wallpapers', exact: true })).toBeVisible();
    for (const label of ['Opacity', 'Scale', 'Capture frame rate']) {
        await expect(card.getByRole('slider', { name: new RegExp(`^${label}`) })).toBeVisible();
    }
    await expect(card.getByText('Wallpaper Engine backgrounds are only available in the Windows desktop build', { exact: true })).toBeVisible();
});

