// Protocol and boundary tests for the Edge MCP server.
//
// Run against a live server:  node --test test/protocol.test.mjs
// (start it first: `npm run build && npx next start -p 3466`)
//
// Most of these assert on *bad* input, not good input — the interesting
// property of a read-only tool surface is what it refuses, and what it declines
// to leak while refusing.

import { test } from "node:test";
import assert from "node:assert/strict";

const URL = process.env.MCP_URL ?? "http://localhost:3466/mcp";

async function rpc(method, params, id = 1) {
  const res = await fetch(URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  return { status: res.status, body: res.status === 202 ? null : await res.json() };
}

const callTool = (name, args) => rpc("tools/call", { name, arguments: args });
const textOf = (r) => r.body.result.content[0].text;

test("initialize advertises the protocol version and server identity", async () => {
  const { body } = await rpc("initialize", {});
  assert.equal(body.result.protocolVersion, "2025-06-18");
  assert.equal(body.result.serverInfo.name, "tw-salary-mcp");
});

test("tools/list exposes exactly the seven named read-only tools", async () => {
  const { body } = await rpc("tools/list");
  assert.deepEqual(
    body.result.tools.map((t) => t.name).sort(),
    ["analyze_jd", "company_trend", "industry_stats", "lookup_company",
     "market_demand", "skill_gaps", "top_by_median"],
  );
});

// The guard. The whole design rests on there being no generic query channel,
// so assert that property directly rather than trusting it stays true.
// Self-check: add a tool named `run_query` (or any of the words below) to
// src/lib/tools.ts and this test fails — that is what makes it a real guard
// rather than a tautology.
test("GUARD: no generic query tool is exposed", async () => {
  const banned = /^(run_)?(query|sql|exec|eval|raw|search_all)$/i;
  const { body } = await rpc("tools/list");
  const offenders = body.result.tools.map((t) => t.name).filter((n) => banned.test(n));
  assert.deepEqual(offenders, [], `generic query channel exposed: ${offenders}`);
  // And prove the channel is absent in fact, not just in the listing: calling
  // it must be refused rather than quietly handled.
  const { body: called } = await callTool("run_query", { sql: "SELECT * FROM companies" });
  assert.equal(called.result.isError, true);
});

test("GUARD: every tool schema is closed to extra properties", async () => {
  const { body } = await rpc("tools/list");
  for (const t of body.result.tools) {
    assert.equal(t.inputSchema.additionalProperties, false, `${t.name} accepts extra properties`);
  }
});

test("known company resolves by code", async () => {
  const text = textOf(await callTool("lookup_company", { query: "2330" }));
  assert.match(text, /台積電 \(2330, 上市\)/);
  assert.match(text, /right-skewed/); // median/mean 0.78 must be flagged
});

test("a short name query reports the ambiguity instead of guessing", async () => {
  const text = textOf(await callTool("lookup_company", { query: "電" }));
  assert.match(text, /Narrow the query/);
});

test("path traversal is treated as an ordinary miss, with no path echoed back", async () => {
  const text = textOf(await callTool("lookup_company", { query: "../../etc/passwd" }));
  assert.match(text, /No listed company matches/);
  assert.doesNotMatch(text, /Error|stack|at .*\/|ENOENT/i);
});

test("injection-shaped strings return a short miss, not a dump", async () => {
  const text = textOf(await callTool("lookup_company", { query: "' OR 1=1--" }));
  assert.match(text, /No listed company matches/);
  assert.ok(text.length < 200, "a miss must not return bulk data");
});

test("limit is clamped rather than honoured", async () => {
  const text = textOf(await callTool("top_by_median", { limit: 9999 }));
  const rows = text.split("\n").filter((l) => /^ {2}\d+\./.test(l));
  assert.equal(rows.length, 50);
});

test("a malformed code is rejected as a tool error, not a transport error", async () => {
  const { body } = await callTool("company_trend", { code: "abc" });
  assert.equal(body.result.isError, true);
  assert.match(body.result.content[0].text, /4-6 digit/);
  assert.equal(body.error, undefined);
});

test("wrong argument types are validated server-side", async () => {
  const { body } = await callTool("lookup_company", { query: 123 });
  assert.equal(body.result.isError, true);
  assert.match(body.result.content[0].text, /must be a string/);
});

test("an unknown tool name is refused", async () => {
  const { body } = await callTool("run_query", { sql: "SELECT *" });
  assert.equal(body.result.isError, true);
});

test("unknown methods get JSON-RPC method-not-found", async () => {
  const { body } = await rpc("admin/dump");
  assert.equal(body.error.code, -32601);
});

test("malformed JSON gets a parse error, not a 500", async () => {
  const res = await fetch(URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "not json",
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, -32700);
});

test("notifications are accepted with no response body", async () => {
  const res = await fetch(URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  assert.equal(res.status, 202);
});

test("GET declines the SSE stream and says what to do instead", async () => {
  const res = await fetch(URL);
  assert.equal(res.status, 405);
  assert.match((await res.json()).transport, /POST only/);
});

test("the schema resource is readable and states the null-vs-zero rule", async () => {
  const { body } = await rpc("resources/read", { uri: "salary://schema" });
  assert.match(body.result.contents[0].text, /never as zero/);
});

test("trend reports missing years explicitly rather than as zero", async () => {
  const text = textOf(await callTool("company_trend", { code: "2330" }));
  assert.match(text, /2019: 159\.6/);
  assert.doesNotMatch(text, /: 0 /);
});

test("REGRESSION: industry queries survive rows with null industry", async () => {
  // 1.0.0 threw on every industry_stats call: 8 of 1,826 companies carry
  // industry=null in the MOPS data, and the filter dereferenced it bare.
  // Zero coverage let it reach production — this pins the whole path.
  const { body } = await rpc("tools/call", { name: "industry_stats", arguments: { industry: "半導體" } });
  assert.notEqual(body.result.isError, true, "industry_stats must not throw on the real dataset");
  assert.match(body.result.content[0].text, /Industry '半導體/);
});
