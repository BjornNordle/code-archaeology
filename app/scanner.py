"""
Commit walker — clones a repo, iterates commits, runs analyzer, persists.

Uses `git worktree add` so the main checkout is never disturbed; multiple
scans on the same repo can run sequentially without conflict.
"""
from __future__ import annotations

import json
import shutil
import subprocess
import threading
import traceback
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path
from typing import Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from analyzer import analyze_tree
from database import (
    Commit, ModuleMetric, RepoMetric, Repo, ScanJob, SessionLocal, Snapshot,
)
from snapshot_html import build_layers_mermaid, build_orm_mermaid

REPOS_DIR = Path(__file__).resolve().parent.parent / "data" / "repos"
WORKTREES_DIR = Path(__file__).resolve().parent.parent / "data" / "worktrees"

# One scan at a time per repo (no contention on the same git dir).
_repo_locks: dict[int, threading.Lock] = {}
_repo_locks_guard = threading.Lock()
_executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="scanner")


def _lock_for(repo_id: int) -> threading.Lock:
    with _repo_locks_guard:
        if repo_id not in _repo_locks:
            _repo_locks[repo_id] = threading.Lock()
        return _repo_locks[repo_id]


# ── git helpers ──────────────────────────────────────────────────────────────

def _git(args: list[str], cwd: Path, check: bool = True) -> str:
    res = subprocess.run(
        ["git", *args], cwd=str(cwd), capture_output=True, text=True,
    )
    if check and res.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} failed: {res.stderr.strip()}")
    return res.stdout


def ensure_repo_checkout(repo: Repo) -> Path:
    """Make sure we have a working git directory for this repo. Returns its path."""
    if repo.local_path:
        path = Path(repo.local_path).resolve()
        if not (path / ".git").exists():
            raise RuntimeError(f"local_path {path} is not a git repo")
        # Fetch latest if it's a clone we control
        try:
            _git(["fetch", "--all", "--tags", "--prune"], path, check=False)
        except Exception:
            pass
        return path

    if not repo.url:
        raise RuntimeError(f"repo {repo.id} has neither url nor local_path")

    REPOS_DIR.mkdir(parents=True, exist_ok=True)
    target = REPOS_DIR / f"repo-{repo.id}"
    if target.exists() and (target / ".git").exists():
        _git(["fetch", "--all", "--tags", "--prune"], target, check=False)
        return target
    if target.exists():
        shutil.rmtree(target)
    _git(["clone", "--no-single-branch", repo.url, str(target)], REPOS_DIR)
    return target


def list_commits(repo_path: Path, branch: str = "HEAD") -> list[dict]:
    """Walk commit history first-parent. Returns oldest-first."""
    fmt = "%H%x09%P%x09%aI%x09%an%x09%s"
    out = _git(
        ["log", "--first-parent", "--reverse", f"--format={fmt}", branch],
        repo_path,
    )
    commits = []
    for line in out.splitlines():
        parts = line.split("\t")
        if len(parts) < 5:
            continue
        sha, parents, iso, author, message = parts[0], parts[1], parts[2], parts[3], parts[4]
        commits.append({
            "sha": sha,
            "parent_sha": parents.split(" ")[0] if parents else None,
            "committed_at": _parse_iso(iso),
            "author": author,
            "message": message,
        })
    return commits


def _parse_iso(s: str) -> Optional[datetime]:
    try:
        return datetime.fromisoformat(s)
    except ValueError:
        return None


# ── commit filtering ─────────────────────────────────────────────────────────

def filter_commits(commits: list[dict], filter_kind: str, filter_value: dict) -> list[dict]:
    """Apply user-supplied commit filter. Default ('all') keeps every commit."""
    if filter_kind == "all" or not filter_kind:
        return commits
    if filter_kind == "last_n":
        n = int(filter_value.get("n", 50))
        return commits[-n:]
    if filter_kind == "since":
        since = filter_value.get("since")
        if not since:
            return commits
        cutoff = datetime.fromisoformat(since)
        return [c for c in commits if c["committed_at"] and c["committed_at"] >= cutoff]
    if filter_kind == "sha_list":
        wanted = set(filter_value.get("shas", []))
        return [c for c in commits if c["sha"] in wanted]
    if filter_kind == "range":
        # filter_value: {"from": "<sha>", "to": "<sha>"}
        from_sha = filter_value.get("from")
        to_sha = filter_value.get("to")
        out, started = [], from_sha is None
        for c in commits:
            if not started and from_sha and c["sha"].startswith(from_sha):
                started = True
            if started:
                out.append(c)
            if to_sha and c["sha"].startswith(to_sha):
                break
        return out
    return commits


# ── single-commit analysis ───────────────────────────────────────────────────

def analyze_commit(repo_path: Path, sha: str, sub_path: Optional[str]) -> dict:
    """Check out `sha` into a temporary worktree and analyze it."""
    WORKTREES_DIR.mkdir(parents=True, exist_ok=True)
    wt_path = WORKTREES_DIR / f"{repo_path.name}-{sha[:12]}"
    if wt_path.exists():
        # Stale worktree from a crashed scan — clean up.
        _git(["worktree", "remove", "--force", str(wt_path)], repo_path, check=False)
        if wt_path.exists():
            shutil.rmtree(wt_path, ignore_errors=True)

    _git(["worktree", "add", "--detach", "--force", str(wt_path), sha], repo_path)
    try:
        result = analyze_tree(wt_path, sub_path=sub_path)
    finally:
        _git(["worktree", "remove", "--force", str(wt_path)], repo_path, check=False)
        if wt_path.exists():
            shutil.rmtree(wt_path, ignore_errors=True)
    return result


# ── persistence ──────────────────────────────────────────────────────────────

def persist_commit(db: Session, repo: Repo, meta: dict, analysis: dict) -> Commit:
    """Create or update the Commit row and its metric children."""
    existing = db.execute(
        select(Commit).where(Commit.repo_id == repo.id, Commit.sha == meta["sha"])
    ).scalar_one_or_none()
    if existing:
        # Wipe old metrics so re-scans replace cleanly.
        db.query(ModuleMetric).filter(ModuleMetric.commit_id == existing.id).delete()
        db.query(RepoMetric).filter(RepoMetric.commit_id == existing.id).delete()
        db.query(Snapshot).filter(Snapshot.commit_id == existing.id).delete()
        commit = existing
        commit.scanned_at = datetime.utcnow()
        commit.scan_error = None
    else:
        commit = Commit(
            repo_id=repo.id,
            sha=meta["sha"],
            parent_sha=meta.get("parent_sha"),
            message=meta.get("message"),
            author=meta.get("author"),
            committed_at=meta.get("committed_at"),
            scanned_at=datetime.utcnow(),
        )
        db.add(commit)
        db.flush()

    totals = analysis["totals"]
    db.add(RepoMetric(
        commit_id=commit.id,
        modules=totals["modules"],
        loc=totals["loc"],
        classes=totals["classes"],
        functions=totals["functions"],
        edges=totals["edges"],
        external_deps=totals["external_deps"],
        avg_instability=totals["avg_instability"],
        avg_lcom4=totals["avg_lcom4"],
        generic_loc=totals["generic_loc"],
        generic_files=totals["generic_files"],
    ))

    for m in analysis["metrics"]:
        db.add(ModuleMetric(
            commit_id=commit.id,
            module=m["module"],
            lang=m.get("lang", "python"),
            loc=m["loc"],
            classes=m["classes"],
            functions=m["functions"],
            fan_in=m["fan_in"],
            fan_out=m["fan_out"],
            instability=m["instability"],
            external_deps=m["external_deps"],
            avg_lcom4=m["avg_lcom4"],
        ))

    snapshot_data = {"metrics": analysis["metrics"], "edges": analysis["edges"]}
    db.add(Snapshot(
        commit_id=commit.id,
        data_json=json.dumps(snapshot_data),
        mermaid_classes=build_orm_mermaid(analysis["modules"]),
        mermaid_layers=build_layers_mermaid(analysis["modules"]),
    ))

    return commit


# ── job runner ───────────────────────────────────────────────────────────────

def submit_scan(job_id: int):
    """Queue a scan job onto the executor. Non-blocking."""
    _executor.submit(_run_job, job_id)


def _run_job(job_id: int):
    db = SessionLocal()
    try:
        job = db.get(ScanJob, job_id)
        if not job:
            return
        repo = db.get(Repo, job.repo_id)
        if not repo:
            job.status = "error"
            job.error = "repo deleted"
            db.commit()
            return

        with _lock_for(repo.id):
            job.status = "running"
            job.started_at = datetime.utcnow()
            db.commit()

            try:
                repo_path = ensure_repo_checkout(repo)
                branch = repo.default_branch or "HEAD"
                all_commits = list_commits(repo_path, branch)

                filter_value = json.loads(job.filter_value) if job.filter_value else {}
                target_commits = filter_commits(all_commits, job.filter_kind or "all", filter_value)
                job.total_commits = len(target_commits)
                db.commit()

                for meta in target_commits:
                    try:
                        analysis = analyze_commit(repo_path, meta["sha"], repo.sub_path)
                        persist_commit(db, repo, meta, analysis)
                        job.scanned_commits += 1
                        repo.last_scanned_sha = meta["sha"]
                        db.commit()
                    except Exception as exc:
                        # Record per-commit error, keep scanning.
                        existing = db.execute(
                            select(Commit).where(Commit.repo_id == repo.id, Commit.sha == meta["sha"])
                        ).scalar_one_or_none()
                        if existing:
                            existing.scan_error = f"{exc}\n{traceback.format_exc()}"
                        else:
                            db.add(Commit(
                                repo_id=repo.id, sha=meta["sha"],
                                parent_sha=meta.get("parent_sha"),
                                message=meta.get("message"),
                                author=meta.get("author"),
                                committed_at=meta.get("committed_at"),
                                scan_error=f"{exc}\n{traceback.format_exc()}",
                            ))
                        db.commit()

                job.status = "done"
                job.finished_at = datetime.utcnow()
                db.commit()
            except Exception as exc:
                job.status = "error"
                job.error = f"{exc}\n{traceback.format_exc()}"
                job.finished_at = datetime.utcnow()
                db.commit()
    finally:
        db.close()
