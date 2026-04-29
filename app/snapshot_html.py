"""
Mermaid diagram builders for the per-commit architecture snapshot.

The full HTML page is rendered client-side from the snapshot JSON; these
helpers produce the static Mermaid source for class diagrams and the
layered architecture overview.
"""
from __future__ import annotations


def build_orm_mermaid(modules: dict[str, dict]) -> str:
    db = modules.get("database")
    if not db:
        return "classDiagram\n  class NoDatabaseModule"

    lines = ["classDiagram"]
    sa_models = [c for c in db["classes"] if any("Base" in b for b in c["bases"])]
    for cls in sa_models:
        lines.append(f"  class {cls['name']} {{")
        for attr in cls["attrs"][:14]:
            lines.append(f"    +{attr}")
        if len(cls["attrs"]) > 14:
            lines.append(f"    +... {len(cls['attrs']) - 14} more")
        lines.append("  }")

    # Heuristic FK-style relationships.
    relations = [
        ("Commit", "Repo", "repo_id"),
        ("RepoMetric", "Commit", "commit_id"),
        ("ModuleMetric", "Commit", "commit_id"),
        ("Snapshot", "Commit", "commit_id"),
        ("ScanJob", "Repo", "repo_id"),
    ]
    present = {c["name"] for c in sa_models}
    for child, parent, label in relations:
        if child in present and parent in present:
            lines.append(f"  {parent} <|-- {child} : {label}")
    return "\n".join(lines)


def build_layers_mermaid(modules: dict[str, dict]) -> str:
    lines = [
        "flowchart TB",
        "  subgraph entry[Entry]",
        "    main",
        "  end",
        "  subgraph routers[HTTP routers]",
    ]
    for m in sorted(modules):
        if m.startswith("routers."):
            lines.append(f"    {m.replace('.', '_')}[\"{m.split('.')[-1]}\"]")
    lines.append("  end")
    lines.append("  subgraph services[Services]")
    for m in ["scheduler", "scanner", "analyzer"]:
        if m in modules:
            lines.append(f"    {m}")
    lines.append("  end")
    lines.append("  subgraph data[Data]")
    if "database" in modules:
        lines.append("    database")
    lines.append("  end")
    lines.append("  entry --> routers")
    lines.append("  entry --> services")
    lines.append("  routers --> services")
    lines.append("  routers --> data")
    lines.append("  services --> data")
    return "\n".join(lines)
