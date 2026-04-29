// code-archaeology — single shared script for all three pages.
//
// Each page calls its initXxxPage() entry point at the bottom of the HTML.
// Code is intentionally vanilla — no build step, mirrors uptime-monitor.

const api = (path, opts) => fetch(path, opts).then(async (r) => {
  if (!r.ok) {
    const err = await r.text().catch(() => r.statusText);
    throw new Error(`${r.status}: ${err}`);
  }
  return r.status === 204 ? null : r.json();
});

function toast(msg, kind = "") {
  const el = document.createElement("div");
  el.className = "toast " + kind;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString();
}

function instabilityClass(i) {
  if (i < 0.34) return "stable";
  if (i < 0.67) return "mid";
  return "unstable";
}

async function loadVersion() {
  try {
    const v = await api("/api/version");
    const link = document.getElementById("version-link");
    if (link) link.textContent = "v" + v.version;
  } catch (e) { /* non-fatal */ }
}

// ── INDEX PAGE ────────────────────────────────────────────────────────────

async function initIndexPage() {
  loadVersion();
  await renderRepos();
  document.getElementById("add-btn").onclick = () => {
    document.getElementById("add-dialog").showModal();
  };
  document.getElementById("cancel-btn").onclick = () => {
    document.getElementById("add-dialog").close();
  };
  document.getElementById("save-btn").onclick = saveRepo;
}

async function renderRepos() {
  const repos = await api("/api/repos");
  const host = document.getElementById("repos");
  if (!repos.length) {
    host.innerHTML = `<div class="empty">No repos yet. Add one to start scanning.</div>`;
    return;
  }
  host.innerHTML = `
    <table>
      <thead><tr>
        <th>name</th><th>source</th><th>branch</th><th>last sha</th><th>added</th><th></th>
      </tr></thead>
      <tbody>${repos.map(r => `
        <tr>
          <td><a href="/repo/${r.id}"><strong>${escapeHtml(r.name)}</strong></a>
            ${r.sub_path ? `<span class="tag">${escapeHtml(r.sub_path)}</span>` : ""}</td>
          <td class="mono">${escapeHtml(r.url || r.local_path || "—")}</td>
          <td>${escapeHtml(r.default_branch || "")}</td>
          <td class="mono">${r.last_scanned_sha ? r.last_scanned_sha.slice(0, 7) : "—"}</td>
          <td class="muted">${fmtDate(r.created_at)}</td>
          <td><button data-del="${r.id}">Delete</button></td>
        </tr>`).join("")}
      </tbody>
    </table>`;
  host.querySelectorAll("[data-del]").forEach(btn => {
    btn.onclick = async () => {
      if (!confirm("Delete this repo and all its scan data?")) return;
      try {
        await api(`/api/repos/${btn.dataset.del}`, { method: "DELETE" });
        await renderRepos();
      } catch (e) { toast(e.message, "error"); }
    };
  });
}

async function saveRepo() {
  const body = {
    name: document.getElementById("f-name").value.trim(),
    url: document.getElementById("f-url").value.trim() || null,
    local_path: document.getElementById("f-local").value.trim() || null,
    sub_path: document.getElementById("f-sub").value.trim() || null,
    default_branch: document.getElementById("f-branch").value.trim() || "main",
  };
  if (!body.name) { toast("name is required", "error"); return; }
  if (!body.url && !body.local_path) { toast("provide url or local_path", "error"); return; }
  try {
    await api("/api/repos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    document.getElementById("add-dialog").close();
    await renderRepos();
    toast("repo added", "success");
  } catch (e) { toast(e.message, "error"); }
}

// ── REPO PAGE ─────────────────────────────────────────────────────────────

const REPO_ID = location.pathname.match(/\/repo\/(\d+)/)?.[1];
let TIMELINE = [];
const charts = {};

async function initRepoPage() {
  loadVersion();
  await loadRepoMeta();
  await loadTimeline();
  await loadCommits();
  await loadHotspots();

  document.getElementById("refresh-btn").onclick = async () => {
    await Promise.all([loadRepoMeta(), loadTimeline(), loadCommits(), pollJob()]);
  };
  document.getElementById("scan-btn").onclick = openScanDialog;
  document.getElementById("scan-cancel").onclick = () => {
    document.getElementById("scan-dialog").close();
  };
  document.getElementById("scan-go").onclick = startScan;
  document.getElementById("hot-refresh").onclick = loadHotspots;

  pollJob();
}

async function loadRepoMeta() {
  const repo = await api(`/api/repos/${REPO_ID}`);
  document.getElementById("repo-name").textContent = repo.name;
  document.getElementById("repo-sub").textContent =
    `${repo.url || repo.local_path || ""}` +
    (repo.sub_path ? ` · ${repo.sub_path}` : "") +
    ` · ${repo.default_branch}`;

  const stats = await api(`/api/repos/${REPO_ID}/stats`);
  const summary = document.getElementById("summary");
  if (!stats.latest) {
    summary.innerHTML = `<div class="stat"><span class="num">${stats.commits_scanned}</span><span class="lbl">commits scanned</span></div>`;
    return;
  }
  const l = stats.latest;
  summary.innerHTML = `
    <div class="stat"><span class="num">${stats.commits_scanned}</span><span class="lbl">commits scanned</span></div>
    <div class="stat"><span class="num">${l.modules}</span><span class="lbl">modules @ HEAD</span></div>
    <div class="stat"><span class="num">${l.loc.toLocaleString()}</span><span class="lbl">LOC @ HEAD</span></div>
    <div class="stat"><span class="num">${l.classes}</span><span class="lbl">classes @ HEAD</span></div>
    <div class="stat"><span class="num">${(l.avg_instability ?? 0).toFixed(2)}</span><span class="lbl">avg instability</span></div>
    <div class="stat"><span class="num">${l.avg_lcom4 != null ? l.avg_lcom4.toFixed(2) : "—"}</span><span class="lbl">avg LCOM4</span></div>`;
}

async function loadTimeline() {
  TIMELINE = await api(`/api/repos/${REPO_ID}/timeline`);
  drawCharts();
  setupScrubber();
}

function drawCharts() {
  const labels = TIMELINE.map(p => p.short_sha);
  const baseOpts = (yLabel) => ({
    type: "line",
    data: {},
    options: {
      responsive: true, maintainAspectRatio: false,
      animation: false, parsing: false, normalized: true,
      plugins: {
        legend: { labels: { color: "#9aa0a6" } },
        tooltip: {
          callbacks: {
            title: (items) => {
              const i = items[0].dataIndex;
              const p = TIMELINE[i];
              return `${p.short_sha} · ${fmtDate(p.committed_at)}`;
            },
            beforeBody: (items) => {
              const p = TIMELINE[items[0].dataIndex];
              return p.message ? `"${p.message}"` : "";
            },
          },
        },
      },
      scales: {
        x: { ticks: { color: "#9aa0a6", maxTicksLimit: 12 }, grid: { color: "#2c313c" } },
        y: { ticks: { color: "#9aa0a6" }, grid: { color: "#2c313c" }, title: { display: true, text: yLabel, color: "#9aa0a6" } },
      },
      onClick: (_, els) => { if (els.length) jumpScrubber(els[0].index); },
    },
  });

  const dataset = (label, points, color) => ({
    label, data: points, borderColor: color, backgroundColor: color + "33",
    borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, tension: 0.2, fill: false,
  });

  const mk = (id, label, key, color, yLabel) => {
    const ctx = document.getElementById(id);
    if (!ctx) return;
    if (charts[id]) charts[id].destroy();
    const opts = baseOpts(yLabel);
    opts.data = {
      labels,
      datasets: [dataset(label, TIMELINE.map(p => p[key]), color)],
    };
    charts[id] = new Chart(ctx, opts);
  };

  mk("chart-loc", "LOC", "loc", "#4dd0e1", "lines of code");
  mk("chart-classes", "classes", "classes", "#ffb74d", "classes");
  mk("chart-instability", "avg instability", "avg_instability", "#ef5350", "I (0–1)");
  mk("chart-lcom4", "avg LCOM4", "avg_lcom4", "#66bb6a", "LCOM4");
}

function setupScrubber() {
  const scrub = document.getElementById("scrubber");
  if (!TIMELINE.length) {
    scrub.disabled = true;
    document.getElementById("scrubber-sha").textContent = "no commits scanned yet";
    document.getElementById("scrubber-msg").textContent = "—";
    document.getElementById("scrubber-date").textContent = "—";
    document.getElementById("snapshot-link").style.display = "none";
    return;
  }
  scrub.disabled = false;
  scrub.min = 0; scrub.max = TIMELINE.length - 1;
  scrub.value = TIMELINE.length - 1;
  scrub.oninput = () => updateScrubberMeta(parseInt(scrub.value, 10));
  updateScrubberMeta(TIMELINE.length - 1);
}

function updateScrubberMeta(i) {
  const p = TIMELINE[i];
  if (!p) return;
  document.getElementById("scrubber-sha").textContent = p.short_sha;
  document.getElementById("scrubber-msg").textContent = p.message || "";
  document.getElementById("scrubber-date").textContent = fmtDate(p.committed_at);
  const link = document.getElementById("snapshot-link");
  link.href = `/repo/${REPO_ID}/commit/${p.sha}`;
  link.style.display = "inline-block";
}

function jumpScrubber(i) {
  document.getElementById("scrubber").value = i;
  updateScrubberMeta(i);
}

async function loadCommits() {
  const commits = await api(`/api/repos/${REPO_ID}/commits?limit=300`);
  const host = document.getElementById("commits");
  if (!commits.length) {
    host.innerHTML = `<div class="empty">No commits scanned yet. Click <strong>Scan commits…</strong> to start.</div>`;
    return;
  }
  host.innerHTML = `
    <table>
      <thead><tr><th>sha</th><th>message</th><th>author</th><th>committed</th><th></th></tr></thead>
      <tbody>${commits.map(c => `
        <tr>
          <td class="mono"><a href="/repo/${REPO_ID}/commit/${c.sha}">${c.short_sha}</a>
            ${c.scan_error ? '<span class="pill unstable">err</span>' : ""}</td>
          <td>${escapeHtml(c.message || "")}</td>
          <td class="muted">${escapeHtml(c.author || "")}</td>
          <td class="muted">${fmtDate(c.committed_at)}</td>
          <td></td>
        </tr>`).join("")}
      </tbody>
    </table>`;
}

async function loadHotspots() {
  const w = parseInt(document.getElementById("hot-window").value, 10) || 20;
  const data = await api(`/api/repos/${REPO_ID}/hotspots?window=${w}`);
  const host = document.getElementById("hotspots");
  if (!data.length) {
    host.innerHTML = `<div class="empty">Need at least 2 scanned commits to show deltas.</div>`;
    return;
  }
  const deltaPill = (v, suffix = "") => {
    if (!v && v !== 0) return "—";
    const cls = v > 0 ? "delta-pos" : v < 0 ? "delta-neg" : "delta-zero";
    const sign = v > 0 ? "+" : "";
    return `<span class="pill ${cls}">${sign}${v}${suffix}</span>`;
  };
  host.innerHTML = `
    <table>
      <thead><tr><th>module</th><th>LOC now</th><th>ΔLOC</th><th>I now</th><th>ΔI</th><th>LCOM4 now</th><th>ΔLCOM4</th><th></th></tr></thead>
      <tbody>${data.slice(0, 30).map(r => `
        <tr>
          <td class="mono">${escapeHtml(r.module)}</td>
          <td>${r.loc_now}</td>
          <td>${deltaPill(r.loc_delta)}</td>
          <td><span class="pill ${instabilityClass(r.instability_now)}">${r.instability_now.toFixed(2)}</span></td>
          <td>${deltaPill(r.instability_delta.toFixed(3))}</td>
          <td>${r.lcom4_now != null ? r.lcom4_now.toFixed(2) : "—"}</td>
          <td>${deltaPill(r.lcom4_delta.toFixed(2))}</td>
          <td>${r.is_new ? '<span class="pill new">new</span>' : ""}</td>
        </tr>`).join("")}
      </tbody>
    </table>`;
}

// ── Scan dialog & polling ─────────────────────────────────────────────────

function openScanDialog() {
  const dlg = document.getElementById("scan-dialog");
  const args = document.getElementById("f-args");
  const kind = document.getElementById("f-kind");
  const renderArgs = () => {
    switch (kind.value) {
      case "last_n":
        args.innerHTML = `<label>N <input id="f-n" type="number" value="50" min="1"></label>`; break;
      case "since":
        args.innerHTML = `<label>Since (YYYY-MM-DD) <input id="f-since" placeholder="2026-01-01"></label>`; break;
      case "range":
        args.innerHTML = `<label>From SHA <input id="f-from"></label>
                          <label>To SHA <input id="f-to"></label>`; break;
      case "sha_list":
        args.innerHTML = `<label>SHAs (comma-separated) <input id="f-shas"></label>`; break;
      default: args.innerHTML = ""; break;
    }
  };
  kind.onchange = renderArgs;
  renderArgs();
  dlg.showModal();
}

async function startScan() {
  const kind = document.getElementById("f-kind").value;
  let value = {};
  if (kind === "last_n") value = { n: parseInt(document.getElementById("f-n").value, 10) || 50 };
  if (kind === "since") value = { since: document.getElementById("f-since").value };
  if (kind === "range") value = {
    from: document.getElementById("f-from").value.trim(),
    to: document.getElementById("f-to").value.trim(),
  };
  if (kind === "sha_list") value = {
    shas: document.getElementById("f-shas").value.split(",").map(s => s.trim()).filter(Boolean),
  };
  try {
    await api(`/api/repos/${REPO_ID}/scan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filter_kind: kind, filter_value: value }),
    });
    document.getElementById("scan-dialog").close();
    toast("scan queued", "success");
    pollJob();
  } catch (e) { toast(e.message, "error"); }
}

let pollTimer = null;
async function pollJob() {
  if (pollTimer) clearTimeout(pollTimer);
  try {
    const jobs = await api(`/api/repos/${REPO_ID}/jobs`);
    const j = jobs[0];
    const status = document.getElementById("job-status");
    if (!j) { status.textContent = "no scans yet"; return; }
    const pct = j.total_commits ? Math.round((j.scanned_commits / j.total_commits) * 100) : 0;
    status.innerHTML = `Latest job: <strong>${j.status}</strong>` +
      (j.total_commits ? ` — ${j.scanned_commits}/${j.total_commits} (${pct}%)` : "") +
      (j.error ? ` <span class="danger">${escapeHtml(j.error.split("\n")[0])}</span>` : "") +
      ` <span class="muted">${fmtDate(j.created_at)}</span>`;
    if (j.status === "running" || j.status === "pending") {
      pollTimer = setTimeout(() => { pollJob(); loadTimeline(); loadCommits(); loadRepoMeta(); }, 3000);
    }
  } catch (e) { /* ignore polling errors */ }
}

// ── COMMIT (snapshot) PAGE ─────────────────────────────────────────────────

async function initCommitPage() {
  loadVersion();
  const m = location.pathname.match(/\/repo\/(\d+)\/commit\/([0-9a-f]+)/);
  if (!m) { document.body.innerHTML = "<p>bad url</p>"; return; }
  const [_, repoId, sha] = m;
  document.getElementById("back-link").href = `/repo/${repoId}`;

  const data = await api(`/api/repos/${repoId}/commits/${sha}/snapshot`);
  document.getElementById("commit-title").textContent =
    `${data.short_sha} — ${(data.message || "").split("\n")[0]}`;
  document.getElementById("commit-meta").textContent =
    `${data.author || ""} · ${fmtDate(data.committed_at)}`;

  const totals = computeTotals(data.metrics);
  document.getElementById("snapshot-summary").innerHTML = `
    <div class="stat"><span class="num">${totals.modules}</span><span class="lbl">modules</span></div>
    <div class="stat"><span class="num">${totals.loc.toLocaleString()}</span><span class="lbl">LOC</span></div>
    <div class="stat"><span class="num">${totals.classes}</span><span class="lbl">classes</span></div>
    <div class="stat"><span class="num">${totals.functions}</span><span class="lbl">functions</span></div>
    <div class="stat"><span class="num">${data.edges.length}</span><span class="lbl">internal imports</span></div>`;

  renderMetricsTable(data.metrics);
  renderGraph(data.metrics, data.edges);

  document.getElementById("mermaid-classes").textContent = data.mermaid_classes || "";
  document.getElementById("mermaid-layers").textContent = data.mermaid_layers || "";
  if (window.mermaid) {
    mermaid.initialize({
      startOnLoad: false, theme: "dark",
      themeVariables: {
        darkMode: true, background: "#232732", primaryColor: "#1a1d24",
        primaryBorderColor: "#4dd0e1", primaryTextColor: "#e8eaed",
        lineColor: "#9aa0a6", secondaryColor: "#2c313c",
      },
    });
    await mermaid.run({ querySelector: "pre.mermaid" });
  }
}

function computeTotals(metrics) {
  return {
    modules: metrics.length,
    loc: metrics.reduce((a, m) => a + m.loc, 0),
    classes: metrics.reduce((a, m) => a + m.classes, 0),
    functions: metrics.reduce((a, m) => a + m.functions, 0),
  };
}

let metricsSortKey = "loc", metricsSortDir = -1;
function renderMetricsTable(metrics) {
  const tbody = document.querySelector("#metrics-table tbody");
  const rows = [...metrics].sort((a, b) => {
    const va = a[metricsSortKey], vb = b[metricsSortKey];
    if (va == null) return 1; if (vb == null) return -1;
    if (typeof va === "string") return metricsSortDir * va.localeCompare(vb);
    return metricsSortDir * (va - vb);
  });
  tbody.innerHTML = rows.map(r => `
    <tr>
      <td class="mono">${escapeHtml(r.module)}</td>
      <td><span class="tag">${escapeHtml(r.lang || "?")}</span></td>
      <td>${r.loc}</td>
      <td>${r.classes}</td>
      <td>${r.functions}</td>
      <td>${r.fan_in}</td>
      <td>${r.fan_out}</td>
      <td><span class="pill ${instabilityClass(r.instability)}">${r.instability.toFixed(2)}</span></td>
      <td>${r.avg_lcom4 == null ? "—" : r.avg_lcom4.toFixed(2)}</td>
    </tr>`).join("");
  document.querySelectorAll("#metrics-table th").forEach(th => {
    th.onclick = () => {
      const k = th.dataset.sort;
      if (metricsSortKey === k) metricsSortDir *= -1;
      else { metricsSortKey = k; metricsSortDir = (k === "module" || k === "lang") ? 1 : -1; }
      renderMetricsTable(metrics);
    };
  });
}

function renderGraph(metrics, edges) {
  if (!metrics.length) {
    document.getElementById("graph").innerHTML = "";
    return;
  }
  const svg = d3.select("#graph");
  svg.selectAll("*").remove();
  const W = svg.node().clientWidth, H = 540;
  svg.attr("viewBox", [0, 0, W, H]);

  const colorOf = (name) => {
    if (name.startsWith("routers.")) return "#ffb74d";
    if (["database", "scanner", "analyzer"].includes(name)) return "#66bb6a";
    return "#4dd0e1";
  };
  const radius = d => 6 + Math.sqrt(Math.max(d.loc, 1)) / 2;

  const nodes = metrics.map(m => ({ ...m, id: m.module }));
  const links = edges.map(e => ({ ...e }));

  svg.append("defs").append("marker")
    .attr("id", "arrow").attr("viewBox", "0 -5 10 10").attr("refX", 18)
    .attr("refY", 0).attr("markerWidth", 8).attr("markerHeight", 8)
    .attr("orient", "auto").append("path").attr("d", "M0,-5L10,0L0,5")
    .attr("fill", "#9aa0a6");

  const sim = d3.forceSimulation(nodes)
    .force("link", d3.forceLink(links).id(d => d.id).distance(d => 70 + (d.weight || 1) * 4))
    .force("charge", d3.forceManyBody().strength(-360))
    .force("center", d3.forceCenter(W / 2, H / 2))
    .force("collide", d3.forceCollide().radius(d => radius(d) + 6));

  const link = svg.append("g").selectAll("line").data(links).join("line")
    .attr("class", "link").attr("stroke", "#9aa0a6")
    .attr("stroke-width", d => Math.max(1, Math.sqrt(d.weight)))
    .attr("marker-end", "url(#arrow)");

  const node = svg.append("g").selectAll("g").data(nodes).join("g")
    .attr("class", "node")
    .call(d3.drag()
      .on("start", (e, d) => { if (!e.active) sim.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
      .on("drag", (e, d) => { d.fx = e.x; d.fy = e.y; })
      .on("end", (e, d) => { if (!e.active) sim.alphaTarget(0); d.fx = null; d.fy = null; }));

  node.append("circle").attr("r", radius).attr("fill", d => colorOf(d.module));
  node.append("text").attr("dy", d => -radius(d) - 4).attr("text-anchor", "middle")
    .text(d => d.module.replace(/^routers\./, ""));

  const info = document.getElementById("graph-info");
  let active = null;
  node.on("click", (_, d) => {
    if (active === d.id) {
      active = null;
      info.classList.remove("visible");
      node.classed("dimmed", false);
      link.classed("dimmed", false).classed("highlighted", false);
      return;
    }
    active = d.id;
    const outs = links.filter(l => l.source.id === d.id).map(l => `${l.target.id} (${l.weight})`);
    const ins = links.filter(l => l.target.id === d.id).map(l => `${l.source.id} (${l.weight})`);
    info.innerHTML = `
      <div><strong>${d.module}</strong>
        <span class="tag">${d.loc} LOC</span>
        <span class="tag">${d.classes} cls</span>
        <span class="tag">${d.functions} fn</span>
        <span class="tag">I=${d.instability.toFixed(2)}</span></div>
      <div style="margin-top: 8px;">imports → ${outs.length ? outs.join(", ") : "—"}</div>
      <div>imported by ← ${ins.length ? ins.join(", ") : "—"}</div>`;
    info.classList.add("visible");
    const related = new Set([d.id]);
    links.forEach(l => {
      if (l.source.id === d.id) related.add(l.target.id);
      if (l.target.id === d.id) related.add(l.source.id);
    });
    node.classed("dimmed", n => !related.has(n.id));
    link.classed("highlighted", l => l.source.id === d.id || l.target.id === d.id)
        .classed("dimmed", l => l.source.id !== d.id && l.target.id !== d.id);
  });

  sim.on("tick", () => {
    link.attr("x1", d => d.source.x).attr("y1", d => d.source.y)
        .attr("x2", d => d.target.x).attr("y2", d => d.target.y);
    node.attr("transform", d => `translate(${d.x},${d.y})`);
  });
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}
