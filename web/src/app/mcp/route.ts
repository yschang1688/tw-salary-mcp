// Remote MCP server over Streamable HTTP, running on the Vercel Edge Runtime.
//
// Why this is hand-rolled rather than @modelcontextprotocol/sdk:
// the SDK's StreamableHTTPServerTransport is built on Node's `http` request and
// response objects, which do not exist in a V8 isolate. Streamable HTTP is
// JSON-RPC 2.0 over POST, so the protocol surface a stateless read-only server
// needs is small enough to implement directly against Web-standard Request and
// Response — which is what makes it deployable to the edge at all.
//
// Stateless by construction: no sessions, no SSE upgrade, no server-initiated
// messages. Every request carries everything needed to answer it. That is a
// legitimate Streamable HTTP profile (the spec allows a server to decline the
// SSE stream), and it is the right one here because the tools are pure reads.

import { NextRequest, NextResponse } from "next/server";
import { TOOLS, RESOURCES } from "@/lib/tools";
import { InvalidArgument, DATASET_YEAR } from "@/lib/dataset";

export const runtime = "edge";

const PROTOCOL_VERSION = "2025-06-18";
const SERVER_INFO = { name: "salary-db", version: "1.0.0" };

// JSON-RPC 2.0 error codes (spec §5.1)
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INTERNAL_ERROR = -32603;

type Id = string | number | null;

function ok(id: Id, result: unknown) {
  return { jsonrpc: "2.0" as const, id, result };
}

function err(id: Id, code: number, message: string) {
  return { jsonrpc: "2.0" as const, id, error: { code, message } };
}

/**
 * A tool that throws is reported as a *tool* error (isError on the result),
 * not a JSON-RPC error — the model should see the validation message and try
 * again, not receive a transport-level failure it cannot act on.
 */
function callTool(name: string, args: Record<string, unknown>) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) {
    return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  }
  try {
    return { content: [{ type: "text", text: tool.run(args ?? {}) }] };
  } catch (e) {
    // Validation messages are safe to surface. Anything else is reported
    // generically: no stack traces, no file paths, no internals.
    const msg =
      e instanceof InvalidArgument ? `Invalid request: ${e.message}` : "Tool execution failed.";
    return { content: [{ type: "text", text: msg }], isError: true };
  }
}

function handle(msg: Record<string, unknown>) {
  const id = (msg.id ?? null) as Id;

  if (msg.jsonrpc !== "2.0") return err(id, INVALID_REQUEST, "jsonrpc must be '2.0'");
  const method = msg.method;
  if (typeof method !== "string") return err(id, INVALID_REQUEST, "method must be a string");

  const params = (msg.params ?? {}) as Record<string, unknown>;

  switch (method) {
    case "initialize":
      return ok(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {}, resources: {} },
        serverInfo: SERVER_INFO,
        instructions:
          `Salary disclosures for ${1826} TWSE/TPEx listed companies (2019-${DATASET_YEAR}), ` +
          "sourced from MOPS. Company-level aggregates only. Read salary://schema before " +
          "interpreting figures — the median/mean ratio matters.",
      });

    case "tools/list":
      return ok(id, {
        tools: TOOLS.map(({ name, description, inputSchema }) => ({
          name,
          description,
          inputSchema,
        })),
      });

    case "tools/call": {
      const name = params.name;
      if (typeof name !== "string") return err(id, INVALID_REQUEST, "params.name must be a string");
      return ok(id, callTool(name, (params.arguments ?? {}) as Record<string, unknown>));
    }

    case "resources/list":
      return ok(id, {
        resources: RESOURCES.map(({ uri, name, description, mimeType }) => ({
          uri,
          name,
          description,
          mimeType,
        })),
      });

    case "resources/read": {
      const uri = params.uri;
      const res = RESOURCES.find((r) => r.uri === uri);
      if (!res) return err(id, INVALID_REQUEST, `Unknown resource: ${String(uri)}`);
      return ok(id, { contents: [{ uri: res.uri, mimeType: res.mimeType, text: res.read() }] });
    }

    case "ping":
      return ok(id, {});

    default:
      // Notifications (no id) are acknowledged with 202 by the caller below;
      // an unknown *request* gets a proper error.
      return err(id, METHOD_NOT_FOUND, `Method not found: ${method}`);
  }
}

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(err(null, PARSE_ERROR, "Invalid JSON"), { status: 400 });
  }

  try {
    // A batch is an array; a single call is an object. Both are valid JSON-RPC.
    const messages = Array.isArray(body) ? body : [body];
    const responses = messages
      .filter((m): m is Record<string, unknown> => typeof m === "object" && m !== null)
      .filter((m) => m.id !== undefined) // notifications get no response
      .map(handle);

    // All-notifications batch: nothing to return.
    if (!responses.length) return new NextResponse(null, { status: 202 });

    return NextResponse.json(Array.isArray(body) ? responses : responses[0]);
  } catch {
    return NextResponse.json(err(null, INTERNAL_ERROR, "Internal error"), { status: 500 });
  }
}

/**
 * Streamable HTTP allows a server to decline the GET (SSE) stream. This server
 * is stateless and never initiates messages, so 405 is the correct answer —
 * clients treat it as "no server-initiated stream" and carry on over POST.
 * The body is a human-readable pointer for anyone who opens the URL directly.
 */
export async function GET() {
  return new NextResponse(
    JSON.stringify(
      {
        server: SERVER_INFO,
        transport: "streamable-http (stateless; POST only, no SSE stream)",
        protocolVersion: PROTOCOL_VERSION,
        tools: TOOLS.map((t) => t.name),
        howToConnect: "Add this URL as a remote MCP server, then POST JSON-RPC 2.0 to it.",
      },
      null,
      2,
    ),
    { status: 405, headers: { "content-type": "application/json", allow: "POST" } },
  );
}
