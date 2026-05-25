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
    # Anything that isn't main / database / a routers.* / a bare package
    # marker counts as a service. Beats hardcoding service names per repo.
    services = sorted(
        m for m, info in modules.items()
        if m not in {"main", "database"}
        and not m.startswith("routers.")
        and info.get("loc", 0) > 0
    )
    has_routers = any(m.startswith("routers.") for m in modules)

    lines = [
        "flowchart TB",
        "  subgraph entry[Entry]",
        "    main",
        "  end",
    ]
    if has_routers:
        lines.append("  subgraph routers[HTTP routers]")
        for m in sorted(modules):
            if m.startswith("routers."):
                lines.append(f"    {m.replace('.', '_')}[\"{m.split('.')[-1]}\"]")
        lines.append("  end")
    if services:
        lines.append("  subgraph services[Services]")
        for m in services:
            lines.append(f"    {m.replace('.', '_')}[\"{m}\"]")
        lines.append("  end")
    if "database" in modules:
        lines.append("  subgraph data[Data]")
        lines.append("    database")
        lines.append("  end")

    if has_routers:
        lines.append("  entry --> routers")
    if services:
        lines.append("  entry --> services")
        if has_routers:
            lines.append("  routers --> services")
    if "database" in modules:
        if has_routers:
            lines.append("  routers --> data")
        if services:
            lines.append("  services --> data")
    return "\n".join(lines)
