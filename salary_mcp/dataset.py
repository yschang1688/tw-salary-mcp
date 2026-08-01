"""Loading and querying the MOPS non-managerial salary disclosures.

The dataset ships as one JSON file per year. Files are read once and cached;
nothing here mutates them, and no code path outside this module opens the data
directory.
"""

from __future__ import annotations

import json
import re
import statistics
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent.parent / "data"

# Years present as data/salary-<year>.json.
YEARS = tuple(range(2019, 2026))
LATEST_YEAR = YEARS[-1]

# TWSE/TPEx stock codes are 4-6 digits. Anything else is rejected before it
# reaches a lookup, so a caller cannot probe the filesystem through `code`.
_CODE_RE = re.compile(r"^\d{4,6}$")

MAX_QUERY_LEN = 40
MAX_LIMIT = 50


class InvalidArgument(ValueError):
    """Raised when an argument fails validation. Carries a caller-safe message."""


@dataclass(frozen=True)
class Company:
    code: str
    name: str
    market: str
    industry: str
    rank: int
    median_non_mgr: float  # 萬元/year (NT$10k), non-managerial employees
    avg_non_mgr: float
    employees: int | None

    @property
    def median_over_avg(self) -> float | None:
        """Median / mean. Below ~0.85 means a right-skewed distribution: the
        mean is being pulled up by a few high earners, so quote the median."""
        if not self.avg_non_mgr:
            return None
        return round(self.median_non_mgr / self.avg_non_mgr, 3)


def _parse(raw: dict) -> Company:
    # market/industry are null for a handful of rows in the upstream feed, so
    # coerce rather than defaulting — `.get(k, "")` returns None when the key
    # exists with a null value, which then breaks substring matching.
    return Company(
        code=str(raw["code"]),
        name=raw["name"],
        market=raw.get("market") or "",
        industry=raw.get("industry") or "",
        rank=raw.get("rank", 0),
        median_non_mgr=raw.get("medianNonMgr", 0.0),
        avg_non_mgr=raw.get("avgNonMgr", 0.0),
        employees=raw.get("employees"),
    )


@lru_cache(maxsize=len(YEARS))
def load_year(year: int) -> tuple[Company, ...]:
    if year not in YEARS:
        raise InvalidArgument(f"year must be one of {YEARS[0]}-{YEARS[-1]}, got {year}")
    path = DATA_DIR / f"salary-{year}.json"
    if not path.is_file():
        raise InvalidArgument(f"no dataset for year {year}")
    payload = json.loads(path.read_text(encoding="utf-8"))
    return tuple(_parse(c) for c in payload["companies"])


@lru_cache(maxsize=len(YEARS))
def _by_code(year: int) -> dict[str, Company]:
    return {c.code: c for c in load_year(year)}


def validate_query(query: str) -> str:
    query = (query or "").strip()
    if not query:
        raise InvalidArgument("query must not be empty")
    if len(query) > MAX_QUERY_LEN:
        raise InvalidArgument(f"query must be at most {MAX_QUERY_LEN} characters")
    return query


def validate_code(code: str) -> str:
    code = (code or "").strip()
    if not _CODE_RE.match(code):
        raise InvalidArgument("code must be a 4-6 digit TWSE/TPEx stock code")
    return code


def validate_limit(limit: int) -> int:
    if not isinstance(limit, int) or isinstance(limit, bool):
        raise InvalidArgument("limit must be an integer")
    if limit < 1:
        raise InvalidArgument("limit must be at least 1")
    return min(limit, MAX_LIMIT)


def find_companies(query: str, year: int = LATEST_YEAR) -> list[Company]:
    """Look a company up by stock code (exact) or by name (substring).

    A bare 4-6 digit query is treated as a code first; if no company has that
    code it falls through to a name match, because some company names are
    numeric-looking.
    """
    query = validate_query(query)
    companies = load_year(year)

    if _CODE_RE.match(query):
        hit = _by_code(year).get(query)
        if hit:
            return [hit]

    lowered = query.lower()
    return [c for c in companies if lowered in c.name.lower()]


def industry_stats(industry: str, year: int = LATEST_YEAR) -> dict:
    """Distribution of non-managerial median pay within one industry.

    `industry` is matched as a substring, so "航運" matches "航運業".
    """
    industry = validate_query(industry)
    lowered = industry.lower()
    members = [c for c in load_year(year) if lowered in c.industry.lower()]
    if not members:
        return {"industry": industry, "year": year, "company_count": 0, "companies": []}

    medians = sorted(c.median_non_mgr for c in members)
    return {
        "industry": industry,
        "year": year,
        "company_count": len(members),
        "median_of_medians": round(statistics.median(medians), 1),
        "p25": round(medians[len(medians) // 4], 1),
        "p75": round(medians[(len(medians) * 3) // 4], 1),
        "min": medians[0],
        "max": medians[-1],
        "companies": sorted(members, key=lambda c: -c.median_non_mgr),
    }


def top_by_median(
    industry: str | None = None,
    min_median: float | None = None,
    limit: int = 10,
    year: int = LATEST_YEAR,
) -> list[Company]:
    limit = validate_limit(limit)
    members = list(load_year(year))
    if industry:
        lowered = validate_query(industry).lower()
        members = [c for c in members if lowered in c.industry.lower()]
    if min_median is not None:
        if not isinstance(min_median, (int, float)) or isinstance(min_median, bool):
            raise InvalidArgument("min_median must be a number")
        members = [c for c in members if c.median_non_mgr >= min_median]
    members.sort(key=lambda c: -c.median_non_mgr)
    return members[:limit]


def company_trend(code: str) -> dict:
    """Per-year median for one company across every year in the dataset.

    Years where the company did not appear are reported as null rather than
    dropped — a gap is a real signal (it usually means the company fell below
    the disclosure threshold, or was still private).
    """
    code = validate_code(code)
    series: dict[int, float | None] = {}
    name = None
    for year in YEARS:
        hit = _by_code(year).get(code)
        series[year] = hit.median_non_mgr if hit else None
        if hit and name is None:
            name = hit.name

    if name is None:
        raise InvalidArgument(f"no company with code {code} in any year")

    known = [(y, v) for y, v in series.items() if v is not None]
    first_year, first_val = known[0]
    last_year, last_val = known[-1]
    change_pct = (
        round((last_val - first_val) / first_val * 100, 1) if first_val else None
    )
    return {
        "code": code,
        "name": name,
        "series": series,
        "first_year": first_year,
        "last_year": last_year,
        "change_pct": change_pct,
        "missing_years": [y for y, v in series.items() if v is None],
    }
