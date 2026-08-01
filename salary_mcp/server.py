"""MCP server exposing the MOPS salary dataset over stdio.

Security posture — the reason this server is shaped the way it is:

* **Read-only by construction.** There is no write, delete, or exec tool. The
  server never opens a file outside `data/`, and `dataset.py` is the only
  module that touches the filesystem at all.
* **No arbitrary-query passthrough.** There is deliberately no `run_query` or
  `eval` tool. Every question the model can ask is a named tool with a typed
  signature, so the reachable query space is the four functions below and
  nothing else. This is the single most important decision here: a generic
  query tool would hand an LLM — and anything that can prompt-inject it — the
  full expressive power of the query language.
* **Arguments are validated before use.** Stock codes must match `^\\d{4,6}$`,
  free-text is length-capped, and `limit` is clamped server-side, so a caller
  cannot use an argument to reach the filesystem or exhaust memory.
* **Errors are converted, not leaked.** `InvalidArgument` becomes a short
  message for the caller; nothing returns a traceback or a filesystem path.

The data is public: TWSE and TPEx open-data disclosures of non-managerial
full-time salaries. There is no personal data here — every figure is already
a company-level aggregate.
"""

from __future__ import annotations

from mcp.server.fastmcp import FastMCP

from . import dataset
from .dataset import InvalidArgument

mcp = FastMCP("salary-db")

_UNIT_NOTE = "Figures are NT$10k (萬元) per year, non-managerial full-time employees."


def _fmt_company(c: dataset.Company) -> str:
    parts = [
        f"{c.name} ({c.code}, {c.market})",
        f"industry: {c.industry}",
        f"median: {c.median_non_mgr} 萬/yr",
        f"mean: {c.avg_non_mgr} 萬/yr",
        f"overall rank: {c.rank}",
    ]
    if c.employees is not None:
        parts.append(f"employees: {c.employees}")
    ratio = c.median_over_avg
    if ratio is not None:
        skew = " (right-skewed — quote the median)" if ratio < 0.85 else ""
        parts.append(f"median/mean: {ratio}{skew}")
    return " | ".join(parts)


@mcp.tool()
def lookup_company(query: str) -> str:
    """Look up one company's salary disclosure by stock code or name.

    Args:
        query: A 4-6 digit TWSE/TPEx stock code (e.g. "2330"), or part of a
            company name (e.g. "台積"). Names are matched as a substring, so a
            short query can return several companies.
    """
    try:
        hits = dataset.find_companies(query)
    except InvalidArgument as exc:
        return f"Invalid request: {exc}"

    if not hits:
        return f"No listed company matches '{query}'. It may be private or below the disclosure threshold."
    if len(hits) > 10:
        names = ", ".join(f"{c.name}({c.code})" for c in hits[:10])
        return f"{len(hits)} companies match '{query}'. Narrow the query, or pick a code. First 10: {names}"

    body = "\n".join(_fmt_company(c) for c in hits)
    return f"{body}\n\n{_UNIT_NOTE}"


@mcp.tool()
def industry_stats(industry: str) -> str:
    """Summarise the pay distribution within one industry.

    Use this to judge whether a single company's pay is high or low *for its
    sector* — an absolute figure means little without the sector baseline.

    Args:
        industry: Industry name or part of one, e.g. "半導體", "航運業",
            "電子通路".
    """
    try:
        stats = dataset.industry_stats(industry)
    except InvalidArgument as exc:
        return f"Invalid request: {exc}"

    if not stats["company_count"]:
        return f"No industry matches '{industry}'."

    top = stats["companies"][:5]
    lines = [
        f"Industry '{stats['industry']}' ({stats['year']}): {stats['company_count']} companies",
        f"median of medians: {stats['median_of_medians']} 萬/yr",
        f"p25: {stats['p25']} | p75: {stats['p75']} | range: {stats['min']}-{stats['max']}",
        "",
        "Highest-paying in this industry:",
        *(f"  {i}. {_fmt_company(c)}" for i, c in enumerate(top, 1)),
        "",
        _UNIT_NOTE,
    ]
    return "\n".join(lines)


@mcp.tool()
def top_by_median(
    industry: str = "", min_median: float = 0.0, limit: int = 10
) -> str:
    """Rank companies by non-managerial median pay, highest first.

    Args:
        industry: Optional industry filter (substring). Empty means all industries.
        min_median: Optional floor in 萬元/yr, e.g. 120 keeps only companies
            paying a median of NT$1.2M or more.
        limit: How many to return (1-50; values above 50 are clamped to 50).
    """
    try:
        hits = dataset.top_by_median(
            industry=industry or None,
            min_median=min_median or None,
            limit=limit,
        )
    except InvalidArgument as exc:
        return f"Invalid request: {exc}"

    if not hits:
        return "No company matches those filters."

    scope = f"industry '{industry}'" if industry else "all industries"
    floor = f", median >= {min_median} 萬" if min_median else ""
    lines = [
        f"Top {len(hits)} by median pay ({scope}{floor}):",
        *(f"  {i}. {_fmt_company(c)}" for i, c in enumerate(hits, 1)),
        "",
        _UNIT_NOTE,
    ]
    return "\n".join(lines)


@mcp.tool()
def company_trend(code: str) -> str:
    """Show one company's median pay for every year on record (2019-2025).

    Args:
        code: A 4-6 digit TWSE/TPEx stock code, e.g. "2330".
    """
    try:
        trend = dataset.company_trend(code)
    except InvalidArgument as exc:
        return f"Invalid request: {exc}"

    series = " -> ".join(
        f"{y}: {v if v is not None else 'n/a'}" for y, v in trend["series"].items()
    )
    lines = [
        f"{trend['name']} ({trend['code']}) median pay by year:",
        f"  {series}",
        f"  {trend['first_year']}->{trend['last_year']}: {trend['change_pct']:+}%"
        if trend["change_pct"] is not None
        else "  change: n/a",
    ]
    if trend["missing_years"]:
        years = ", ".join(str(y) for y in trend["missing_years"])
        lines.append(
            f"  Not disclosed in: {years} (below the disclosure threshold, or not yet listed)"
        )
    lines += ["", _UNIT_NOTE]
    return "\n".join(lines)


@mcp.resource("salary://schema")
def schema() -> str:
    """What this dataset contains, where it came from, and how to read it."""
    return (
        "MOPS non-managerial full-time salary disclosures for TWSE/TPEx listed "
        "companies, 2019-2025.\n"
        "Source: TWSE and TPEx open-data endpoints (t187ap46). Public, company-level "
        "aggregates only — no personal data.\n\n"
        "Fields: code, name, market (上市/上櫃), industry, rank (overall by median), "
        "median_non_mgr, avg_non_mgr, employees.\n"
        "Units: 萬元 (NT$10,000) per year.\n\n"
        "Reading guidance: median/mean below ~0.85 means the distribution is "
        "right-skewed and the mean is pulled up by a few high earners — quote the "
        "median. A company absent in a given year was below the disclosure "
        "threshold or not yet listed; it is reported as null, never as zero."
    )


def main() -> None:
    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
