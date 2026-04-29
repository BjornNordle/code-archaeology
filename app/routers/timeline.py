"""Timeline + per-commit + per-module endpoints. Read-mostly hot path."""
from __future__ import annotations

import json

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select, func
from sqlalchemy.orm import Session

from database import Commit, ModuleMetric, Repo, RepoMetric, Snapshot, get_db

router = APIRouter(prefix="/api/repos", tags=["timeline"])


@router.get("/{repo_id}/timeline")
def repo_timeline(repo_id: int, db: Session = Depends(get_db)):
    """Aggregate per-commit metrics, oldest-first — chart-ready."""
    if not db.get(Repo, repo_id):
        raise HTTPException(404)
    rows = db.execute(
        select(Commit, RepoMetric)
        .join(RepoMetric, RepoMetric.commit_id == Commit.id)
        .where(Commit.repo_id == repo_id)
        .order_by(Commit.committed_at.asc().nullsfirst(), Commit.id.asc())
    ).all()
    return [
        {
            "sha": c.sha,
            "short_sha": c.sha[:7],
            "committed_at": c.committed_at,
            "author": c.author,
            "message": (c.message or "").splitlines()[0] if c.message else "",
            "modules": m.modules,
            "loc": m.loc,
            "classes": m.classes,
            "functions": m.functions,
            "edges": m.edges,
            "external_deps": m.external_deps,
            "avg_instability": m.avg_instability,
            "avg_lcom4": m.avg_lcom4,
            "generic_loc": m.generic_loc,
            "generic_files": m.generic_files,
        }
        for c, m in rows
    ]


@router.get("/{repo_id}/commits")
def list_commits(repo_id: int, limit: int = Query(500, ge=1, le=10000),
                 db: Session = Depends(get_db)):
    if not db.get(Repo, repo_id):
        raise HTTPException(404)
    rows = db.execute(
        select(Commit).where(Commit.repo_id == repo_id)
        .order_by(Commit.committed_at.desc().nullslast(), Commit.id.desc())
        .limit(limit)
    ).scalars().all()
    return [
        {
            "sha": c.sha,
            "short_sha": c.sha[:7],
            "parent_sha": c.parent_sha,
            "message": (c.message or "").splitlines()[0] if c.message else "",
            "author": c.author,
            "committed_at": c.committed_at,
            "scanned_at": c.scanned_at,
            "scan_error": bool(c.scan_error),
        }
        for c in rows
    ]


@router.get("/{repo_id}/commits/{sha}/snapshot")
def get_snapshot(repo_id: int, sha: str, db: Session = Depends(get_db)):
    """Full per-commit module + edge data — drives the architecture graph."""
    commit = db.execute(
        select(Commit).where(Commit.repo_id == repo_id, Commit.sha.startswith(sha))
    ).scalar_one_or_none()
    if not commit:
        raise HTTPException(404, "commit not found")
    snapshot = db.get(Snapshot, commit.id)
    if not snapshot:
        raise HTTPException(404, "snapshot not stored for this commit")
    data = json.loads(snapshot.data_json)
    return {
        "sha": commit.sha,
        "short_sha": commit.sha[:7],
        "committed_at": commit.committed_at,
        "author": commit.author,
        "message": commit.message,
        "metrics": data["metrics"],
        "edges": data["edges"],
        "mermaid_classes": snapshot.mermaid_classes,
        "mermaid_layers": snapshot.mermaid_layers,
    }


@router.get("/{repo_id}/modules/{module:path}/timeline")
def module_timeline(repo_id: int, module: str, db: Session = Depends(get_db)):
    """All metric rows for one module across every scanned commit."""
    if not db.get(Repo, repo_id):
        raise HTTPException(404)
    rows = db.execute(
        select(Commit, ModuleMetric)
        .join(ModuleMetric, ModuleMetric.commit_id == Commit.id)
        .where(Commit.repo_id == repo_id, ModuleMetric.module == module)
        .order_by(Commit.committed_at.asc().nullsfirst(), Commit.id.asc())
    ).all()
    return [
        {
            "sha": c.sha,
            "short_sha": c.sha[:7],
            "committed_at": c.committed_at,
            "loc": m.loc,
            "classes": m.classes,
            "functions": m.functions,
            "fan_in": m.fan_in,
            "fan_out": m.fan_out,
            "instability": m.instability,
            "external_deps": m.external_deps,
            "avg_lcom4": m.avg_lcom4,
        }
        for c, m in rows
    ]


@router.get("/{repo_id}/hotspots")
def hotspots(repo_id: int, window: int = Query(20, ge=2, le=500),
             db: Session = Depends(get_db)):
    """Modules that grew or worsened the most over the last `window` commits.

    Returns positive deltas of LOC, instability, and LCOM4 between the
    `window`-th-most-recent commit and the latest commit.
    """
    if not db.get(Repo, repo_id):
        raise HTTPException(404)

    recent = db.execute(
        select(Commit.id).where(Commit.repo_id == repo_id)
        .order_by(Commit.committed_at.desc().nullslast(), Commit.id.desc())
        .limit(window)
    ).scalars().all()
    if len(recent) < 2:
        return []
    latest_id, oldest_id = recent[0], recent[-1]

    latest = {m.module: m for m in db.execute(
        select(ModuleMetric).where(ModuleMetric.commit_id == latest_id)
    ).scalars().all()}
    oldest = {m.module: m for m in db.execute(
        select(ModuleMetric).where(ModuleMetric.commit_id == oldest_id)
    ).scalars().all()}

    rows = []
    for module, lm in latest.items():
        om = oldest.get(module)
        loc_delta = lm.loc - (om.loc if om else 0)
        inst_delta = lm.instability - (om.instability if om else 0)
        lcom_delta = (lm.avg_lcom4 or 0) - (om.avg_lcom4 if om and om.avg_lcom4 else 0)
        rows.append({
            "module": module,
            "loc_now": lm.loc,
            "loc_delta": loc_delta,
            "instability_now": lm.instability,
            "instability_delta": round(inst_delta, 3),
            "lcom4_now": lm.avg_lcom4,
            "lcom4_delta": round(lcom_delta, 2),
            "is_new": om is None,
        })
    rows.sort(key=lambda r: (r["loc_delta"], r["instability_delta"]), reverse=True)
    return rows


@router.get("/{repo_id}/stats")
def repo_stats(repo_id: int, db: Session = Depends(get_db)):
    """Top-line counters for the repo's overview header."""
    if not db.get(Repo, repo_id):
        raise HTTPException(404)
    n_commits = db.execute(
        select(func.count(Commit.id)).where(Commit.repo_id == repo_id)
    ).scalar_one()
    latest = db.execute(
        select(Commit, RepoMetric).join(RepoMetric, RepoMetric.commit_id == Commit.id)
        .where(Commit.repo_id == repo_id)
        .order_by(Commit.committed_at.desc().nullslast(), Commit.id.desc())
        .limit(1)
    ).first()
    if not latest:
        return {"commits_scanned": n_commits, "latest": None}
    c, m = latest
    return {
        "commits_scanned": n_commits,
        "latest": {
            "sha": c.sha,
            "short_sha": c.sha[:7],
            "committed_at": c.committed_at,
            "modules": m.modules,
            "loc": m.loc,
            "classes": m.classes,
            "functions": m.functions,
            "avg_instability": m.avg_instability,
            "avg_lcom4": m.avg_lcom4,
        },
    }
