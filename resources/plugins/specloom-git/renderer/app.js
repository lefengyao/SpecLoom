const $ = (id) => document.getElementById(id);
const state = { repo: null, branches: [], history: [], selected: null, tab: "branches" };
let busy = false;

function request(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const timer = setTimeout(() => { window.removeEventListener("message", onMessage); reject(new Error("插件请求超时。")); }, 30000);
    const onMessage = (event) => {
      const data = event.data;
      if (!data || data.channel !== "specloom-plugin" || data.id !== id) return;
      clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      if (data.ok) resolve(data.result);
      else reject(new Error(data.error || "插件请求失败。"));
    };
    window.addEventListener("message", onMessage);
    parent.postMessage({ channel: "specloom-plugin", type: "request", id, method, params }, "*");
  });
}

const git = (command, params) => request("plugin.invoke", { command, params });

function showError(message) {
  const box = $("error");
  box.hidden = !message;
  box.textContent = message || "";
}
function setBusy(value) {
  busy = value;
  for (const button of document.querySelectorAll("button")) button.disabled = value;
}
function statusText(file) {
  if (file.index === "?" || file.worktree === "?") return "??";
  return (file.index + file.worktree).replaceAll(" ", "");
}
function fileElement(file) {
  const row = document.createElement("div");
  row.className = "file-row" + (state.selected === file.path ? " active" : "");
  const status = document.createElement("span");
  status.className = "file-status";
  status.textContent = statusText(file);
  const label = document.createElement("button");
  label.className = "file-path";
  label.style.border = "0";
  label.style.background = "transparent";
  label.textContent = file.path;
  label.title = file.path;
  label.onclick = () => selectFile(file);
  const actions = document.createElement("span");
  actions.className = "file-actions";
  const stage = document.createElement("button");
  stage.textContent = file.staged && !file.unstaged ? "取消暂存" : "暂存";
  stage.onclick = (event) => { event.stopPropagation(); void (file.staged && !file.unstaged ? unstage([file.path]) : stageFiles([file.path])); };
  actions.append(stage);
  row.append(status, label, actions);
  return row;
}
function renderFiles() {
  const list = $("file-list");
  list.replaceChildren();
  const files = state.repo?.files ?? [];
  $("file-count").textContent = files.length ? `${files.length} 个文件` : "";
  if (!files.length) { const empty = document.createElement("p"); empty.className = "empty"; empty.textContent = "工作区干净。"; list.append(empty); return; }
  for (const file of files) list.append(fileElement(file));
}
function renderRepo() {
  const repo = state.repo;
  $("repo-state").textContent = repo?.state === "repository" ? "Git 仓库" : repo?.state === "not-repository" ? "未初始化" : "不可用";
  $("repo-state").className = "pill " + (repo?.state === "repository" ? "ok" : "warn");
  $("branch-name").textContent = repo?.branch ? `当前分支：${repo.branch}` : "";
  $("sync-counts").textContent = repo?.upstream ? `↑${repo.ahead} ↓${repo.behind}` : "";
  const repoReady = repo?.state === "repository";
  $("init-button").hidden = repo?.state !== "not-repository";
  for (const id of ["fetch-button", "pull-button", "push-button", "commit-button", "new-branch"]) $(id).hidden = !repoReady;
  $("commit-message").disabled = !repoReady;
  renderFiles();
}
async function refresh() {
  setBusy(true); showError("");
  try {
    state.repo = await git("state");
    renderRepo();
    if (state.repo.state === "repository") {
      const branches = await git("branches");
      state.branches = branches.branches;
      renderBranches(branches.current);
      state.history = (await git("history")).commits;
      renderHistory();
      if (state.selected) await selectFile(state.selected);
    }
  } catch (error) { showError(error.message); }
  finally { setBusy(false); }
}
async function stageFiles(paths) {
  setBusy(true); showError("");
  try { state.repo = await git("stage", { paths }); renderRepo(); }
  catch (error) { showError(error.message); }
  finally { setBusy(false); }
}
async function unstage(paths) {
  setBusy(true); showError("");
  try { state.repo = await git("unstage", { paths }); renderRepo(); }
  catch (error) { showError(error.message); }
  finally { setBusy(false); }
}
async function selectFile(file) {
  state.selected = file;
  $("diff-title").textContent = `差异 · ${file.path}`;
  $("diff-view").textContent = "读取中…";
  try {
    const result = await git("diff", { path: file.path, staged: file.staged && !file.unstaged });
    $("diff-view").textContent = result.diff || "没有可显示的差异。";
    renderFiles();
  } catch (error) { $("diff-view").textContent = error.message; }
}
function renderBranches(current) {
  const list = $("branch-list");
  list.replaceChildren();
  for (const branch of state.branches) {
    const row = document.createElement("button");
    row.className = "branch-row" + (branch === current ? " current" : "");
    row.textContent = branch;
    if (branch === current) { const tag = document.createElement("span"); tag.textContent = "当前"; row.append(tag); }
    else row.onclick = () => void switchBranch(branch);
    list.append(row);
  }
}
function renderHistory() {
  const list = $("history-list");
  list.replaceChildren();
  if (!state.history.length) { const empty = document.createElement("p"); empty.className = "empty"; empty.textContent = "还没有提交。"; list.append(empty); return; }
  for (const commit of state.history) {
    const row = document.createElement("button");
    row.className = "history-row";
    const title = document.createElement("b"); title.textContent = commit.subject;
    const meta = document.createElement("small"); meta.textContent = `${commit.shortHash} · ${commit.author} · ${new Date(commit.authoredAt * 1000).toLocaleString()}`;
    row.append(title, meta);
    row.onclick = () => void showCommit(commit);
    list.append(row);
  }
}
async function showCommit(commit) {
  try {
    const detail = await git("commitDetail", { hash: commit.hash });
    $("diff-title").textContent = `提交 ${detail.shortHash}`;
    $("diff-view").textContent = `${detail.subject}\n${detail.author} <${detail.email}>\n\n${detail.diff}`;
  } catch (error) { showError(error.message); }
}
async function switchBranch(name) {
  setBusy(true); showError("");
  try { await git("switchBranch", { name }); await refresh(); }
  catch (error) { showError(error.message); }
  finally { setBusy(false); }
}
async function createBranch() {
  const name = window.prompt("新分支名称");
  if (!name) return;
  setBusy(true); showError("");
  try { await git("createBranch", { name }); await refresh(); }
  catch (error) { showError(error.message); }
  finally { setBusy(false); }
}
async function sync(command, label) {
  if (!window.confirm(`确认执行 ${label}？`)) return;
  setBusy(true); showError("");
  try { await git(command); await refresh(); }
  catch (error) { showError(error.message); }
  finally { setBusy(false); }
}
$("refresh-button").onclick = () => void refresh();
$("init-button").onclick = async () => {
  setBusy(true); showError("");
  try { await git("init"); await refresh(); }
  catch (error) { showError(error.message); }
  finally { setBusy(false); }
};
$("commit-button").onclick = async () => {
  const message = $("commit-message").value.trim();
  if (!message) { showError("请填写提交说明。"); return; }
  setBusy(true); showError("");
  try { await git("commit", { message }); $("commit-message").value = ""; await refresh(); }
  catch (error) { showError(error.message); }
  finally { setBusy(false); }
};
$("fetch-button").onclick = () => void sync("fetch", "获取远程分支");
$("pull-button").onclick = () => void sync("pull", "拉取远程变更（仅快进）");
$("push-button").onclick = () => void sync("push", "推送当前分支");
$("new-branch").onclick = () => void createBranch();
for (const tab of document.querySelectorAll(".tab")) {
  tab.onclick = () => {
    state.tab = tab.dataset.tab;
    for (const item of document.querySelectorAll(".tab")) { item.classList.toggle("active", item === tab); item.setAttribute("aria-selected", String(item === tab)); }
    $("branches-view").hidden = state.tab !== "branches";
    $("history-view").hidden = state.tab !== "history";
  };
}
void refresh();
