import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { deflateSync } from "node:zlib";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { launchSourceElectron } from "./source-electron";

function png(width: number, height: number): Buffer {
  function chunk(type: string, data: Buffer): Buffer {
    const body = Buffer.concat([Buffer.from(type), data]);
    let crc = 0xffffffff;
    for (const byte of body) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    const frame = Buffer.alloc(body.length + 8);
    frame.writeUInt32BE(data.length, 0); body.copy(frame, 4); frame.writeUInt32BE((crc ^ 0xffffffff) >>> 0, body.length + 4);
    return frame;
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc((width * 3 + 1) * height);
  for (let row = 0; row < height; row++) {
    const offset = row * (width * 3 + 1);
    for (let column = 0; column < width; column++) {
      pixels[offset + 1 + column * 3] = column % 256;
      pixels[offset + 2 + column * 3] = row % 256;
      pixels[offset + 3 + column * 3] = 120;
    }
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]);
}
function wav(seconds: number): Buffer {
  const sampleRate = 16000;
  const samples = seconds * sampleRate;
  const audio = Buffer.alloc(44 + samples * 2);
  audio.write("RIFF", 0); audio.writeUInt32LE(36 + samples * 2, 4); audio.write("WAVEfmt ", 8);
  audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(sampleRate, 24); audio.writeUInt32LE(sampleRate * 2, 28); audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34);
  audio.write("data", 36); audio.writeUInt32LE(samples * 2, 40);
  for (let sample = 0; sample < samples; sample++) audio.writeInt16LE(Math.round(Math.sin(sample / sampleRate * 440 * Math.PI * 2) * 3000), 44 + sample * 2);
  return audio;
}
async function openTreeFile(window: Page, name: string) {
  await window.getByRole("tree", { name: "项目树", exact: true }).getByRole("button", { name, exact: true }).click();
}
async function verifyPlayback(player: Locator) {
  await expect.poll(() => player.evaluate((node: HTMLMediaElement) => node.readyState)).toBeGreaterThanOrEqual(1);
  expect(await player.evaluate((node: HTMLMediaElement) => ({ controls: node.controls, autoplay: node.autoplay, duration: node.duration }))).toMatchObject({ controls: true, autoplay: false, duration: expect.any(Number) });
  await player.evaluate(async (node: HTMLMediaElement) => { node.muted = true; await node.play(); });
  await expect.poll(() => player.evaluate((node: HTMLMediaElement) => node.currentTime)).toBeGreaterThan(0.15);
  await player.evaluate((node: HTMLMediaElement) => { node.pause(); node.currentTime = 3; });
  await expect.poll(() => player.evaluate((node: HTMLMediaElement) => Math.abs(node.currentTime - 3))).toBeLessThan(0.15);
}
async function removeTemporaryProject(userData: string, tempRoot: string) {
  const cleanupTarget = path.resolve(userData);
  if (path.dirname(cleanupTarget) !== tempRoot || !path.basename(cleanupTarget).startsWith("specloom-project-media-")) throw new Error("Refusing unexpected temporary cleanup target");
  await rm(cleanupTarget, { recursive: true, force: true });
}

test("source project files decode real images, seek audio/video, release hidden media, and open overview files", async ({ browserName }, testInfo) => {
  expect(browserName).toBe("chromium");
  test.setTimeout(120000);
  const tempRoot = path.resolve(os.tmpdir());
  const userData = await mkdtemp(path.join(tempRoot, "specloom-project-media-"));
  const project = path.join(userData, "game");
  const pngBytes = png(1800, 1000);
  await mkdir(project);
  await Promise.all([
    writeFile(path.join(project, "cover.PNG"), pngBytes),
    writeFile(path.join(project, "music.wav"), wav(8)),
    writeFile(path.join(project, "cover.PNG.IMPORT"), "[remap]\nimporter=\"texture\""),
    writeFile(path.join(project, "README.md"), "# Media fixture\n普通 UTF-8 项目文本\n"),
    writeFile(path.join(project, ".gitignore"), ".godot/\n.generated/\n"),
  ]);
  // Generate a real seekable VP8 WebM; fixture generation is independent of application packaging.
  await promisify(execFile)(process.env.FFMPEG_PATH ?? "ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=15", "-t", "8", "-c:v", "libvpx", "-b:v", "160k", "-threads", "1", "-an", "-y", path.join(project, "intro.webm")], { windowsHide: true, timeout: 30000 });
  const app = await launchSourceElectron(userData);
  try {
    const window = await app.firstWindow();
    const mediaFailures: string[] = [];
    window.on("requestfailed", request => { if (request.url().includes("/media/")) mediaFailures.push(request.failure()?.errorText ?? "media request failed"); });
    window.on("console", message => { if (message.type() === "error") mediaFailures.push(message.text()); });
    await window.setViewportSize({ width: 1280, height: 900 });
    await expect(window.getByRole("main").getByRole("button", { name: "打开项目", exact: true })).toBeEnabled();
    await window.evaluate(root => globalThis.window.specloom.openProject(root), project);
    await window.evaluate(() => localStorage.setItem("specloom.documents.tree", "open"));
    await window.reload();
    expect(await window.evaluate(async (encoded) => {
      const image = new Image(); image.src = `data:image/png;base64,${encoded}`;
      await image.decode(); return image.naturalWidth;
    }, pngBytes.toString("base64"))).toBe(1800);
    await window.getByRole("button", { name: "项目文件", exact: true }).click();
    await openTreeFile(window, "cover.PNG");
    const image = window.getByRole("img", { name: "cover.PNG", exact: true });
    await expect.poll(async () => ({ width: await image.evaluate((node: HTMLImageElement) => node.naturalWidth), failures: mediaFailures })).toEqual({ width: 1800, failures: [] });
    await window.getByRole("button", { name: "100%", exact: true }).click();
    await expect.poll(() => image.evaluate(node => Math.round(node.getBoundingClientRect().width))).toBe(1800);
    const viewport = window.locator(".project-image-viewport");
    expect(await viewport.evaluate(node => node.scrollWidth > node.clientWidth)).toBe(true);
    await window.getByRole("button", { name: "放大图片", exact: true }).click();
    await expect(window.getByLabel("图片缩放比例")).toHaveValue("125");
    await window.getByRole("button", { name: "适应窗口", exact: true }).click();
    expect(await image.evaluate(node => node.getBoundingClientRect().width)).toBeLessThan(1800);
    await window.screenshot({ path: testInfo.outputPath("project-media-image.png") });
    const importToggle = window.getByRole("checkbox", { name: "隐藏 .import 文件", exact: true });
    await expect(importToggle).not.toBeChecked();
    const imported = window.getByRole("tree", { name: "项目树", exact: true }).getByRole("button", { name: "cover.PNG.IMPORT", exact: true });
    await expect(imported).toBeVisible();
    await importToggle.check();
    await expect(imported).toHaveCount(0);
    await window.getByRole("button", { name: "刷新项目树", exact: true }).click();
    await expect(importToggle).toBeChecked();
    await importToggle.uncheck();
    await expect(imported).toBeVisible();

    await openTreeFile(window, "music.wav");
    const audio = window.getByLabel("音频播放器", { exact: true });
    await verifyPlayback(audio);
    const hiddenAudio = await audio.elementHandle();
    await audio.evaluate(async (node: HTMLMediaElement) => { await node.play(); });
    await window.getByRole("button", { name: "关于项目", exact: true }).click();
    expect(await hiddenAudio!.evaluate((node: HTMLMediaElement) => ({ paused: node.paused, src: node.getAttribute("src") }))).toEqual({ paused: true, src: null });
    await window.getByRole("button", { name: "项目文件", exact: true }).click();
    await expect(audio).toBeVisible();
    await expect.poll(() => audio.evaluate((node: HTMLMediaElement) => node.paused)).toBe(true);

    const resources = window.getByRole("list", { name: "项目资源列表", exact: true });
    await window.getByLabel("筛选资源类型").selectOption("video");
    await resources.getByRole("button", { name: /intro.webm/ }).click();
    const video = window.getByLabel("视频播放器", { exact: true });
    await verifyPlayback(video);
    expect(await video.evaluate((node: HTMLVideoElement) => node.videoWidth)).toBe(320);
    await window.getByRole("button", { name: "展开视频", exact: true }).click();
    await expect(window.getByRole("region", { name: "项目媒体预览", exact: true })).toHaveClass(/is-expanded/);
    await window.getByRole("button", { name: "收起视频", exact: true }).click();
    await window.getByRole("button", { name: "视频全屏", exact: true }).click();
    await expect.poll(() => window.evaluate(() => document.fullscreenElement?.classList.contains("project-media-preview"))).toBe(true);
    await window.screenshot({ path: testInfo.outputPath("project-media-video-fullscreen.png") });
    await window.evaluate(() => document.exitFullscreen());

    await window.getByRole("button", { name: "关于项目", exact: true }).click();
    const readme = window.locator(".about-document").filter({ has: window.getByText("README.md", { exact: true }) });
    await readme.getByRole("button", { name: "打开文件", exact: true }).click();
    const text = window.getByRole("textbox", { name: "项目文件内容", exact: true });
    await expect(text).toHaveValue("# Media fixture\n普通 UTF-8 项目文本\n");
    await expect(text).toHaveAttribute("readonly", "");
    await expect(window.getByRole("button", { name: "保存资料", exact: true })).toHaveCount(0);
    await window.getByRole("button", { name: "关于项目", exact: true }).click();
    const gitignore = window.locator(".about-document").filter({ has: window.getByText(".gitignore", { exact: true }) });
    await gitignore.getByRole("button", { name: "打开文件", exact: true }).click();
    await expect(text).toHaveValue(".godot/\n.generated/\n");
    await window.screenshot({ path: testInfo.outputPath("project-media-overview-file.png") });
    await expect(window.locator(".error-notice")).toHaveCount(0);
  } finally {
    await app.close();
    await removeTemporaryProject(userData, tempRoot);
  }
});
