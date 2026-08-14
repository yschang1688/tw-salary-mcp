# Deploying the remote MCP server

> **✅ Deployed 2026-08-14 — <https://salary-mcp-beige.vercel.app/mcp>**
> Verified in production: 18/18 protocol tests, `x-vercel-id: hkg1::sin1` (edge),
> no Deployment Protection (an MCP client can reach it without a Vercel session).
> The steps below are kept as the runbook for redeploying or for a fresh project.


Everything below the "you do this" line is done — build is green, 18/18 tests
pass, the guard test is self-checked. What is left needs a Vercel account, so it
is John's to run.

## You do this (about 5 minutes)

```bash
cd ~/salary-mcp-agent/web
npx vercel login          # browser opens; sign in with the GitHub yschang1688 account
npx vercel link           # scope: personal, project name: salary-mcp
npx vercel --prod
```

No environment variables are needed — the dataset is bundled and there are no
secrets. That is deliberate: nothing this server reads is private, so there is
nothing to leak.

## Then verify (agent can run these)

```bash
BASE=https://<deployment>.vercel.app

# 1. Confirm it is really on the edge — `region` should be a code like hnd1/sin1
curl -s "$BASE/mcp" | head

# 2. Drive the protocol
curl -s -X POST "$BASE/mcp" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

# 3. Run the full suite against production
cd ~/salary-mcp-agent/web && MCP_URL="$BASE/mcp" node --test test/protocol.test.mjs
```

## Then connect a client

Add `https://<deployment>.vercel.app/mcp` as a remote MCP server. The four tools
appear with no install step — that is the whole point of the remote transport.

## What this unlocks on the 聚陽 application

`JD_Match_聚陽_全端工程師.md` has three rows this closes or strengthens:

| JD row | Before | After deploy |
|---|---|---|
| serverless / edge (Vercel/CF Workers/Lambda) | ❌ no deployment | ✅ Edge Runtime, live |
| Next.js (App Router) 實際專案經驗 | ✅ but the repo is private | ✅ **and publicly clickable** |
| AI Agent 或 MCP server/client 開發 (加分) | ✅ clone-to-run | ✅ **live demo, paste the URL** |

Update that匹配表 and re-version the four-piece set **after** the verify steps
above pass — not before.

## Honest boundary (read before writing this into a résumé)

- **Can write:** "deployed a Next.js App Router app to Vercel including an Edge
  Runtime function"; "implemented an MCP server over Streamable HTTP against the
  JSON-RPC 2.0 spec, without the reference SDK, because its transport requires
  Node APIs the edge does not have".
- **Must not write:** "serverless 架構設計" or "edge computing 經驗豐富". This is
  one endpoint's first deployment, not production traffic under load. No custom
  domain, no CDN tuning, no observability, no incident history.
- The server is **stateless and read-only by design**, not because sessions were
  built and later removed. Do not describe the absence of session handling as a
  scaling decision — it is a scope decision.
