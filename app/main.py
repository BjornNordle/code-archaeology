"""
code-archaeology — FastAPI entry point.

Endpoints under /api/*; static SPA served at /. Mirrors the
uptime-monitor structure: lifespan-managed startup, single-process
SQLite + WAL, vanilla-JS frontend, no build step.
"""
from __future__ import annotations

import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from database import init_db
from routers import repos as repos_router
from routers import timeline as timeline_router

APP_DIR = Path(__file__).resolve().parent
VERSION = (APP_DIR / "VERSION").read_text().strip() if (APP_DIR / "VERSION").exists() else "0.0.0"


@asynccontextmanager
async def lifespan(_: FastAPI):
    init_db()
    yield


app = FastAPI(
    title="code-archaeology",
    version=VERSION,
    description="Per-commit architecture metrics — visualize code-quality and tech-debt over time.",
    docs_url="/api/docs",
    redoc_url="/api/redoc",
    openapi_url="/api/openapi.json",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
    allow_credentials=False,
)

app.include_router(repos_router.router)
app.include_router(timeline_router.router)


@app.get("/api/version")
def get_version():
    return {"version": VERSION}


@app.get("/api/health")
def health():
    return {"ok": True}


# ── Static SPA ────────────────────────────────────────────────────────────────
STATIC_DIR = APP_DIR / "static"
if STATIC_DIR.is_dir():
    app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

    @app.get("/")
    def index():
        return FileResponse(str(STATIC_DIR / "index.html"))

    @app.get("/repo/{repo_id:int}")
    def repo_page(repo_id: int):
        return FileResponse(str(STATIC_DIR / "repo.html"))

    @app.get("/repo/{repo_id:int}/commit/{sha}")
    def commit_page(repo_id: int, sha: str):
        return FileResponse(str(STATIC_DIR / "commit.html"))


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=int(os.environ.get("PORT", "8000")))
