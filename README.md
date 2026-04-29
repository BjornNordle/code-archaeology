<<<<<<< HEAD

=======
# code-archaeology

Per-commit architecture-metrics scanner for any git repo. Walks the entire
commit history (or a configurable subset), runs a Python AST analyzer on each
commit, and stores per-module metrics so you can visualise how a codebase's
size, coupling and cohesion evolve over time.

The default scan target is **every commit**; filter to a subset (since-date,
last-N, range, or explicit SHAs) only when you need to.

> [!info] Companion project
> Mirrors the deployment shape of [uptime-monitor](https://github.com/BjornNordle/Uptime_monitor):
> FastAPI + SQLite WAL, vanilla-JS SPA (no build step), Docker Compose with
> Caddy, self-hosted GitHub Actions runner.

## What it shows

- **Timeline charts** — LOC, classes, instability, LCOM4 across every scanned
  commit. Click a point or drag the scrubber to inspect any commit.
- **Architecture snapshot** — full force-directed module graph at any commit
  (mirrors `analyze.py`'s output, but fed from stored data — no recompute).
- **Hot-spots** — modules with the worst-trending metrics over a window.
- **Per-module timeline** (API only for now) — how a single module evolved.

## Local dev

```bash
cd code-archaeology/app
python -m venv venv && source venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```

Then `POST /api/repos` with a local-path repo (e.g. the uptime-monitor
checkout itself), and `POST /api/repos/{id}/scan` with `{"filter_kind":"all"}`.

## Docker

```bash
cd code-archaeology
docker compose up --build
# → http://localhost:8081
```

To scan a host-side repo from inside the container, mount it read-only in
`docker-compose.yml` (the `/repos` line is commented out by default) and
register the repo with `local_path: /repos/your-repo`.

## Production deploy

Same self-hosted-runner pattern as uptime-monitor:

1. Push this directory to a GitHub repo.
2. On the homeserver, run `docs/homeserver-runner-setup.sh` after exporting
   `REPO_URL` and `GITHUB_RUNNER_TOKEN`.
3. Optional: set `DOMAIN` and `UPTIME_DEPLOY_API_KEY` GitHub secrets.

The CI workflow (`.github/workflows/deploy.yml`) runs `docker compose up -d
--build` on every push to `main` and posts a deploy notification to the
uptime-monitor's `/api/notifications/broadcast` if `UPTIME_DEPLOY_API_KEY`
is set.

## Caveats / future work

- **Python-only AST**: classes, methods, fan-in/out, LCOM4 only work for
  `.py`. Other extensions (`.ts`, `.js`, `.go`, `.rs`, …) get a per-extension
  LOC fallback aggregated as `generic_loc`/`generic_files`. Extend with
  language-specific analyzers (tree-sitter is the natural next step).
- **Linear walk**: `git log --first-parent --reverse` — merges aren't
  re-scanned, only their first parents. Good enough for `main`-style
  histories; less so for octopus merges.
- **Single-instance worker**: scanner uses a small thread-pool with one job
  per repo at a time. For huge histories on multiple repos in parallel,
  scale up `_executor` workers in `scanner.py`.
>>>>>>> e1093d4 (Initial scaffold: scanner that walks every commit and visualises code-quality timeline)
