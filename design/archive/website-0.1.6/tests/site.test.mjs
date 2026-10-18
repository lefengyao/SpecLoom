import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
const site = await import("../site.js");
const { probeDownload } = site;
const { siteConfig } = await import("../site-config.js");
const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
const css = await readFile(new URL("../styles.css", import.meta.url), "utf8");

function requireProbeDownload() {
  assert.equal(typeof probeDownload, "function", "site.js should export probeDownload");
}

function requireInitializeSite() {
  assert.equal(typeof site.initializeSite, "function", "site.js should export initializeSite");
}

class FakeClassList {
  values = new Set();

  add(value) { this.values.add(value); }
  remove(value) { this.values.delete(value); }
  contains(value) { return this.values.has(value); }
}

class FakeElement {
  constructor({ dataset = {}, isAnchor = false, status = null } = {}) {
    this.dataset = dataset;
    this.isAnchor = isAnchor;
    this.status = status;
    this.attributes = new Map();
    this.listeners = new Map();
    this.classList = new FakeClassList();
    this.hidden = false;
    this.focused = false;
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  querySelector(selector) { return selector === "[data-download-status]" ? this.status : null; }
  closest(selector) { return selector === "a" && this.isAnchor ? this : null; }
  focus() { this.focused = true; }

  dispatch(type, event = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener({ target: this, ...event });
  }

  click(target = this) {
    for (const listener of this.listeners.get("click") ?? []) listener({ target });
  }
}

class FakeMediaQuery {
  constructor(matches) {
    this.matches = matches;
    this.listeners = [];
  }

  addEventListener(type, listener) {
    if (type === "change") this.listeners.push(listener);
  }

  setMatches(matches) {
    this.matches = matches;
    for (const listener of this.listeners) listener({ matches });
  }
}

class FakeDocument {
  constructor({ menuButton = new FakeElement(), nav = new FakeElement(), downloads = [] } = {}) {
    this.menuButton = menuButton;
    this.nav = nav;
    this.downloads = downloads;
    this.listeners = new Map();
  }

  querySelector(selector) {
    if (selector === "#primary-nav") return this.nav;
    if (selector === "[data-nav-toggle]") return this.menuButton;
    return null;
  }

  querySelectorAll(selector) {
    return selector === "[data-download]" ? this.downloads : [];
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatch(type, event = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function makeDownloadLink(asset) {
  const link = new FakeElement({
    dataset: { download: asset },
    status: { textContent: "正在检查当前发布文件…" },
  });
  link.setAttribute("aria-disabled", "true");
  link.classList.add("is-unavailable");
  return link;
}

test("probeDownload reports available only for a successful HEAD response", async () => {
  requireProbeDownload();
  const url = "../release/0.1.9/SpecLoom-0.1.9-Setup-x64.exe";
  let request;
  const result = await probeDownload(url, async (...args) => {
    request = args;
    return { ok: true, status: 200 };
  });

  assert.deepEqual(result, { available: true, status: 200 });
  assert.equal(request[0], url);
  assert.equal(request[1].method, "HEAD");
  assert.ok(request[1].signal instanceof AbortSignal);
});

test("probeDownload reports a missing release as unavailable", async () => {
  requireProbeDownload();
  const result = await probeDownload("../release/missing.zip", async () => ({
    ok: false,
    status: 404,
  }));

  assert.deepEqual(result, { available: false, status: 404 });
});

test("probeDownload reports other non-success HTTP responses as unavailable", async () => {
  requireProbeDownload();
  const result = await probeDownload("../release/error.zip", async () => ({
    ok: false,
    status: 503,
  }));

  assert.deepEqual(result, { available: false, status: 503 });
});

test("probeDownload reports a network failure as unavailable", async () => {
  requireProbeDownload();
  const result = await probeDownload("../release/offline.zip", async () => {
    throw new TypeError("network unavailable");
  });

  assert.deepEqual(result, { available: false, status: null });
});

test("English and numeric display elements use Georgia while page copy keeps its Chinese sans stack", () => {
  assert.match(css, /--font-serif:\s*Georgia(?:,|;)/);
  assert.match(css, /\.step-number\s*\{[^}]*font-family:\s*var\(--font-serif\)/s);
  assert.match(css, /\.step-caption\s*\{[^}]*font-family:\s*var\(--font-serif\)/s);
  assert.match(css, /--font-sans:[^;]*PingFang SC/);
});

test("workflow presents the approved three project steps in order", () => {
  const workflow = html.match(/<ol class="workflow-steps">[\s\S]*?<\/ol>/)?.[0] ?? "";
  const steps = ["选择项目", "读取项目上下文", "执行并检查改动"];
  let previousIndex = -1;

  for (const step of steps) {
    const index = workflow.indexOf(step);
    assert.notEqual(index, -1, `workflow should include ${step}`);
    assert.ok(index > previousIndex, `workflow should place ${step} in order`);
    previousIndex = index;
  }
});

test("hero workspace mock shows dialogue and a visibly bounded tool chain", () => {
  const figure = html.match(/<figure class="workspace-figure"[\s\S]*?<\/figure>/)?.[0] ?? "";
  assert.match(figure, /class="chat-message assistant-message"/);
  assert.match(figure, /class="chat-message user-message"/);

  const toolChain = figure.match(/<section class="tool-chain"[\s\S]*?<\/section>/)?.[0] ?? "";
  assert.match(toolChain, /工具链/);
  assert.match(toolChain, /class="tool-chain-steps"/);
  assert.match(css, /\.tool-chain\s*\{[^}]*border\s*:/s);
  assert.match(figure, /界面示意/);
});

test("FAQ covers platform, project types, data storage, and Hub relationship", () => {
  const summaries = [...html.matchAll(/<summary>([\s\S]*?)<span aria-hidden="true">/g)]
    .map((match) => match[1].replace(/<[^>]+>/g, "").trim());
  assert.deepEqual(summaries, [
    "SpecLoom 支持哪些系统？",
    "除了 Godot，SpecLoom 也适用于普通代码项目吗？",
    "项目资料和 Skills 保存在哪里？",
    "Trailblazer Hub 模块版如何与独立版及多开配合？",
  ]);

  assert.match(html, /目前仅支持 Windows x64/);
  assert.match(html, /Godot 项目是优先场景，也可用于普通代码项目/);
  assert.match(html, /specs\//);
  assert.match(html, /\.specloom\/skills\//);
  assert.match(html, /Trailblazer Hub 0\.1\.6/);
  assert.match(html, /独立版/);
  assert.match(html, /多开/);
});

test("model capability is described as model diagnostic logs", () => {
  assert.match(html, /<h3>模型诊断日志<\/h3>/);
});

test("download integration enables a detected file and labels a missing file as local preview", async () => {
  requireInitializeSite();
  const setup = makeDownloadLink("setup");
  const portable = makeDownloadLink("portable");
  const documentRef = new FakeDocument({ downloads: [setup, portable] });
  const media = new FakeMediaQuery(false);
  const pendingResponses = new Map();
  const requests = [];
  const checking = site.initializeSite({
    documentRef,
    windowRef: { matchMedia: () => media },
    fetchImpl: (url, options) => {
      requests.push({ url, options });
      return new Promise((resolve) => pendingResponses.set(url, resolve));
    },
  });

  assert.deepEqual(requests.map(({ url, options }) => [url, options.method]), [
    [siteConfig.downloads.setup, "HEAD"],
    [siteConfig.downloads.portable, "HEAD"],
  ]);
  assert.ok(requests.every(({ options }) => options.signal instanceof AbortSignal));
  pendingResponses.get(siteConfig.downloads.setup)({ ok: true, status: 200 });
  pendingResponses.get(siteConfig.downloads.portable)({ ok: false, status: 404 });
  await checking;

  assert.equal(setup.href, siteConfig.downloads.setup);
  assert.equal(setup.getAttribute("aria-disabled"), null);
  assert.equal(setup.classList.contains("is-unavailable"), false);
  assert.equal(setup.status.textContent, "已检测到发布文件，可下载");
  assert.equal(portable.getAttribute("href"), null);
  assert.equal(portable.getAttribute("aria-disabled"), "true");
  assert.equal(portable.classList.contains("is-unavailable"), true);
  assert.equal(portable.status.textContent, "本地预览、未检测到对应文件");
});

test("navigation toggles, closes on Escape or selection, and returns to persistent desktop nav", async () => {
  requireInitializeSite();
  assert.match(html, /<button[^>]*aria-controls="primary-nav"[^>]*aria-expanded="false"[^>]*aria-label="展开导航菜单"/);

  const menuButton = new FakeElement();
  const nav = new FakeElement();
  const documentRef = new FakeDocument({ menuButton, nav });
  const media = new FakeMediaQuery(true);
  await site.initializeSite({
    documentRef,
    windowRef: { matchMedia: () => media },
    fetchImpl: async () => ({ ok: false, status: 404 }),
  });

  assert.equal(menuButton.hidden, false);
  assert.equal(nav.hidden, true);
  menuButton.click();
  assert.equal(menuButton.getAttribute("aria-expanded"), "true");
  assert.equal(menuButton.getAttribute("aria-label"), "收起导航菜单");
  assert.equal(nav.hidden, false);

  documentRef.dispatch("keydown", { key: "Escape" });
  assert.equal(menuButton.getAttribute("aria-expanded"), "false");
  assert.equal(menuButton.getAttribute("aria-label"), "展开导航菜单");
  assert.equal(nav.hidden, true);
  assert.equal(menuButton.focused, true);

  menuButton.click();
  nav.click(new FakeElement({ isAnchor: true }));
  assert.equal(nav.hidden, true);
  assert.equal(menuButton.getAttribute("aria-expanded"), "false");

  media.setMatches(false);
  assert.equal(menuButton.hidden, true);
  assert.equal(nav.hidden, false);
  media.setMatches(true);
  assert.equal(menuButton.hidden, false);
  assert.equal(nav.hidden, true);
});

test("probeDownload returns unavailable when a local HEAD endpoint never responds", async (t) => {
  requireProbeDownload();
  const server = createServer(() => {});
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  }));

  const { port } = server.address();
  const url = `http://127.0.0.1:${port}/unresponsive-release.zip`;
  const timedOut = Symbol("probe did not finish within the test deadline");
  let deadlineTimer;
  const deadline = new Promise((resolve) => {
    deadlineTimer = setTimeout(() => resolve(timedOut), 120);
  });
  let result;
  try {
    result = await Promise.race([
      probeDownload(url, globalThis.fetch, 25),
      deadline,
    ]);
  } finally {
    clearTimeout(deadlineTimer);
  }

  assert.deepEqual(result, { available: false, status: null });
});
