import "./luoluo.css";

export function LuoluoView() {
  return <section className="luoluo-view" aria-labelledby="luoluo-title">
    <div className="luoluo-heading">
      <div>
        <span className="eyebrow">SpecLoom</span>
        <h1 id="luoluo-title">络络</h1>
      </div>
      <span className="subtle">2026 · LUOLUO</span>
    </div>
    <figure className="luoluo-poster">
      <img src="./luoluo.png" alt="络络 2026 主题海报" />
    </figure>
  </section>;
}
