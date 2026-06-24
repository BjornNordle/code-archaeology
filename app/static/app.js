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

// ── In-context help system ──────────────────────────────────────────────────
// Two patterns:
//   1. helpIcon("key")  → a small (?) next to a label; click opens a popover
//      with the matching HELP[key] definition. Used for simple units.
//   2. <details class="explainer">  → expandable "What is this?" panel under
//      a section header. Native HTML, no JS needed. Used for bigger concepts.
//
// Every label, column header, dialog field, and section visualised in the UI
// is registered here so users never see an undefined acronym or metric.

const HELP = {
  // ── Simple units (popover) ────────────────────────────────────────────────
  loc: {
    title: "LOC — Lines of Code",
    body: `<p>Raw line count of the module's source file (<code>len(src.splitlines())</code>) — blanks and comments included.</p>
           <p>It's a size proxy, not a quality signal. Useful for spotting growth, not for ranking modules.</p>`,
  },
  classes: {
    title: "Classes",
    body: `<p>Top-level <code>class</code> definitions in the module. Nested classes (declared inside another class or function) aren't counted.</p>`,
  },
  functions: {
    title: "Functions",
    body: `<p>Top-level <code>def</code> / <code>async def</code> in the module. Methods defined inside classes are <em>not</em> counted here — they live under their class.</p>`,
  },
  modules: {
    title: "Modules",
    body: `<p>Each <code>.py</code> file (or directory with <code>__init__.py</code>) is one module. Only Python files inside the repo's <code>sub_path</code> are AST-analyzed.</p>
           <p>Files in other languages (.ts, .js, .go, …) are counted by line as a single <code>generic_loc</code> bucket — they don't appear as nodes in the graph yet.</p>`,
  },
  internal_imports: {
    title: "Internal imports",
    body: `<p>Distinct (importer → imported) edges between modules inside the analyzed sub-path. Each pair is counted once, regardless of how many <code>import</code> statements connect them.</p>
           <p>External imports (stdlib, third-party packages) are excluded — they don't appear in the graph.</p>`,
  },
  fan_in: {
    title: "Ca — Afferent coupling",
    body: `<p>Number of <em>distinct internal modules</em> that import this one (incoming dependencies).</p>
           <p>High Ca = many things depend on this module. Changing it has wide reach.</p>`,
  },
  fan_out: {
    title: "Ce — Efferent coupling",
    body: `<p>Number of <em>distinct internal modules</em> this one imports (outgoing dependencies).</p>
           <p>High Ce = this module knows a lot about its world. It's exposed to changes in many others.</p>`,
  },
  instability_col: {
    title: "I — Instability",
    body: `<p>Ratio between 0 and 1: <span class="formula">I = Ce / (Ce + Ca)</span></p>
           <p><strong>I = 0</strong> stable: nothing depends on others, many depend on it.<br>
              <strong>I = 1</strong> unstable: depends on many, nothing depends on it.</p>
           <p>See the "What is instability?" panel above the table for the full picture.</p>`,
  },
  lcom4_col: {
    title: "LCOM4 — Lack of Cohesion of Methods (v4)",
    body: `<p>Average over the module's top-level classes. <strong>Lower is better</strong>: 1.0 means each class is one connected cluster of methods.</p>
           <p>A class with LCOM4 = 3 is really three classes glued together. See the "What is cohesion (LCOM4)?" panel for details.</p>
           <p><code>—</code> means the module has no classes (so cohesion isn't meaningful).</p>`,
  },
  language: {
    title: "Language",
    body: `<p>Source language detected by file extension. Only <code>python</code> modules get full AST analysis; everything else is rolled into a single LOC bucket.</p>`,
  },
  commits_scanned: {
    title: "Commits scanned",
    body: `<p>Total git commits the analyzer has processed and stored metrics for. Each was checked out into a temporary worktree, analyzed, and persisted — so this number is also "how much SQLite data exists for this repo".</p>`,
  },
  modules_at_head: {
    title: "Modules at HEAD",
    body: `<p>Number of Python modules present at the most recently scanned commit. Same definition as the column header — see the "Modules" help.</p>`,
  },
  loc_at_head: {
    title: "LOC at HEAD",
    body: `<p>Total lines of code (Python modules only, raw line count) at the most recently scanned commit.</p>`,
  },
  classes_at_head: {
    title: "Classes at HEAD",
    body: `<p>Total top-level class count across all Python modules at the most recently scanned commit.</p>`,
  },
  avg_instability_stat: {
    title: "Average instability",
    body: `<p>Arithmetic mean of <code>instability</code> across all modules at the latest scanned commit. A drift upward over time means the codebase is becoming more leaf-like (more glue, fewer stable core modules).</p>`,
  },
  avg_lcom4_stat: {
    title: "Average LCOM4",
    body: `<p>Arithmetic mean of <code>avg_lcom4</code> across modules that have at least one class. Modules with no classes are skipped.</p>
           <p>Drift upward = classes are getting more split / less cohesive on average.</p>`,
  },
  // ── Snapshot stats (commit page) ──────────────────────────────────────────
  snap_modules: {
    title: "Modules",
    body: `<p>Python modules analyzed at this commit. See the "Modules" definition for what counts.</p>`,
  },
  snap_loc: {
    title: "LOC",
    body: `<p>Sum of every analyzed module's <code>loc</code> at this commit.</p>`,
  },
  snap_classes: {
    title: "Classes",
    body: `<p>Total top-level classes at this commit (sum across all modules).</p>`,
  },
  snap_functions: {
    title: "Functions",
    body: `<p>Total top-level functions at this commit (sum across all modules). Methods inside classes are not in this count.</p>`,
  },
  snap_edges: {
    title: "Internal imports",
    body: `<p>Distinct (importer → imported) module pairs at this commit. Same as the line count in the coupling matrix.</p>`,
  },
  // ── Hotspots columns ──────────────────────────────────────────────────────
  hot_loc_now: {
    title: "LOC now",
    body: `<p>The module's line count at the latest commit in the window.</p>`,
  },
  hot_delta_loc: {
    title: "ΔLOC",
    body: `<p>Change in LOC from the window's <em>oldest</em> commit to its newest. Positive = grew (shown red); negative = shrunk (shown green).</p>`,
  },
  hot_i_now: {
    title: "I now",
    body: `<p>Instability at the latest commit in the window. Color: green = stable (&lt; 0.34), orange = mid, red = unstable (≥ 0.67).</p>`,
  },
  hot_delta_i: {
    title: "ΔI",
    body: `<p>Change in instability across the window. Positive (red) = the module became more leaf-like / less core. Negative (green) = it became more stable.</p>`,
  },
  hot_lcom4_now: {
    title: "LCOM4 now",
    body: `<p>Average LCOM4 across the module's classes at the latest commit. <code>—</code> means no classes.</p>`,
  },
  hot_delta_lcom4: {
    title: "ΔLCOM4",
    body: `<p>Change in cohesion across the window. Positive (red) = the module's classes became <em>less</em> cohesive (more disconnected clusters). Negative (green) = more cohesive.</p>`,
  },
  hot_window: {
    title: "Window",
    body: `<p>How many of the most recent commits to compare across. The hotspots row shows the delta from the <em>oldest</em> commit in the window to the latest.</p>
           <p>Small window (5–20) = recent volatility. Large window (100+) = long-term trends.</p>`,
  },
  is_new: {
    title: "New",
    body: `<p>Shown when a module exists at the window's latest commit but didn't exist at the window's oldest — i.e. it was introduced inside the window.</p>`,
  },
  // ── Scan filter options ───────────────────────────────────────────────────
  scan_filter: {
    title: "Commit filter",
    body: `<p>Restricts which commits to scan. The walk is always first-parent on the default branch, oldest → newest.</p>
           <ul>
             <li><code>all</code> — every commit (default)</li>
             <li><code>last_n</code> — the most recent N commits</li>
             <li><code>since</code> — author date on or after a given <code>YYYY-MM-DD</code></li>
             <li><code>range</code> — from one SHA-prefix up to another, inclusive both ends</li>
             <li><code>sha_list</code> — only the explicit full SHAs you list</li>
           </ul>`,
  },
  scan_n: {
    title: "N",
    body: `<p>How many of the most recent commits to scan, counted from HEAD backwards.</p>`,
  },
  scan_since: {
    title: "Since date",
    body: `<p>ISO date <code>YYYY-MM-DD</code>. Commits with author date on or after this date are scanned. Earlier commits are skipped.</p>`,
  },
  scan_from: {
    title: "From SHA",
    body: `<p>Where the range starts. Walk begins at the first commit whose SHA starts with this prefix (oldest-first order). 7+ chars recommended to avoid ambiguity.</p>`,
  },
  scan_to: {
    title: "To SHA",
    body: `<p>Where the range stops. Walk ends after the commit whose SHA starts with this prefix — inclusive.</p>`,
  },
  scan_shas: {
    title: "Specific SHAs",
    body: `<p>Comma-separated <em>full</em> SHAs (not prefixes). Only commits matching exactly are scanned. Useful for re-scanning a handful of bad commits after fixing the analyzer.</p>`,
  },
  // ── Add-repo dialog fields ────────────────────────────────────────────────
  repo_name: {
    title: "Name",
    body: `<p>Human-readable label for this repo in the UI. Doesn't need to match the git URL.</p>`,
  },
  repo_url: {
    title: "Remote URL",
    body: `<p>HTTPS or SSH git URL. For private <code>github.com</code> repos, the scanner injects <code>$GITHUB_TOKEN</code> as <code>x-access-token</code> at clone/fetch time.</p>
           <p>Mutually exclusive with Local path — provide one or the other.</p>`,
  },
  repo_local: {
    title: "Local path",
    body: `<p>Absolute path to an already-cloned git repo on disk. Useful for scanning checkouts you control without re-cloning.</p>
           <p>In Docker, this path is inside the container — mount your host repo into <code>/repos/...</code> (see <code>docker-compose.yml</code>).</p>`,
  },
  repo_sub: {
    title: "Sub-path",
    body: `<p>Subdirectory inside the repo to analyze (e.g. <code>app</code> if your code lives under <code>app/</code>). Module names are rooted here — a file at <code>app/foo.py</code> becomes the module <code>foo</code>, not <code>app.foo</code>.</p>
           <p>Leave blank to analyze the whole repo. Useful for monorepos where only one directory is the project.</p>`,
  },
  repo_branch: {
    title: "Default branch",
    body: `<p>Branch the scanner walks when iterating commits. Usually <code>main</code> or <code>master</code>. The walk is <code>git log --first-parent --reverse</code>, so merge commits are followed via their first parent only.</p>`,
  },
  // ── Tracked repos table ───────────────────────────────────────────────────
  repo_table_source: {
    title: "Source",
    body: `<p>Either the remote URL (for cloned repos) or the local path (for repos already on disk). Whichever was provided when the repo was added.</p>`,
  },
  repo_table_last_sha: {
    title: "Last SHA",
    body: `<p>Short SHA of the most recently scanned commit for this repo. <code>—</code> means no successful scan yet.</p>`,
  },
  // ── Scanned commits table ─────────────────────────────────────────────────
  commit_err_pill: {
    title: "Scan error",
    body: `<p>The analyzer crashed on this commit (most often a Python syntax error during AST parsing of one of the files at that revision). The commit is still listed but has no metrics — open it to see the error detail.</p>`,
  },
};

function helpIcon(key) {
  if (!HELP[key]) console.warn("missing HELP key:", key);
  return `<span class="help-icon" data-help-key="${key}" tabindex="0" role="button" aria-label="What is this?">?</span>`;
}

function closeHelpPopover() {
  document.getElementById("help-popover")?.remove();
}

function showHelpPopover(anchor, key) {
  const def = HELP[key];
  if (!def) return;
  closeHelpPopover();
  const pop = document.createElement("div");
  pop.className = "help-popover";
  pop.id = "help-popover";
  pop.dataset.forKey = key;
  pop.innerHTML = `<h4>${def.title}</h4>${def.body}`;
  // If the trigger is inside an open <dialog>, attach the popover there so it
  // renders in the same top-layer stacking context (dialogs sit above body).
  const dlg = anchor.closest("dialog[open]");
  const host = dlg || document.body;
  host.appendChild(pop);
  const ar = anchor.getBoundingClientRect();
  const pr = pop.getBoundingClientRect();
  const margin = 12;
  // Absolute-positioned children of <dialog> use the dialog's content box as
  // their containing block. Subtract the dialog's viewport offset so the
  // popover lands at the right place visually.
  const hostR = dlg ? dlg.getBoundingClientRect() : { top: -window.scrollY, left: -window.scrollX };
  let top = ar.bottom - hostR.top + 6;
  if (ar.bottom + pr.height + margin > window.innerHeight && ar.top - pr.height - margin > 0) {
    top = ar.top - hostR.top - pr.height - 6;
  }
  let left = ar.left - hostR.left;
  // Keep within viewport
  if (ar.left + pr.width > window.innerWidth - margin) {
    left = window.innerWidth - hostR.left - pr.width - margin;
  }
  if (ar.left < margin) left = margin - hostR.left;
  pop.style.top = top + "px";
  pop.style.left = left + "px";
}

// Capture phase so we run BEFORE bubbling-phase handlers (e.g. table-header
// sort onclick). Without this, clicking a help-icon in a sortable <th> would
// also re-sort the column.
document.addEventListener("click", (e) => {
  const trigger = e.target.closest(".help-icon");
  if (trigger) {
    e.preventDefault();
    e.stopPropagation();
    const existing = document.getElementById("help-popover");
    const wasFor = existing && existing.dataset.forKey === trigger.dataset.helpKey;
    closeHelpPopover();
    if (!wasFor) showHelpPopover(trigger, trigger.dataset.helpKey);
    return;
  }
  if (!e.target.closest(".help-popover")) closeHelpPopover();
}, true);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeHelpPopover();
  if ((e.key === "Enter" || e.key === " ") && document.activeElement?.classList.contains("help-icon")) {
    e.preventDefault();
    document.activeElement.click();
  }
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
        <th>name</th>
        <th>source ${helpIcon("repo_table_source")}</th>
        <th>branch ${helpIcon("repo_branch")}</th>
        <th>last sha ${helpIcon("repo_table_last_sha")}</th>
        <th>added</th>
        <th></th>
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

  document.getElementById("refresh-btn").onclick = manualRefresh;
  document.getElementById("scan-btn").onclick = openScanDialog;
  document.getElementById("scan-cancel").onclick = () => {
    document.getElementById("scan-dialog").close();
  };
  document.getElementById("scan-go").onclick = startScan;
  document.getElementById("hot-refresh").onclick = loadHotspots;

  pollJob();
}

async function manualRefresh() {
  const btn = document.getElementById("refresh-btn");
  if (btn.disabled) return;
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Refreshing…";
  try {
    await Promise.all([loadRepoMeta(), loadTimeline(), loadCommits(), loadHotspots(), pollJob()]);
    toast("Refreshed", "success");
  } catch (e) {
    toast(e.message || "Refresh failed", "error");
  } finally {
    btn.disabled = false;
    btn.textContent = orig;
  }
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
    <div class="stat"><span class="num">${stats.commits_scanned}</span><span class="lbl">commits scanned ${helpIcon("commits_scanned")}</span></div>
    <div class="stat"><span class="num">${l.modules}</span><span class="lbl">modules @ HEAD ${helpIcon("modules_at_head")}</span></div>
    <div class="stat"><span class="num">${l.loc.toLocaleString()}</span><span class="lbl">LOC @ HEAD ${helpIcon("loc_at_head")}</span></div>
    <div class="stat"><span class="num">${l.classes}</span><span class="lbl">classes @ HEAD ${helpIcon("classes_at_head")}</span></div>
    <div class="stat"><span class="num">${(l.avg_instability ?? 0).toFixed(2)}</span><span class="lbl">avg instability ${helpIcon("avg_instability_stat")}</span></div>
    <div class="stat"><span class="num">${l.avg_lcom4 != null ? l.avg_lcom4.toFixed(2) : "—"}</span><span class="lbl">avg LCOM4 ${helpIcon("avg_lcom4_stat")}</span></div>`;
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
      animation: false,
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
    spanGaps: true,
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
      <thead><tr>
        <th>sha</th><th>message</th><th>author</th><th>committed</th>
        <th>${helpIcon("commit_err_pill")}</th>
      </tr></thead>
      <tbody>${commits.map(c => `
        <tr>
          <td class="mono"><a href="/repo/${REPO_ID}/commit/${c.sha}">${c.short_sha}</a></td>
          <td>${escapeHtml(c.message || "")}</td>
          <td class="muted">${escapeHtml(c.author || "")}</td>
          <td class="muted">${fmtDate(c.committed_at)}</td>
          <td>${c.scan_error ? '<span class="pill unstable">err</span>' : ""}</td>
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
      <thead><tr>
        <th>module</th>
        <th>LOC now ${helpIcon("hot_loc_now")}</th>
        <th>ΔLOC ${helpIcon("hot_delta_loc")}</th>
        <th>I now ${helpIcon("hot_i_now")}</th>
        <th>ΔI ${helpIcon("hot_delta_i")}</th>
        <th>LCOM4 now ${helpIcon("hot_lcom4_now")}</th>
        <th>ΔLCOM4 ${helpIcon("hot_delta_lcom4")}</th>
        <th>${helpIcon("is_new")}</th>
      </tr></thead>
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
        args.innerHTML = `<label>N ${helpIcon("scan_n")} <input id="f-n" type="number" value="50" min="1"></label>`; break;
      case "since":
        args.innerHTML = `<label>Since (YYYY-MM-DD) ${helpIcon("scan_since")} <input id="f-since" placeholder="2026-01-01"></label>`; break;
      case "range":
        args.innerHTML = `<label>From SHA ${helpIcon("scan_from")} <input id="f-from"></label>
                          <label>To SHA ${helpIcon("scan_to")} <input id="f-to"></label>`; break;
      case "sha_list":
        args.innerHTML = `<label>SHAs (comma-separated) ${helpIcon("scan_shas")} <input id="f-shas"></label>`; break;
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
let lastJobStatus = null;
async function pollJob() {
  if (pollTimer) clearTimeout(pollTimer);
  let j;
  try {
    const jobs = await api(`/api/repos/${REPO_ID}/jobs`);
    j = jobs[0];
  } catch (e) { return; }

  const status = document.getElementById("job-status");
  if (!j) { status.textContent = "no scans yet"; lastJobStatus = null; return; }

  const pct = j.total_commits ? Math.round((j.scanned_commits / j.total_commits) * 100) : 0;
  status.innerHTML = `Latest job: <strong>${j.status}</strong>` +
    (j.total_commits ? ` — ${j.scanned_commits}/${j.total_commits} (${pct}%)` : "") +
    (j.error ? ` <span class="danger">${escapeHtml(j.error.split("\n")[0])}</span>` : "") +
    ` <span class="muted">${fmtDate(j.created_at)}</span>`;

  const wasActive = lastJobStatus === "running" || lastJobStatus === "pending";
  const nowActive = j.status === "running" || j.status === "pending";
  lastJobStatus = j.status;

  if (nowActive) {
    pollTimer = setTimeout(() => {
      pollJob(); loadTimeline(); loadCommits(); loadRepoMeta(); loadHotspots();
    }, 3000);
  } else if (wasActive) {
    // Job just transitioned from running/pending → done/error. The last
    // commits scanned often land between the prior poll and this one, so
    // the charts/tables are stale until we fetch one more time.
    await Promise.all([loadRepoMeta(), loadTimeline(), loadCommits(), loadHotspots()]);
    toast(
      j.status === "error" ? "Scan failed" : `Scan complete — ${j.scanned_commits} commit${j.scanned_commits === 1 ? "" : "s"}`,
      j.status === "error" ? "error" : "success",
    );
  }
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
    <div class="stat"><span class="num">${totals.modules}</span><span class="lbl">modules ${helpIcon("snap_modules")}</span></div>
    <div class="stat"><span class="num">${totals.loc.toLocaleString()}</span><span class="lbl">LOC ${helpIcon("snap_loc")}</span></div>
    <div class="stat"><span class="num">${totals.classes}</span><span class="lbl">classes ${helpIcon("snap_classes")}</span></div>
    <div class="stat"><span class="num">${totals.functions}</span><span class="lbl">functions ${helpIcon("snap_functions")}</span></div>
    <div class="stat"><span class="num">${data.edges.length}</span><span class="lbl">internal imports ${helpIcon("snap_edges")}</span></div>`;

  renderMetricsTable(data.metrics);
  renderGraph(data.metrics, data.edges);
  renderMatrix(data.metrics, data.edges);
  await renderMermaid(data.mermaid_layers, data.mermaid_classes);
}

async function renderMermaid(layersSrc, classesSrc) {
  // Use mermaid.render() rather than mermaid.run() — the latter races with
  // mermaid's own auto-init on window-load, which marks our empty containers
  // as data-processed="true" before we've filled them in.
  if (!window.mermaid) return;
  mermaid.initialize({
    startOnLoad: false, theme: "dark",
    themeVariables: {
      darkMode: true, background: "#232732", primaryColor: "#1a1d24",
      primaryBorderColor: "#4dd0e1", primaryTextColor: "#e8eaed",
      lineColor: "#9aa0a6", secondaryColor: "#2c313c",
    },
  });
  const into = async (hostId, src, svgId) => {
    const host = document.getElementById(hostId);
    if (!host) return;
    if (!src) { host.textContent = ""; return; }
    try {
      const { svg, bindFunctions } = await mermaid.render(svgId, src);
      host.innerHTML = svg;
      if (bindFunctions) bindFunctions(host);
    } catch (e) {
      host.innerHTML = `<pre class="mermaid-error">${escapeHtml(src)}</pre>`;
    }
  };
  await Promise.all([
    into("mermaid-layers", layersSrc, "mermaid-svg-layers"),
    into("mermaid-classes", classesSrc, "mermaid-svg-classes"),
  ]);
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
  const W = Math.max(svg.node().clientWidth, 400);
  // Give crowded scans more vertical room so initial layout isn't squashed.
  const H = Math.max(540, Math.round(32 * Math.sqrt(metrics.length) + 360));
  svg.attr("viewBox", [0, 0, W, H]).style("height", H + "px");

  // Strip the longest common dotted prefix so labels are readable when
  // every module is e.g. "app.routers.foo".
  const names = metrics.map(m => m.module);
  let commonPrefix = "";
  if (names.length > 1) {
    const first = names[0].split(".");
    for (let i = 1; i <= first.length; i++) {
      const cand = first.slice(0, i).join(".") + ".";
      if (names.every(n => n.startsWith(cand))) commonPrefix = cand;
      else break;
    }
  }
  const stripPrefix = s => (commonPrefix && s.startsWith(commonPrefix)) ? s.slice(commonPrefix.length) : s;

  const isRouter = name => name.startsWith("routers.") || name.includes(".routers.");
  const isData = name => /(^|\.)(database|scanner|analyzer)$/.test(name);
  const colorOf = name => isRouter(name) ? "#ffb74d" : (isData(name) ? "#66bb6a" : "#4dd0e1");
  const radius = d => 6 + Math.sqrt(Math.max(d.loc, 1)) / 2;

  const nodes = metrics.map(m => ({ ...m, id: m.module }));
  const links = edges.map(e => ({ ...e }));

  // marker-end="url(#arrow)" resolves against the document URL; make the ID
  // unique per render so it never collides with a stale marker after re-render.
  const arrowId = `arrow-${Math.random().toString(36).slice(2, 9)}`;
  svg.append("defs").append("marker")
    .attr("id", arrowId).attr("viewBox", "0 -5 10 10").attr("refX", 16)
    .attr("refY", 0).attr("markerWidth", 12).attr("markerHeight", 12)
    .attr("orient", "auto").attr("markerUnits", "userSpaceOnUse")
    .append("path").attr("d", "M0,-5L10,0L0,5").attr("fill", "#9aa0a6");

  // All scene content goes in `root` so d3.zoom can pan/scale it.
  const root = svg.append("g").attr("class", "graph-root");
  svg.call(d3.zoom().scaleExtent([0.25, 4])
    .on("zoom", (e) => root.attr("transform", e.transform)));

  const sim = d3.forceSimulation(nodes)
    .force("link", d3.forceLink(links).id(d => d.id).distance(d => 70 + (d.weight || 1) * 4))
    .force("charge", d3.forceManyBody().strength(-360))
    .force("center", d3.forceCenter(W / 2, H / 2))
    .force("collide", d3.forceCollide().radius(d => radius(d) + 6));

  const link = root.append("g").selectAll("line").data(links).join("line")
    .attr("class", "link").attr("stroke", "#9aa0a6")
    .attr("stroke-width", d => Math.max(1, Math.sqrt(d.weight)))
    .attr("marker-end", `url(#${arrowId})`);

  const node = root.append("g").selectAll("g").data(nodes).join("g")
    .attr("class", "node")
    .call(d3.drag()
      .on("start", (e, d) => { if (!e.active) sim.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
      .on("drag", (e, d) => { d.fx = e.x; d.fy = e.y; })
      .on("end", (e, d) => { if (!e.active) sim.alphaTarget(0); d.fx = null; d.fy = null; }));

  node.append("circle").attr("r", radius).attr("fill", d => colorOf(d.module));
  node.append("text").attr("dy", d => -radius(d) - 4).attr("text-anchor", "middle")
    .text(d => stripPrefix(d.module).replace(/^routers\./, ""));

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

function renderMatrix(metrics, edges) {
  const svg = d3.select("#matrix");
  svg.selectAll("*").remove();
  if (!metrics.length) return;

  const mods = metrics.map(m => m.module).sort();
  const cell = 22, pad = 130;
  const W = pad + mods.length * cell + 16;
  const H = pad + mods.length * cell + 16;
  svg.attr("viewBox", [0, 0, W, H]).style("width", "100%")
     .style("max-width", `${W}px`).style("height", "auto");

  const lookup = {};
  edges.forEach(e => { lookup[`${e.source}→${e.target}`] = e.weight; });
  const maxW = Math.max(1, ...edges.map(e => e.weight || 0));
  const colorScale = d3.scaleSequential(d3.interpolateCubehelix("#1a1d24", "#4dd0e1"))
    .domain([0, maxW]);

  mods.forEach((m, i) => {
    svg.append("text").attr("class", "label").attr("x", pad - 6)
       .attr("y", pad + i * cell + cell * 0.7).attr("text-anchor", "end")
       .style("font-size", "11px").style("fill", "var(--text)").text(m);
    svg.append("text").attr("class", "label")
       .attr("x", pad + i * cell + cell * 0.5).attr("y", pad - 6)
       .attr("text-anchor", "start")
       .attr("transform", `rotate(-45 ${pad + i * cell + cell * 0.5} ${pad - 6})`)
       .style("font-size", "11px").style("fill", "var(--text)").text(m);
  });

  mods.forEach((src, i) => {
    mods.forEach((dst, j) => {
      const w = lookup[`${src}→${dst}`] || 0;
      const rect = svg.append("rect").attr("class", "cell")
        .attr("x", pad + j * cell).attr("y", pad + i * cell)
        .attr("width", cell - 1).attr("height", cell - 1)
        .attr("stroke", "var(--bg)").attr("stroke-width", 1)
        .attr("fill", src === dst ? "#0f1115" : (w > 0 ? colorScale(w) : "#1a1d24"));
      if (w > 0) {
        rect.append("title").text(`${src} imports ${dst}: ${w} name(s)`);
        svg.append("text").attr("x", pad + j * cell + cell / 2)
           .attr("y", pad + i * cell + cell * 0.7).attr("text-anchor", "middle")
           .style("font-size", "10px").style("pointer-events", "none")
           .style("fill", w > maxW * 0.5 ? "#0f1115" : "#e8eaed").text(w);
      }
    });
  });
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}
