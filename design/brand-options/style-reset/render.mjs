import { chromium } from '@playwright/test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';
import { readFile } from 'node:fs/promises';

const outputDirectory = dirname(fileURLToPath(import.meta.url));
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1.5 });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(pathToFileURL(resolve(outputDirectory, 'index.html')).href);
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(Array.from(document.images, (image) => image.decode()));
  });
  await page.locator('.sheet').screenshot({ path: resolve(outputDirectory, 'comparison.png') });
  const desktop = await page.evaluate(() => ({
    images: document.images.length,
    broken: Array.from(document.images).filter((image) => !image.complete || image.naturalWidth === 0).length,
    overflow: document.documentElement.scrollWidth > innerWidth,
  }));
  for (const [name, file] of [['flat-a', '01-rounded.svg'], ['flat-b', '02-rounded.svg']]) {
    const assetPage = await browser.newPage({ viewport: { width: 1024, height: 1024 } });
    await assetPage.setContent('<style>html,body{margin:0;background:transparent}svg{display:block;width:1024px;height:1024px}</style>' + await readFile(resolve(outputDirectory, file), 'utf8'));
    await assetPage.screenshot({ path: resolve(outputDirectory, `${name}.png`), omitBackground: true });
    await assetPage.close();
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: resolve(outputDirectory, 'comparison-mobile.png'), fullPage: true });
  const mobile = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth }));
  if (errors.length || desktop.broken || desktop.overflow || mobile.overflow) {
    throw new Error(JSON.stringify({ desktop, mobile, errors }));
  }
  console.log(JSON.stringify({ desktop, mobile, errors, preview: resolve(outputDirectory, 'comparison.png') }, null, 2));
} finally {
  await browser.close();
}
