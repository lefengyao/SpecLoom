import { FolderOpen, Layers3 } from "lucide-react";

export default function App() {
  return (
    <div className="application">
      <header className="application-header">
        <Layers3 aria-hidden="true" size={24} />
        <span>SpecLoom</span>
      </header>
      <main className="project-entry">
        <h1>SpecLoom</h1>
        <button type="button" disabled>
          <FolderOpen aria-hidden="true" size={18} />
          Select Godot Project
        </button>
      </main>
    </div>
  );
}
