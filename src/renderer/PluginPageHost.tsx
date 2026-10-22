import { useEffect, useRef, useState } from "react";
import type { DesktopApi } from "../shared/desktop-api";

type Props = {
  api: DesktopApi;
  pluginId: string;
  pageId: string;
  title: string;
  project: { path: string; name: string; engine?: string | undefined };
  onError: (error: unknown) => void;
};

export function PluginPageHost({ api, pluginId, pageId, title, project, onError }: Props) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState("");
  const plugins = api.plugins;
  const url = plugins?.pageUrl(pluginId, pageId);

  useEffect(() => {
    if (!plugins || !url) return;
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return;
      const data = event.data as { channel?: string; type?: string; id?: string; method?: string; params?: Record<string, unknown> };
      if (!data || data.channel !== "specloom-plugin" || data.type !== "request" || !data.id || !data.method) return;
      const reply = (ok: boolean, result?: unknown, error?: string) => {
        frame.current?.contentWindow?.postMessage({ channel: "specloom-plugin", type: "response", id: data.id, ok, ...(ok ? { result } : { error }) }, "*");
      };
      void (async () => {
        try {
          if (data.method === "project.get") {
            reply(true, { path: project.path, name: project.name, engine: project.engine });
            return;
          }
          if (data.method === "plugin.invoke") {
            const command = typeof data.params?.command === "string" ? data.params.command : "";
            if (!command) throw new Error("插件命令为空");
            reply(true, await plugins.invoke(pluginId, command, data.params?.params));
            return;
          }
          if (data.method === "ui.openExternal") {
            const target = typeof data.params?.url === "string" ? data.params.url : "";
            if (!/^https?:\/\//iu.test(target)) throw new Error("只允许打开 HTTP 或 HTTPS 链接");
            window.open(target, "_blank", "noopener,noreferrer");
            reply(true, true);
            return;
          }
          throw new Error("不支持的插件请求");
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          reply(false, undefined, message);
          onError(error);
        }
      })();
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [onError, pluginId, plugins, project.engine, project.name, project.path, url]);

  if (!plugins || !url) return <section className="standard-view"><div role="alert" className="plugin-inline-error">插件宿主接口不可用。</div></section>;

  return <section className="plugin-page-host">
    <header className="plugin-page-heading"><div><h1>{title}</h1><span className="subtle">{pluginId}</span></div></header>
    {failure && <div role="alert" className="plugin-inline-error">{failure}</div>}
    {loading && <div className="plugin-page-loading">正在加载插件页面…</div>}
    <iframe
      ref={frame}
      className="plugin-page-frame"
      title={title}
      src={url}
      sandbox="allow-scripts allow-forms allow-same-origin allow-modals"
      onLoad={() => setLoading(false)}
      onError={() => { setLoading(false); setFailure("插件页面加载失败。"); }}
    />
  </section>;
}
