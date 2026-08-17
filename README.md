# tw-salary-mcp

[![tests](https://github.com/yschang1688/tw-salary-mcp/actions/workflows/tests.yml/badge.svg)](https://github.com/yschang1688/tw-salary-mcp/actions/workflows/tests.yml)

Grounding data for the Taiwanese job market, served to language models under
explicit constraints — plus a Claude Agent SDK agent that researches through it.

A chatbot asked about Taiwanese pay will answer fluently from stale, non-local
training data, and will happily average numbers that must not be averaged. This
server exists to be plugged **into** that chatbot: named read-only tools over
data it does not have, every answer ending with a source-and-vintage stamp.

The dataset is Taiwan's MOPS non-managerial salary disclosures for listed
companies, 2019–2025 — public company-level aggregates from the TWSE and TPEx
open-data endpoints. The same dataset powers a live explorer at
**[salary-db.pages.dev](https://salary-db.pages.dev)** (1,826 companies,
seven-year trends, industry box plots — a single self-contained page).

| | |
|---|---|
| **MCP server (stdio)** | `salary_mcp/` — four read-only tools + a schema resource, Python |
| **MCP server (remote)** | **[salary-mcp-beige.vercel.app/mcp](https://salary-mcp-beige.vercel.app/mcp)** — the same surface over Streamable HTTP, live on the edge |
| **Agent** | `agent/researcher.py` — Claude Agent SDK, multi-step planning over those tools |
| **Tests** | 63 passing — 29 Python, 34 driving the remote server over the real protocol |

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

Two families, at **different evidence tiers** — the stamps keep them apart:

| Tier | Tool | Answers |
|---|---|---|
| census | `lookup_company(query)` | One company by stock code or name substring |
| census | `industry_stats(industry)` | Median, p25/p75, and range across a sector |
| census | `top_by_median(industry, min_median, limit)` | Ranked list under filters |
| census | `company_trend(code)` | One company's median for each year on record |
| corpus | `analyze_jd(jd)` | Which skill groups a job description asks for, with corpus demand share |
| corpus | `skill_gaps(jd, skills)` | Covered vs gap groups for the caller's own skills (nothing stored) |
| corpus | `market_demand(query, limit)` | Skill-group demand ranking + years-of-experience distribution |

**census tier** = MOPS statutory disclosures: every listed company, statutory
filing, no self-selection. **corpus tier** = deterministic analysis over a
versioned 32-group skill dictionary, with demand aggregates from a private,
dated corpus of 1,086 Taiwanese data/AI postings (counts only — no posting
text, no company names, no attribution by design). The corpus tier never
borrows the census tier's authority; a test asserts each family carries its
own stamp and not the other's.

Plus a `salary://schema` resource describing the fields, units, and the two
reading rules that matter (below).

## Side by side: the same question, bare vs grounded

> **Q: 台積電和聯發科哪家分紅比較好？我五年經驗大概可以拿多少？**

| Bare chatbot | Same chatbot + this server |
|---|---|
| A fluent paragraph quoting round numbers from training data of unknown age, comparing "bonus" figures that mix 分紅, 年終, and total pay — no way to tell which year, which population, or whether the numbers are real. | `lookup_company` returns each company's statutory median with `— Source: MOPS statutory disclosures (TWSE/TPEx), 2019-2025 vintage. Census-grade.` The model can compare like with like, say which year it is quoting — and decline the parts of the question the data cannot answer (individual bonus structure is not in a company-level census, and the server says so instead of improvising). |

The difference is not eloquence. It is that one answer can be checked and the
other cannot. Three properties do the work:

1. **Determinism** — same JD, same answer. A versioned dictionary with
   word-boundary matching (`ai` never matches *maintain*), not a generation.
2. **Refusal** — populations that must not be mixed stay unmixed. Validation
   errors come back as tool errors the model can read, not as improvised numbers.
3. **Stamps** — every answer ends with its source and vintage. A stale dataset
   degrades into a labelled snapshot, never a silently wrong answer. This is
   asserted per tool, including empty-result answers.

## What the matcher is, measured

The corpus-tier matcher was scored against an 85-posting golden set,
human-adjudicated hit-by-hit in the upstream (private) pipeline. Labels
restricted to the 32 public groups:

> **precision 0.54 · recall 0.89 · F1 0.67**

Read the shape, not just the number: this is a deliberately **recall-first
screening layer** — it would rather flag a group for you to reject than miss
one. It is not a verdict layer, and no claim is made that it "beats" any model
at reading a JD. What it has that a model does not: the same answer twice,
a version number, and a measured error profile.

**Snapshot semantics.** The corpus is a dated snapshot (window and size are in
every stamp). There is no freshness promise and no SLA; regeneration is a
documented runbook on the private side, and when it runs, the stamps change.

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
salary_mcp/server.py    MCP tools and the schema resource (stdio)
agent/researcher.py     Agent SDK options, permission gate, tool audit
tests/                  16 protocol tests, 13 agent-guardrail tests
web/src/lib/            the same query layer and tool surface, in TypeScript
web/src/app/mcp/        JSON-RPC 2.0 endpoint — Streamable HTTP on the edge
web/test/               18 protocol and boundary tests against a live server
```

## Remote MCP server (`web/`) — live

```
https://salary-mcp-beige.vercel.app/mcp
```

The stdio server has to be cloned and run before anyone can use it. `web/` is the
same tool surface as a **remote MCP server**: add that URL to any MCP client and
the four tools are there, no install, no key.

```bash
curl -s -X POST https://salary-mcp-beige.vercel.app/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call",
       "params":{"name":"lookup_company","arguments":{"query":"2330"}}}'
```


```bash
cd web && npm install && npm run build
npx next start -p 3466            # then: node --test test/protocol.test.mjs
```

The suite also runs against the deployment — the same 18 tests, no local server:

```bash
MCP_URL=https://salary-mcp-beige.vercel.app/mcp node --test test/protocol.test.mjs
```

It runs on the **Vercel Edge Runtime** (a V8 isolate, not Node), which drove two
design choices worth naming:

- **The JSON-RPC layer is hand-rolled.** `@modelcontextprotocol/sdk`'s
  `StreamableHTTPServerTransport` is built on Node's `http` request and response
  objects, which do not exist in an isolate. Streamable HTTP is JSON-RPC 2.0 over
  POST, so the surface a stateless read-only server needs is small enough to write
  directly against the Web-standard `Request`/`Response` — which is what makes it
  deployable to the edge at all.
- **It is stateless: no sessions, no SSE stream.** `GET` returns 405 with a
  pointer to POST. The spec permits a server to decline the server-initiated
  stream, and for pure reads there is nothing to push.

The dataset is trimmed at build time to the fields the tools actually use
(393 KB for seven years), so it is bundled rather than fetched — an edge function
has a 1 MB code-size limit on the free tier.

Errors are split deliberately: a bad *argument* comes back as a tool error
(`isError`) so the model can read the message and retry, while a bad *request*
comes back as a JSON-RPC error. Neither path returns a stack trace or a path.

**The guard test is self-checking.** `GUARD: no generic query tool is exposed`
asserts the property the whole design rests on. Planting a tool named `query` in
`web/src/lib/tools.ts` turns three tests red; removing it returns 18/18 — verified,
not assumed.

Deployment check (2026-08-14): 18/18 against production, and
`x-vercel-id: hkg1::sin1` confirms it is served from the edge network rather than
a single origin — the claim is measured, not inferred from the config.

## Licence

MIT.
