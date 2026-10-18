import { ChevronDown, FolderOpen } from "lucide-react";
import { useState } from "react";
import type { ProjectMetadata } from "../shared/contracts";
import "./project-sidebar-info.css";

export function ProjectSidebarInfo({ project, expanded, onExpandNavigation }: {
  project: ProjectMetadata;
  expanded: boolean;
  onExpandNavigation: () => void;
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const detailsVisible = expanded && detailsOpen;
  const rendering = project.godot.features.slice(1).join(" · ");

  return (
    <section className={`sidebar-project${expanded ? "" : " is-compact"}`} aria-label="当前项目">
      <h2 className="sidebar-project-heading" aria-label={project.name}>
        <button
          className="sidebar-project-toggle"
          aria-label={`项目信息：${project.name}`}
          aria-expanded={detailsVisible}
          aria-controls="sidebar-project-details"
          title={`${project.name}\n${project.path}`}
          onClick={() => {
            if (!expanded) {
              setDetailsOpen(true);
              onExpandNavigation();
            } else setDetailsOpen(value => !value);
          }}
        >
          <FolderOpen size={17} aria-hidden="true" />
          <span className="sidebar-project-name">{project.name}</span>
          <ChevronDown className="sidebar-project-chevron" size={14} aria-hidden="true" />
        </button>
      </h2>
      <div id="sidebar-project-details" className="sidebar-project-details" hidden={!detailsVisible}>
        <dl>
          <div>
            <dt>项目路径</dt>
            <dd><code>{project.path}</code></dd>
          </div>
          <div>
            <dt>引擎</dt>
            <dd>{project.engine === "generic" ? "通用项目" : `Godot ${project.godot.features[0] ?? project.godot.configVersion ?? "—"}`}</dd>
          </div>
          {project.engine !== "generic" && <>
            {rendering && <div><dt>渲染</dt><dd>{rendering}</dd></div>}
            <div>
              <dt>主场景</dt>
              <dd><code>{project.godot.mainScene ?? "未配置主场景"}</code></dd>
            </div>
          </>}
        </dl>
      </div>
    </section>
  );
}
