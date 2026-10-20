import { expect, test } from '@playwright/test';

for (const colorScheme of ['light', 'dark'] as const) {
  test(`microphone works on a phone in ${colorScheme} mode`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme });
    const page = await context.newPage();
    try {
      await page.goto('http://localhost:5173');
      await page.locator('#tabBtnMic').click();
      await expect(page.locator('#panelMic')).toBeVisible();
      await page.locator('#btnMic').click();
      await expect(page.locator('#btnMicLabel')).toHaveText('Mute Microphone');
      await expect(page.locator('#statusText')).toHaveText('Microphone Live');
      await expect(page.locator('#noticeBanner')).toHaveClass(/banner-success/);
      await expect(page.locator('#oscilloscope')).toBeVisible();
    } finally {
      await context.close();
    }
  });
}
