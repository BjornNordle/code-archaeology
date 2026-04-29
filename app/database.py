"""
SQLAlchemy models for code-archaeology.

A Repo holds many Commits; each Commit holds many ModuleMetrics plus one
RepoMetric aggregate. Scan progress is tracked in ScanJob rows.
"""
from __future__ import annotations

import os
from datetime import datetime
from pathlib import Path

from sqlalchemy import (
    Column, DateTime, Float, ForeignKey, Integer, String, Text,
    UniqueConstraint, create_engine, event, Index,
)
from sqlalchemy.orm import declarative_base, relationship, sessionmaker

DATABASE_URL = os.environ.get(
    "DATABASE_URL",
    f"sqlite:///{Path(__file__).resolve().parent.parent}/data/archaeology.db",
)

connect_args = {"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {}
engine = create_engine(DATABASE_URL, connect_args=connect_args, future=True)


@event.listens_for(engine, "connect")
def _set_sqlite_pragma(dbapi_conn, _):
    if DATABASE_URL.startswith("sqlite"):
        cur = dbapi_conn.cursor()
        cur.execute("PRAGMA journal_mode=WAL")
        cur.execute("PRAGMA synchronous=NORMAL")
        cur.execute("PRAGMA foreign_keys=ON")
        cur.close()


SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)
Base = declarative_base()


class Repo(Base):
    __tablename__ = "repos"
    id = Column(Integer, primary_key=True)
    name = Column(String, nullable=False, unique=True)
    url = Column(String, nullable=True)              # remote URL (optional)
    local_path = Column(String, nullable=True)       # path inside container
    sub_path = Column(String, nullable=True)         # restrict analysis to this subdir
    default_branch = Column(String, default="main")
    created_at = Column(DateTime, default=datetime.utcnow)
    last_scanned_sha = Column(String, nullable=True)

    commits = relationship("Commit", back_populates="repo", cascade="all, delete-orphan")
    jobs = relationship("ScanJob", back_populates="repo", cascade="all, delete-orphan")


class Commit(Base):
    __tablename__ = "commits"
    id = Column(Integer, primary_key=True)
    repo_id = Column(Integer, ForeignKey("repos.id", ondelete="CASCADE"), nullable=False)
    sha = Column(String, nullable=False)
    parent_sha = Column(String, nullable=True)
    message = Column(Text, nullable=True)
    author = Column(String, nullable=True)
    committed_at = Column(DateTime, nullable=True)
    scanned_at = Column(DateTime, default=datetime.utcnow)
    scan_error = Column(Text, nullable=True)

    repo = relationship("Repo", back_populates="commits")
    repo_metric = relationship("RepoMetric", back_populates="commit",
                               uselist=False, cascade="all, delete-orphan")
    module_metrics = relationship("ModuleMetric", back_populates="commit",
                                  cascade="all, delete-orphan")
    snapshot = relationship("Snapshot", back_populates="commit",
                            uselist=False, cascade="all, delete-orphan")

    __table_args__ = (
        UniqueConstraint("repo_id", "sha", name="uix_repo_sha"),
        Index("ix_commit_repo_committed_at", "repo_id", "committed_at"),
    )


class RepoMetric(Base):
    """One aggregate row per commit — fast for timeline queries."""
    __tablename__ = "repo_metrics"
    commit_id = Column(Integer, ForeignKey("commits.id", ondelete="CASCADE"), primary_key=True)
    modules = Column(Integer, default=0)
    loc = Column(Integer, default=0)
    classes = Column(Integer, default=0)
    functions = Column(Integer, default=0)
    edges = Column(Integer, default=0)
    external_deps = Column(Integer, default=0)
    avg_instability = Column(Float, default=0.0)
    avg_lcom4 = Column(Float, nullable=True)
    generic_loc = Column(Integer, default=0)
    generic_files = Column(Integer, default=0)

    commit = relationship("Commit", back_populates="repo_metric")


class ModuleMetric(Base):
    __tablename__ = "module_metrics"
    id = Column(Integer, primary_key=True)
    commit_id = Column(Integer, ForeignKey("commits.id", ondelete="CASCADE"), nullable=False)
    module = Column(String, nullable=False)
    lang = Column(String, default="python")
    loc = Column(Integer, default=0)
    classes = Column(Integer, default=0)
    functions = Column(Integer, default=0)
    fan_in = Column(Integer, default=0)
    fan_out = Column(Integer, default=0)
    instability = Column(Float, default=0.0)
    external_deps = Column(Integer, default=0)
    avg_lcom4 = Column(Float, nullable=True)

    commit = relationship("Commit", back_populates="module_metrics")

    __table_args__ = (
        Index("ix_module_metric_commit_module", "commit_id", "module"),
        Index("ix_module_metric_module", "module"),
    )


class Snapshot(Base):
    """Full per-commit snapshot data (modules + edges) as JSON for the
    architecture graph view. Stored once per commit."""
    __tablename__ = "snapshots"
    commit_id = Column(Integer, ForeignKey("commits.id", ondelete="CASCADE"), primary_key=True)
    data_json = Column(Text, nullable=False)        # {metrics, edges}
    mermaid_classes = Column(Text, nullable=True)
    mermaid_layers = Column(Text, nullable=True)

    commit = relationship("Commit", back_populates="snapshot")


class ScanJob(Base):
    __tablename__ = "scan_jobs"
    id = Column(Integer, primary_key=True)
    repo_id = Column(Integer, ForeignKey("repos.id", ondelete="CASCADE"), nullable=False)
    status = Column(String, default="pending")      # pending|running|done|error|cancelled
    filter_kind = Column(String, default="all")     # all|since|last_n|range|sha_list
    filter_value = Column(Text, nullable=True)      # JSON-encoded filter args
    total_commits = Column(Integer, default=0)
    scanned_commits = Column(Integer, default=0)
    started_at = Column(DateTime, nullable=True)
    finished_at = Column(DateTime, nullable=True)
    error = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    repo = relationship("Repo", back_populates="jobs")


def init_db():
    Path(DATABASE_URL.replace("sqlite:///", "")).parent.mkdir(parents=True, exist_ok=True) \
        if DATABASE_URL.startswith("sqlite") else None
    Base.metadata.create_all(bind=engine)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
