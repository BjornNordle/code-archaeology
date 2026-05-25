"""
Mermaid diagram builders for the per-commit architecture snapshot.

The full HTML page is rendered client-side from the snapshot JSON; these
helpers produce the static Mermaid source for class diagrams and the
layered architecture overview.
"""
from __future__ import annotations


def _find(modules: dict[str, dict], leaf: str) -> str | None:
    """Find the module whose final dotted component equals `leaf` (or just
    equals `leaf`). Lets scans without sub_path (modules like 'app.database')
    still resolve to the right file."""
    if leaf in modules:
        return leaf
    for m in modules:
        if m.split(".")[-1] == leaf:
            return m
    return None


def _is_router(name: str) -> bool:
    return name.startswith("routers.") or ".routers." in name


def _common_prefix(modules: dict[str, dict]) -> str:
    """Longest shared dotted prefix across all module names, e.g. 'app.'.
    Returned with the trailing dot so it can be stripped directly."""
    names = list(modules)
    if len(names) < 2:
        return ""
    first = names[0].split(".")
    common = ""
    for i in range(1, len(first) + 1):
        cand = ".".join(first[:i]) + "."
        if all(n.startswith(cand) for n in names):
            common = cand
        else:
            break
    return common


def build_orm_mermaid(modules: dict[str, dict]) -> str:
    db_name = _find(modules, "database")
    db = modules.get(db_name) if db_name else None
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
    prefix = _common_prefix(modules)
    main_name = _find(modules, "main")
    db_name = _find(modules, "database")
    routers = sorted(m for m in modules if _is_router(m))

    # Services: everything that isn't main / database / routers.*, and has code.
    services = sorted(
        m for m, info in modules.items()
        if m != main_name and m != db_name
        and not _is_router(m)
        and info.get("loc", 0) > 0
    )

    def label(m: str) -> str:
        # Drop the common prefix so diagrams aren't choked with 'app.app.foo'.
        return m[len(prefix):] if prefix and m.startswith(prefix) else m

    def node_id(m: str) -> str:
        return m.replace(".", "_")

    lines = ["flowchart TB"]
    if main_name:
        lines += [
            "  subgraph entry[Entry]",
            f'    {node_id(main_name)}["{label(main_name)}"]',
            "  end",
        ]
    if routers:
        lines.append("  subgraph routers[HTTP routers]")
        for m in routers:
            leaf = m.split(".")[-1]
            lines.append(f'    {node_id(m)}["{leaf}"]')
        lines.append("  end")
    if services:
        lines.append("  subgraph services[Services]")
        for m in services:
            lines.append(f'    {node_id(m)}["{label(m)}"]')
        lines.append("  end")
    if db_name:
        lines += [
            "  subgraph data[Data]",
            f'    {node_id(db_name)}["{label(db_name)}"]',
            "  end",
        ]

    if main_name and routers:
        lines.append("  entry --> routers")
    if main_name and services:
        lines.append("  entry --> services")
    if routers and services:
        lines.append("  routers --> services")
    if db_name and routers:
        lines.append("  routers --> data")
    if db_name and services:
        lines.append("  services --> data")
    return "\n".join(lines)
