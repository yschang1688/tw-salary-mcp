# salary-mcp-agent

[![tests](https://github.com/yschang1688/salary-mcp-agent/actions/workflows/tests.yml/badge.svg)](https://github.com/yschang1688/salary-mcp-agent/actions/workflows/tests.yml)

An MCP server that exposes a real dataset to a language model under explicit
constraints, and a Claude Agent SDK agent that researches through it.

The dataset is Taiwan's MOPS non-managerial salary disclosures for listed
companies, 2019–2025 — public company-level aggregates from the TWSE and TPEx
open-data endpoints.

| | |
|---|---|
| **MCP server** | `salary_mcp/` — four read-only tools + a schema resource, stdio transport |
| **Agent** | `agent/researcher.py` — Claude Agent SDK, multi-step planning over those tools |
| **Tests** | 29 passing, including 16 that drive the server over the real protocol |

## In brief

A model that can query a database is easy. A model that can query a database
*and cannot do anything else* takes some design. This repo is mostly about the
second problem: what the tool surface should look like when the caller is a
language model, and how to prove the constraints hold.

## Quick start

```bash
uv venv && uv pip install -e ".[dev]"
.venv/bin/python -m pytest          # 29 passed
```

Run the server on its own (it speaks MCP over stdio, so it waits for a client):

```bash
.venv/bin/python -m salary_mcp.server
```

Run the agent (needs `ANTHROPIC_API_KEY`):

```bash
.venv/bin/python -m agent.researcher "崇越科技 (5434) 的薪資水準在同業裡算好嗎？"
```

## The tool surface

| Tool | Answers |
|---|---|
| `lookup_company(query)` | One company by stock code or name substring |
| `industry_stats(industry)` | Median, p25/p75, and range across a sector |
| `top_by_median(industry, min_median, limit)` | Ranked list under filters |
| `company_trend(code)` | One company's median for each year on record |

Plus a `salary://schema` resource describing the fields, units, and the two
reading rules that matter (below).

## Design decisions

**No free-form query tool.** There is deliberately no `run_query`, no SQL
passthrough, no `eval`. Every question the model can ask is a named tool with a
typed signature, so the reachable query space is those four functions and
nothing else. A generic query tool would hand the model — and anything that
can prompt-inject it — the full expressive power of the query language. This
is the decision the rest of the design follows from.

**Read-only by construction.** No write, delete, or exec tool exists. Only
`dataset.py` touches the filesystem, and only inside `data/`.

**Arguments are validated before use, and clamped server-side.** Stock codes
must match `^\d{4,6}$`; free text is length-capped; `limit` is clamped to 50 in
the server rather than trusted to the caller. Path traversal and
injection-shaped strings come back as a short validation message — never a
traceback, never a filesystem path.

**Two independent gates.** The agent checks each call against an allow-list
before it runs, and the server validates arguments again on arrival. A mistake
in either one alone is not sufficient to reach the data.

**Explicit ceilings.** `max_turns` and `max_budget_usd` are set rather than
left to default. An agent that chooses its own next step needs a limit that
does not depend on it choosing to stop.

**Every tool call is audited.** `ToolAudit` records what the agent reached for,
allowed and denied. A transcript shows what an agent *said*; only the audit
shows what it *tried*.

## Two rules the data forces on the answer

These are in the system prompt because getting them wrong produces confident,
wrong numbers:

- **Quote the median, not the mean.** When median/mean falls below about 0.85
  the distribution is right-skewed — the mean is being pulled up by a few high
  earners. The server reports the ratio and flags it.
- **A missing year is missing, not zero.** A company absent from a year was
  below the disclosure threshold or not yet listed. `company_trend` returns
  null for those years and names them; rendering them as zero would invent a
  pay cut that never happened. 台灣虎航 (6757) is the worked example — listed
  part-way through the window, and there is a test asserting its gap years
  never render as `0.0`.

## Verification status

Being precise about what is and isn't covered:

| | Status |
|---|---|
| MCP protocol — handshake, tool discovery, tool calls, resource reads | ✅ 16 tests against a real server subprocess over stdio |
| Argument validation, clamping, traversal and injection rejection | ✅ Covered, including the paths that must fail |
| Security posture (no mutating or free-form tool is exposed) | ✅ Asserted, and the assertion is self-validated (below) |
| Agent permission gate, allow-list, audit, ceilings | ✅ Unit-tested, both outcomes |
| Agent allow-list matches the tools the server actually serves | ✅ Verified by launching the real server from the agent's own config |
| **The agent loop itself — SDK driving a model through the tools** | ❌ **Not covered.** Requires API credentials, which are not present in the environment this was built in. The code follows the documented SDK API and constructs against the real SDK types, but no live multi-turn run has been executed. |

**The posture assertions are self-validated.** Guard tests that only ever pass
are the ones you should trust least, so the check was verified against a
known-bad input: injecting a `run_query` tool into the server makes three tests
fail (`test_no_mutating_tool_is_exposed`, `test_handshake_and_tool_discovery`,
`test_every_allow_listed_tool_exists_on_the_real_server`). Removing it returns
them to green. The first attempt at that probe appended the tool *after*
`mcp.run()`, where it never executed — so the tests passed and briefly looked
broken. Worth stating because the failure mode is general: a guard test
verified with a probe that isn't actually bad tells you nothing.

## Data

`data/salary-{2019..2025}.json` — snapshots of the TWSE and TPEx `t187ap46`
open-data endpoints. Public, company-level aggregates; no personal data.
Figures are 萬元 (NT$10,000) per year.

Two upstream quirks the loader handles: six 2025 rows carry a null `industry`,
and companies enter and leave the dataset as they cross the disclosure
threshold.

## Layout

```
salary_mcp/dataset.py   loading, validation, queries — the only filesystem access
salary_mcp/server.py    MCP tools and the schema resource
agent/researcher.py     Agent SDK options, permission gate, tool audit
tests/                  16 protocol tests, 13 agent-guardrail tests
```

## Licence

MIT.
