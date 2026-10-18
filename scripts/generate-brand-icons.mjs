import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const brandDirectory = new URL("../src/renderer/public/brand/", import.meta.url);
const buildDirectory = new URL("../build/", import.meta.url);
const svg = await readFile(new URL("specloom.svg", brandDirectory), "utf8");
await mkdir(buildDirectory, { recursive: true });

// Shell icons (exe, installer, shortcuts, taskbar, dock) sit on arbitrary wallpaper, so the
// artwork gets an opaque white plate with rounded corners. The in-app mark keeps using the
// transparent SVG, so the plate is only ever baked into the packaged icon files.
const inset = 8;
const plate = `<style>
  html, body { margin: 0; background: transparent; }
  .plate { position: fixed; inset: 0; background: #fff; border-radius: 21%; display: flex; align-items: center; justify-content: center; overflow: hidden; }
  .plate > svg { display: block; width: ${100 - inset * 2}%; height: ${100 - inset * 2}%; }
</style><div class="plate">${svg}</div>`;

const browser = await chromium.launch();
/** @type {Map<number, Buffer>} */
const images = new Map();
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  for (const size of [16, 24, 32, 48, 64, 128, 256, 512, 1024]) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(plate);
    images.set(size, await page.screenshot({ omitBackground: true }));
  }
} finally {
  await browser.close();
}

/** @param {number} size */
function png(size) {
  const image = images.get(size);
  if (!image) throw new Error(`Missing ${size}px brand icon`);
  return image;
}

// Modern Windows supports PNG payloads in ICO entries, including full alpha.
const sizes = [16, 24, 32, 48, 64, 128, 256];
const icoHeader = Buffer.alloc(6 + sizes.length * 16);
icoHeader.writeUInt16LE(1, 2);
icoHeader.writeUInt16LE(sizes.length, 4);
let offset = icoHeader.length;
for (const [index, size] of sizes.entries()) {
  const entry = 6 + index * 16;
  icoHeader[entry] = size === 256 ? 0 : size;
  icoHeader[entry + 1] = size === 256 ? 0 : size;
  icoHeader.writeUInt16LE(1, entry + 4);
  icoHeader.writeUInt16LE(32, entry + 6);
  icoHeader.writeUInt32LE(png(size).length, entry + 8);
  icoHeader.writeUInt32LE(offset, entry + 12);
  offset += png(size).length;
}
await writeFile(new URL("icon.ico", buildDirectory), Buffer.concat([icoHeader, ...sizes.map(png)]));

const icnsChunks = [128, 256, 512, 1024].map((size, index) => {
  const header = Buffer.alloc(8);
  header.write(["ic07", "ic08", "ic09", "ic10"][index] ?? "", 0, "ascii");
  header.writeUInt32BE(8 + png(size).length, 4);
  return Buffer.concat([header, png(size)]);
});
const icnsHeader = Buffer.alloc(8);
icnsHeader.write("icns", 0, "ascii");
icnsHeader.writeUInt32BE(8 + icnsChunks.reduce((total, chunk) => total + chunk.length, 0), 4);
await writeFile(new URL("icon.icns", buildDirectory), Buffer.concat([icnsHeader, ...icnsChunks]));
await writeFile(new URL("icon.png", buildDirectory), png(1024));
// The renderer copy is only ever used as the BrowserWindow icon, never drawn inside the page.
await writeFile(new URL("icon.png", brandDirectory), png(256));
console.log(`SpecLoom brand icons generated in ${fileURLToPath(buildDirectory)}`);
