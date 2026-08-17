// Guard tests for the fit tool family, over live HTTP like protocol.test.mjs.
// Every group below carries at least one reverse case — an input that must be
// refused or must change the answer — because the failure modes here are all
// silent: a loose matcher over-covers, a stored profile leaks, a corpus stat
// gets quoted as market truth.
import { test } from "node:test";
import assert from "node:assert/strict";

const URL = process.env.MCP_URL ?? "http://localhost:3466/mcp";
let id = 100;

async function rpc(method, params = {}) {
  const res = await fetch(URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
  });
  return { status: res.status, body: await res.json() };
}
const callTool = (name, args) => rpc("tools/call", { name, arguments: args });
const textOf = ({ body }) => body.result.content[0].text;
const isErr = ({ body }) => body.result.isError === true;

const JD =
  "條件要求：3年以上。負責資料倉儲 ETL 與報表。需求技能：Python、SQL、資料正規化、" +
  "Tableau 儀表板、跨部門溝通與專案管理。加分：機器學習模型部署經驗。";

// ── analyze_jd ────────────────────────────────────────────────────────────
test("analyze_jd finds the groups the JD actually asks for", async () => {
  const text = textOf(await callTool("analyze_jd", { jd: JD }));
  assert.match(text, /Python/i);
  assert.match(text, /SQL/i);
  assert.match(text, /Experience required: 3\+ years/);
});

test("analyze_jd: no stated years is reported as such, not as zero", async () => {
  const text = textOf(await callTool("analyze_jd", { jd: "需求技能：Python 與 SQL，負責資料pipeline維運與監控。" }));
  assert.match(text, /Experience required: not stated/);
  assert.doesNotMatch(text, /0\+ years/);
});

test("analyze_jd: word-boundary rule — 'maintain' must not hit the AI group", async () => {
  // "ai" ⊂ "maintain": substring matching would claim an AI requirement.
  const text = textOf(
    await callTool("analyze_jd", { jd: "We maintain digital appliance firmware and application middleware daily." }),
  );
  assert.doesNotMatch(text, /AI 輔助/);
});

test("analyze_jd rejects a bare title and oversized input", async () => {
  assert.ok(isErr(await callTool("analyze_jd", { jd: "資料工程師" })));
  assert.ok(isErr(await callTool("analyze_jd", { jd: "x".repeat(20001) })));
});

// ── skill_gaps ────────────────────────────────────────────────────────────
test("skill_gaps splits covered from missing, and the split responds to input", async () => {
  const withSql = textOf(await callTool("skill_gaps", { jd: JD, skills: ["python", "sql"] }));
  assert.match(withSql, /✓.*Python/i);
  // Reverse: drop sql from the skills and the SQL group must move to gaps.
  const withoutSql = textOf(await callTool("skill_gaps", { jd: JD, skills: ["python"] }));
  assert.match(withoutSql, /✗.*SQL/i);
  assert.doesNotMatch(withSql, /✗.*SQL \/ 資料正規化/i);
});

test("skill_gaps: unknown skills are declared out-of-dictionary, not silently dropped", async () => {
  const text = textOf(await callTool("skill_gaps", { jd: JD, skills: ["python", "underwater basket weaving"] }));
  assert.match(text, /Not in the dictionary.*underwater basket weaving/);
});

test("skill_gaps refuses an empty or non-array skills argument", async () => {
  assert.ok(isErr(await callTool("skill_gaps", { jd: JD, skills: [] })));
  assert.ok(isErr(await callTool("skill_gaps", { jd: JD, skills: "python" })));
});

// ── market_demand ─────────────────────────────────────────────────────────
test("market_demand ranks by count and carries the corpus caveat", async () => {
  const text = textOf(await callTool("market_demand", {}));
  const counts = [...text.matchAll(/ (\d+) postings/g)].map((m) => Number(m[1]));
  assert.ok(counts.length >= 10, "expected a ranked list");
  for (let i = 1; i < counts.length; i++) assert.ok(counts[i] <= counts[i - 1], "not sorted desc");
  // The stat must not travel without its scope.
  assert.match(text, /Corpus:/);
  assert.match(text, /not the whole job market/);
});

test("market_demand: filter narrows, bad limit is refused", async () => {
  const text = textOf(await callTool("market_demand", { query: "python" }));
  assert.match(text, /Python/);
  assert.ok(isErr(await callTool("market_demand", { limit: 0 })));
  assert.ok(isErr(await callTool("market_demand", { limit: 45 })));
});

// ── privacy guards ────────────────────────────────────────────────────────
test("GUARD: the shipped dictionary file carries no personal fields", async () => {
  // The HTTP-output guard below cannot catch this: tools only print id/hits/pct,
  // so a re-added ev/note/w in the data file would never surface over the wire —
  // but it would still be published in this public repo. Assert on the file.
  const { default: data } = await import("../src/data/fit-demand.json", { with: { type: "json" } });
  for (const g of data.groups) {
    for (const field of ["ev", "note", "w"]) {
      assert.equal(g[field], undefined, `group '${g.id}' ships private field '${field}'`);
    }
  }
  // Structural checks only — deliberately no list of specific private names
  // here, because the pattern list itself would publish the names it guards.
  const raw = JSON.stringify(data);
  assert.doesNotMatch(raw, /\/Users\//, "local filesystem path leaked");
  assert.doesNotMatch(raw, /https?:\/\//, "source URL leaked — the corpus must stay unattributed");
});

test("GUARD: no personal profile surfaces in tool output", async () => {
  // The dictionary must carry match keywords only. If someone re-adds the
  // private fields (ev self-ratings / evidence notes / target-role weights),
  // tool output is where they would surface — assert they never do.
  const outputs = [
    textOf(await callTool("analyze_jd", { jd: JD })),
    textOf(await callTool("market_demand", {})),
  ].join("\n");
  for (const leak of [/"ev"/, /"note"/, /\/Users\//]) {
    assert.doesNotMatch(outputs, leak, `private field leaked: ${leak}`);
  }
});

test("GUARD: skills echo back in the same call only — the server is stateless", async () => {
  const marker = `zz-stateless-probe-${Date.now()}`;
  await callTool("skill_gaps", { jd: JD, skills: ["python", marker] });
  // A later, unrelated call must know nothing about the marker.
  const later = textOf(await callTool("analyze_jd", { jd: JD }));
  assert.doesNotMatch(later, new RegExp(marker));
});
