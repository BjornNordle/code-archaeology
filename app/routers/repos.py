"""Repo CRUD + scan trigger endpoints."""
from __future__ import annotations

import json
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from database import Repo, ScanJob, get_db
from scanner import submit_scan

router = APIRouter(prefix="/api/repos", tags=["repos"])


class RepoCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)
    url: Optional[str] = None
    local_path: Optional[str] = None
    sub_path: Optional[str] = None
    default_branch: str = "main"


class RepoOut(BaseModel):
    id: int
    name: str
    url: Optional[str]
    local_path: Optional[str]
    sub_path: Optional[str]
    default_branch: str
    created_at: datetime
    last_scanned_sha: Optional[str]

    class Config:
        from_attributes = True


class ScanRequest(BaseModel):
    filter_kind: str = "all"   # all|since|last_n|range|sha_list
    filter_value: dict = Field(default_factory=dict)


@router.get("", response_model=list[RepoOut])
def list_repos(db: Session = Depends(get_db)):
    return db.execute(select(Repo).order_by(Repo.created_at.desc())).scalars().all()


@router.post("", response_model=RepoOut, status_code=201)
def create_repo(payload: RepoCreate, db: Session = Depends(get_db)):
    if not payload.url and not payload.local_path:
        raise HTTPException(400, "must provide url or local_path")
    if db.execute(select(Repo).where(Repo.name == payload.name)).scalar_one_or_none():
        raise HTTPException(409, "repo with that name already exists")
    repo = Repo(**payload.model_dump())
    db.add(repo)
    db.commit()
    db.refresh(repo)
    return repo


@router.get("/{repo_id}", response_model=RepoOut)
def get_repo(repo_id: int, db: Session = Depends(get_db)):
    repo = db.get(Repo, repo_id)
    if not repo:
        raise HTTPException(404)
    return repo


@router.delete("/{repo_id}", status_code=204)
def delete_repo(repo_id: int, db: Session = Depends(get_db)):
    repo = db.get(Repo, repo_id)
    if not repo:
        raise HTTPException(404)
    db.delete(repo)
    db.commit()


@router.post("/{repo_id}/scan", status_code=202)
def trigger_scan(repo_id: int, payload: ScanRequest, db: Session = Depends(get_db)):
    repo = db.get(Repo, repo_id)
    if not repo:
        raise HTTPException(404)
    job = ScanJob(
        repo_id=repo.id,
        filter_kind=payload.filter_kind or "all",
        filter_value=json.dumps(payload.filter_value or {}),
    )
    db.add(job)
    db.commit()
    db.refresh(job)
    submit_scan(job.id)
    return {"job_id": job.id, "status": job.status}


@router.get("/{repo_id}/jobs")
def list_jobs(repo_id: int, db: Session = Depends(get_db)):
    if not db.get(Repo, repo_id):
        raise HTTPException(404)
    jobs = db.execute(
        select(ScanJob).where(ScanJob.repo_id == repo_id)
        .order_by(ScanJob.created_at.desc())
    ).scalars().all()
    return [
        {
            "id": j.id,
            "status": j.status,
            "filter_kind": j.filter_kind,
            "filter_value": json.loads(j.filter_value) if j.filter_value else {},
            "total_commits": j.total_commits,
            "scanned_commits": j.scanned_commits,
            "started_at": j.started_at,
            "finished_at": j.finished_at,
            "error": j.error,
            "created_at": j.created_at,
        }
        for j in jobs
    ]
