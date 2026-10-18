import { siteConfig } from "./site-config.js";

export async function probeDownload(url, fetchImpl = globalThis.fetch, timeoutMs = 5000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(url, {
      method: "HEAD",
      signal: controller.signal,
    });
    return {
      available: response.ok,
      status: response.status,
    };
  } catch {
    return { available: false, status: null };
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function initializeSite({
  documentRef,
  windowRef,
  fetchImpl = globalThis.fetch,
  config = siteConfig,
}) {
  documentRef.querySelectorAll("[data-release-version]").forEach((element) => {
    element.textContent = config.version;
  });

  documentRef.querySelectorAll("[data-release-platform]").forEach((element) => {
    element.textContent = config.platform;
  });

  const nav = documentRef.querySelector("#primary-nav");
  const menuButton = documentRef.querySelector("[data-nav-toggle]");

  if (nav && menuButton) {
    const mobileBreakpoint = windowRef.matchMedia("(max-width: 600px)");
    let menuIsOpen = false;

    const renderMenu = () => {
      const isMobile = mobileBreakpoint.matches;
      menuButton.hidden = !isMobile;
      nav.hidden = isMobile && !menuIsOpen;
      menuButton.setAttribute("aria-expanded", String(menuIsOpen));
      menuButton.setAttribute("aria-label", menuIsOpen ? "收起导航菜单" : "展开导航菜单");
    };

    menuButton.addEventListener("click", () => {
      menuIsOpen = !menuIsOpen;
      renderMenu();
    });

    nav.addEventListener("click", (event) => {
      if (event.target.closest("a") && mobileBreakpoint.matches) {
        menuIsOpen = false;
        renderMenu();
      }
    });

    documentRef.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && menuIsOpen && mobileBreakpoint.matches) {
        menuIsOpen = false;
        renderMenu();
        menuButton.focus();
      }
    });

    mobileBreakpoint.addEventListener("change", () => {
      menuIsOpen = false;
      renderMenu();
    });

    renderMenu();
  }

  const probes = [...documentRef.querySelectorAll("[data-download]")].map(async (link) => {
    const path = config.downloads[link.dataset.download];
    const status = link.querySelector("[data-download-status]");

    if (!path) {
      link.removeAttribute("href");
      link.setAttribute("aria-disabled", "true");
      link.classList.add("is-unavailable");
      if (status) status.textContent = "本地预览、未检测到对应文件";
      return;
    }

    const result = await probeDownload(path, fetchImpl);

    if (result.available) {
      link.href = path;
      link.removeAttribute("aria-disabled");
      link.classList.remove("is-unavailable");
      if (status) status.textContent = "已检测到发布文件，可下载";
      return;
    }

    link.removeAttribute("href");
    link.setAttribute("aria-disabled", "true");
    link.classList.add("is-unavailable");
    if (status) status.textContent = "本地预览、未检测到对应文件";
  });

  return Promise.all(probes);
}

if (typeof document !== "undefined" && typeof window !== "undefined") {
  void initializeSite({ documentRef: document, windowRef: window });
}
