"""End-to-end tests: a real MCP client speaking stdio to a real server subprocess.

These exercise the actual protocol — handshake, tool discovery, tool calls,
resource reads — not the Python functions directly. No API key and no model
are involved, so this suite is the layer that proves the server works.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

REPO_ROOT = Path(__file__).resolve().parent.parent

SERVER = StdioServerParameters(
    command=sys.executable,
    args=["-m", "salary_mcp.server"],
    cwd=str(REPO_ROOT),
)

pytestmark = pytest.mark.anyio


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def call(tool: str, args: dict) -> str:
    """Spin up the server, call one tool, return its text. Fails loudly on
    protocol errors so a broken handshake can't look like an empty result."""
    async with stdio_client(SERVER) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            result = await session.call_tool(tool, args)
            assert result.content, f"{tool} returned no content"
            return "\n".join(
                block.text for block in result.content if block.type == "text"
            )


async def test_handshake_and_tool_discovery():
    async with stdio_client(SERVER) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            tools = {t.name for t in (await session.list_tools()).tools}

    assert tools == {
        "lookup_company",
        "industry_stats",
        "top_by_median",
        "company_trend",
    }


async def test_no_mutating_tool_is_exposed():
    """The server must not offer a write, delete, exec, or free-form query
    surface. This is an assertion about the security posture, not a nicety:
    if someone later adds a `run_query` tool, this test should fail."""
    async with stdio_client(SERVER) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            tools = [t.name.lower() for t in (await session.list_tools()).tools]

    forbidden = ("write", "delete", "update", "insert", "exec", "eval", "query", "sql")
    offending = [t for t in tools if any(word in t for word in forbidden)]
    assert not offending, f"mutating or free-form tools exposed: {offending}"


async def test_lookup_by_code():
    text = await call("lookup_company", {"query": "5434"})
    assert "崇越" in text
    assert "171.9" in text
    assert "電子通路業" in text


async def test_lookup_by_name_substring():
    text = await call("lookup_company", {"query": "台積"})
    assert "台積電" in text
    assert "2330" in text


async def test_lookup_miss_is_a_message_not_an_error():
    text = await call("lookup_company", {"query": "沒有這家公司"})
    assert "No listed company matches" in text


async def test_industry_stats_reports_distribution():
    text = await call("industry_stats", {"industry": "航運"})
    assert "33 companies" in text
    assert "p25" in text and "p75" in text


async def test_top_by_median_respects_filters():
    text = await call(
        "top_by_median", {"industry": "電子通路", "min_median": 120, "limit": 3}
    )
    assert "崇越" in text
    # 3 requested, so exactly 3 numbered lines
    assert text.count("\n  1.") == 1 and "  3." in text and "  4." not in text


async def test_limit_is_clamped_server_side():
    """A caller asking for 9999 rows gets 50, not 9999 — the clamp is enforced
    in the server, not trusted to the caller."""
    text = await call("top_by_median", {"limit": 9999})
    assert "Top 50 by median pay" in text


async def test_trend_reports_gaps_as_gaps():
    """台灣虎航 listed part-way through the window. The missing years must be
    reported as not-disclosed, never silently rendered as zero."""
    text = await call("company_trend", {"code": "6757"})
    assert "n/a" in text
    assert "Not disclosed in" in text
    assert "0.0" not in text.split("Not disclosed")[0]


async def test_trend_change_is_computed_over_known_years():
    text = await call("company_trend", {"code": "5434"})
    assert "崇越" in text
    assert "+59.9%" in text


@pytest.mark.parametrize(
    "bad_code",
    ["../../etc/passwd", "abc", "12", "5434; DROP TABLE companies", ""],
)
async def test_invalid_codes_are_rejected(bad_code: str):
    """Path traversal, injection-shaped strings, and malformed codes must all
    come back as a validation message — never a traceback, never a file read."""
    text = await call("company_trend", {"code": bad_code})
    assert text.startswith("Invalid request:")
    assert "Traceback" not in text
    assert "/Users/" not in text  # no filesystem paths leak to the caller


async def test_schema_resource_is_readable():
    async with stdio_client(SERVER) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            result = await session.read_resource("salary://schema")
            text = "\n".join(c.text for c in result.contents if hasattr(c, "text"))

    assert "萬元" in text
    assert "no personal data" in text.lower()
