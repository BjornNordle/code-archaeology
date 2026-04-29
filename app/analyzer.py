"""
Architecture analyzer — extracts module/class metrics from a source tree.

Originally from uptime-monitor/docs/architecture/analyze.py, refactored as a
library so the scanner can call it programmatically per commit.

For Python files: full AST analysis (imports, classes, methods, LCOM4).
For other files: line-count fallback only — TODO: add language-specific
analyzers (TS/JS via tree-sitter, Go via go/ast, etc.).
"""
from __future__ import annotations

import ast
from collections import defaultdict
from pathlib import Path
from typing import Optional

PYTHON_EXTS = {".py"}
GENERIC_EXTS = {
    ".js", ".jsx", ".ts", ".tsx", ".go", ".rs", ".java", ".kt", ".rb",
    ".php", ".cs", ".cpp", ".c", ".h", ".hpp", ".swift", ".scala", ".sh",
    ".html", ".css", ".scss", ".sass", ".vue", ".svelte", ".sql", ".lua",
}
SKIP_DIRS = {
    "venv", ".venv", "env", "__pycache__", "node_modules", ".git",
    "dist", "build", ".next", ".nuxt", "target", "vendor", ".idea",
    ".vscode", ".pytest_cache", ".mypy_cache", "coverage", ".tox",
}


def _should_skip(path: Path) -> bool:
    return any(p in SKIP_DIRS for p in path.parts)


def build_module_index(root: Path) -> dict[str, Path]:
    """Walk root; return {dotted_module_name: file_path} for Python files."""
    index = {}
    for path in sorted(root.rglob("*.py")):
        if _should_skip(path.relative_to(root)):
            continue
        rel = path.relative_to(root)
        parts = list(rel.parts)
        if parts[-1] == "__init__.py":
            parts = parts[:-1]
        else:
            parts[-1] = parts[-1][:-3]
        if not parts:
            continue
        index[".".join(parts)] = path
    return index


def resolve_import(target: str, internal: set[str]) -> Optional[str]:
    if target in internal:
        return target
    parts = target.split(".")
    for i in range(len(parts), 0, -1):
        cand = ".".join(parts[:i])
        if cand in internal:
            return cand
    return None


def analyze_python_module(name: str, path: Path, internal: set[str]) -> dict:
    try:
        src = path.read_text(encoding="utf-8", errors="replace")
        tree = ast.parse(src)
    except (SyntaxError, ValueError):
        # Don't fail the whole scan because one file has a syntax error.
        return _empty_module(name, path, loc=0, parse_error=True)

    info = {
        "name": name,
        "path": str(path),
        "lang": "python",
        "loc": len(src.splitlines()),
        "imports_internal": [],
        "imports_external": [],
        "classes": [],
        "functions": [],
        "decorators_count": 0,
        "parse_error": False,
    }

    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                target = alias.name
                resolved = resolve_import(target, internal)
                if resolved:
                    info["imports_internal"].append({"target": resolved, "names": [target]})
                else:
                    info["imports_external"].append(target)
        elif isinstance(node, ast.ImportFrom):
            module = node.module or ""
            names = [n.name for n in node.names]
            resolved = resolve_import(module, internal) if module else None
            if resolved:
                info["imports_internal"].append({"target": resolved, "names": names})
            elif module:
                info["imports_external"].append(module)

    for node in tree.body:
        if isinstance(node, ast.ClassDef):
            cls = {
                "name": node.name,
                "bases": [ast.unparse(b) for b in node.bases],
                "methods": [],
                "attrs": [],
                "method_attr_refs": {},
            }
            for item in node.body:
                if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    cls["methods"].append(item.name)
                    refs = set()
                    for sub in ast.walk(item):
                        if isinstance(sub, ast.Attribute) and isinstance(sub.value, ast.Name):
                            if sub.value.id == "self":
                                refs.add(sub.attr)
                    cls["method_attr_refs"][item.name] = sorted(refs)
                elif isinstance(item, ast.Assign):
                    for tgt in item.targets:
                        if isinstance(tgt, ast.Name):
                            cls["attrs"].append(tgt.id)
                elif isinstance(item, ast.AnnAssign) and isinstance(item.target, ast.Name):
                    cls["attrs"].append(item.target.id)
            info["classes"].append(cls)
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            info["functions"].append({
                "name": node.name,
                "decorators": [ast.unparse(d) for d in node.decorator_list],
            })
            info["decorators_count"] += len(node.decorator_list)

    return info


def _empty_module(name: str, path: Path, loc: int, parse_error: bool = False) -> dict:
    return {
        "name": name,
        "path": str(path),
        "lang": "python" if path.suffix in PYTHON_EXTS else "other",
        "loc": loc,
        "imports_internal": [],
        "imports_external": [],
        "classes": [],
        "functions": [],
        "decorators_count": 0,
        "parse_error": parse_error,
    }


def count_generic_files(root: Path) -> dict:
    """Fallback for non-Python files: per-extension LOC and file counts.

    Returned as a single aggregated record. Granular per-file analysis is left
    to a future enhancement (tree-sitter etc.).
    """
    by_ext = defaultdict(lambda: {"files": 0, "loc": 0})
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        rel = path.relative_to(root)
        if _should_skip(rel):
            continue
        ext = path.suffix.lower()
        if ext not in GENERIC_EXTS:
            continue
        try:
            loc = sum(1 for _ in path.open("rb"))
        except OSError:
            continue
        by_ext[ext]["files"] += 1
        by_ext[ext]["loc"] += loc
    return dict(by_ext)


def compute_lcom4(cls: dict) -> int:
    """LCOM4: count of disconnected method-attr usage clusters (1 = cohesive)."""
    methods = cls["methods"]
    if not methods:
        return 0
    refs = cls["method_attr_refs"]
    parent = {m: m for m in methods}

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb

    for i, a in enumerate(methods):
        for b in methods[i + 1:]:
            if set(refs.get(a, [])) & set(refs.get(b, [])):
                union(a, b)
    return len({find(m) for m in methods})


def compute_metrics(modules: dict[str, dict]) -> tuple[list[dict], list[dict]]:
    """Returns (per-module metrics, edge list) — same shape as analyze.py."""
    fan_in = defaultdict(int)
    fan_out = defaultdict(int)
    edges_map = defaultdict(int)

    for name, info in modules.items():
        targets = set()
        weight = defaultdict(int)
        for imp in info["imports_internal"]:
            t = imp["target"]
            if t and t != name:
                targets.add(t)
                weight[t] += len(imp["names"])
        for t in targets:
            fan_out[name] += 1
            fan_in[t] += 1
            edges_map[(name, t)] = weight[t]

    metrics = []
    for name, info in modules.items():
        ce = fan_out[name]
        ca = fan_in[name]
        instability = round(ce / (ce + ca), 3) if (ce + ca) > 0 else 0.0
        lcom_per_class = [compute_lcom4(c) for c in info["classes"]]
        avg_lcom = round(sum(lcom_per_class) / len(lcom_per_class), 2) if lcom_per_class else None
        external_unique = len({e.split(".")[0] for e in info["imports_external"]})

        metrics.append({
            "module": name,
            "lang": info["lang"],
            "loc": info["loc"],
            "classes": len(info["classes"]),
            "functions": len(info["functions"]),
            "fan_in": ca,
            "fan_out": ce,
            "instability": instability,
            "external_deps": external_unique,
            "avg_lcom4": avg_lcom,
        })

    edges = [{"source": s, "target": t, "weight": w} for (s, t), w in edges_map.items()]
    return metrics, edges


def analyze_tree(root: Path, sub_path: Optional[str] = None) -> dict:
    """Full analysis of a source tree rooted at `root`.

    `sub_path` (optional) restricts the analysis to a subdirectory — useful
    for monorepos where only `app/` is the code under inspection.

    Returns a dict with `modules`, `metrics`, `edges`, `generic`, and
    aggregate totals — ready to be persisted or rendered.
    """
    if sub_path:
        target = root / sub_path
    else:
        target = root
    if not target.is_dir():
        return {"modules": {}, "metrics": [], "edges": [], "generic": {}, "totals": _zero_totals()}

    index = build_module_index(target)
    internal = set(index)
    modules = {n: analyze_python_module(n, p, internal) for n, p in index.items()}
    metrics, edges = compute_metrics(modules)
    generic = count_generic_files(target)

    totals = {
        "modules": len(metrics),
        "loc": sum(m["loc"] for m in metrics),
        "classes": sum(m["classes"] for m in metrics),
        "functions": sum(m["functions"] for m in metrics),
        "edges": len(edges),
        "external_deps": len({
            e for info in modules.values() for e in info["imports_external"]
        }),
        "avg_instability": (
            round(sum(m["instability"] for m in metrics) / len(metrics), 3)
            if metrics else 0.0
        ),
        "avg_lcom4": _avg([m["avg_lcom4"] for m in metrics if m["avg_lcom4"] is not None]),
        "generic_loc": sum(v["loc"] for v in generic.values()),
        "generic_files": sum(v["files"] for v in generic.values()),
    }

    return {
        "modules": modules,
        "metrics": metrics,
        "edges": edges,
        "generic": generic,
        "totals": totals,
    }


def _zero_totals() -> dict:
    return {
        "modules": 0, "loc": 0, "classes": 0, "functions": 0, "edges": 0,
        "external_deps": 0, "avg_instability": 0.0, "avg_lcom4": None,
        "generic_loc": 0, "generic_files": 0,
    }


def _avg(values: list[float]) -> Optional[float]:
    return round(sum(values) / len(values), 2) if values else None
