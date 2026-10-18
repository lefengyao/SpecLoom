import { chromium } from '@playwright/test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';

const outputDirectory = dirname(fileURLToPath(import.meta.url));
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, deviceScaleFactor: 1.5 });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(pathToFileURL(resolve(outputDirectory, 'index.html')).href);
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(Array.from(document.images, (image) => image.decode()));
  });
  await page.locator('.sheet').screenshot({ path: resolve(outputDirectory, 'comparison.png') });
  const desktop = await page.evaluate(() => ({
    options: document.querySelectorAll('article').length,
    images: document.images.length,
    broken: Array.from(document.images).filter((image) => !image.complete || image.naturalWidth === 0).length,
    overflow: document.documentElement.scrollWidth > innerWidth,
  }));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: resolve(outputDirectory, 'comparison-mobile.png'), fullPage: true });
  const mobile = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth }));
  if (errors.length || desktop.options !== 6 || desktop.broken || desktop.overflow || mobile.overflow) {
    throw new Error(JSON.stringify({ desktop, mobile, errors }));
  }
  console.log(JSON.stringify({ desktop, mobile, errors, preview: resolve(outputDirectory, 'comparison.png') }, null, 2));
} finally {
  await browser.close();
}
