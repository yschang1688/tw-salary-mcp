"""A model-agnostic tool-calling loop over the salary MCP server.

`researcher.py` drives the loop through the Claude Agent SDK, which needs API
credentials. This module runs the same kind of loop with the model swapped for
anything that speaks tool calling — by default a local model through Ollama —
so the multi-turn behaviour can be exercised end to end with no key at all.

The loop is deliberately small, because every step of it is a place where an
agent can go wrong:

1. Discover the server's tools over MCP, then keep only those on the
   allow-list. The model is never shown a tool it is not allowed to use.
2. Ask the model. If it answers in text, that is the final answer.
3. If it asks for tools, run each one through the allow-list again before the
   call reaches the server. A denied call is not an exception: the denial goes
   back to the model as the tool's result, so it can recover, and it is
   recorded in the audit.
4. Stop at `max_turns` whether or not the model has decided to stop.

The allow-list is the same four names `researcher.ALLOWED_TOOLS` uses, so the
two agents cannot drift apart on what they are permitted to reach.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

REPO_ROOT = Path(__file__).resolve().parent.parent

# Same surface as the SDK agent, without the mcp__<server>__ prefix the SDK adds.
ALLOWED_TOOLS = ("lookup_company", "industry_stats", "top_by_median", "company_trend")

# A tool result is fed back into the model's context; cap it so one large
# answer cannot crowd out the rest of the conversation.
MAX_TOOL_RESULT_CHARS = 4000

SYSTEM_PROMPT = """\
You research Taiwanese listed-company compensation using the provided tools.

Work in steps and gather before you judge. Whether one company's pay is good
cannot be answered from that company's number alone: look up the company, then
its industry distribution, then its multi-year trend, and only then answer.

Rules that come from how this data is built:
- Quote the median, not the mean.
- A year with no figure means not disclosed. Never treat it as zero.
- These are company-wide non-managerial figures, not role-specific offers.
- If the tools do not cover something, say so instead of estimating.

Answer in the language the user asked in. Lead with the finding, then the
evidence, and keep the source stamp the tools return.
"""


class ToolCallingModel(Protocol):
    """Anything that can take a conversation plus tool specs and reply.

    The reply is a dict: {"content": str, "tool_calls": [{"name", "arguments"}]}.
    An empty `tool_calls` list means the model has given its final answer.
    """

    def chat(self, messages: list[dict[str, Any]], tools: list[dict[str, Any]]) -> dict[str, Any]: ...


@dataclass
class OllamaModel:
    """Ollama's /api/chat with tool calling. Temperature 0 so reruns are comparable."""

    model: str = "qwen3.5:9b"
    host: str = "http://localhost:11434"
    timeout: float = 300.0

    def chat(self, messages: list[dict[str, Any]], tools: list[dict[str, Any]]) -> dict[str, Any]:
        body = json.dumps(
            {
                "model": self.model,
                "messages": messages,
                "tools": tools,
                "stream": False,
                "think": False,
                "options": {"temperature": 0},
            }
        ).encode()
        req = urllib.request.Request(
            f"{self.host}/api/chat", data=body, headers={"Content-Type": "application/json"}
        )
        with urllib.request.urlopen(req, timeout=self.timeout) as resp:
            msg = json.load(resp)["message"]
        calls = [
            {"name": c["function"]["name"], "arguments": c["function"].get("arguments") or {}}
            for c in msg.get("tool_calls") or []
        ]
        return {"content": msg.get("content", ""), "tool_calls": calls}


@dataclass
class LoopAudit:
    """Every tool call the model asked for, allowed or denied, in order."""

    allowed: list[tuple[str, dict[str, Any]]] = field(default_factory=list)
    denied: list[tuple[str, str]] = field(default_factory=list)


@dataclass
class LoopResult:
    answer: str
    turns: int
    hit_turn_cap: bool
    audit: LoopAudit
    transcript: list[dict[str, Any]]


def to_tool_spec(tool: Any) -> dict[str, Any]:
    """MCP tool description -> the function-calling spec most model APIs accept."""
    return {
        "type": "function",
        "function": {
            "name": tool.name,
            "description": tool.description or "",
            "parameters": tool.inputSchema or {"type": "object", "properties": {}},
        },
    }


def server_params(python: str | None = None) -> StdioServerParameters:
    return StdioServerParameters(
        command=python or sys.executable,
        args=["-m", "salary_mcp.server"],
        cwd=str(REPO_ROOT),
    )


async def run_loop(
    question: str,
    model: ToolCallingModel,
    *,
    max_turns: int = 8,
    params: StdioServerParameters | None = None,
) -> LoopResult:
    audit = LoopAudit()
    messages: list[dict[str, Any]] = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": question},
    ]

    async with stdio_client(params or server_params()) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            offered = (await session.list_tools()).tools
            tools = [to_tool_spec(t) for t in offered if t.name in ALLOWED_TOOLS]

            for turn in range(1, max_turns + 1):
                reply = model.chat(messages, tools)
                calls = reply["tool_calls"]
                messages.append(
                    {
                        "role": "assistant",
                        "content": reply["content"],
                        "tool_calls": [
                            {"function": {"name": c["name"], "arguments": c["arguments"]}}
                            for c in calls
                        ],
                    }
                )
                if not calls:
                    return LoopResult(reply["content"], turn, False, audit, messages)

                for call in calls:
                    name, args = call["name"], call["arguments"]
                    if name not in ALLOWED_TOOLS:
                        reason = (
                            f"{name} is not on this agent's allow-list. "
                            f"Only these are permitted: {', '.join(ALLOWED_TOOLS)}"
                        )
                        audit.denied.append((name, reason))
                        messages.append({"role": "tool", "tool_name": name, "content": reason})
                        continue
                    audit.allowed.append((name, args))
                    result = await session.call_tool(name, args)
                    text = "\n".join(b.text for b in result.content if b.type == "text")
                    messages.append(
                        {"role": "tool", "tool_name": name, "content": text[:MAX_TOOL_RESULT_CHARS]}
                    )

    return LoopResult("", max_turns, True, audit, messages)


def render_run_log(question: str, model_name: str, result: LoopResult, seconds: float) -> str:
    """A human-readable record of one live run: what was asked, every tool call, the answer."""
    lines = [
        f"# Local agent loop run — {time.strftime('%Y-%m-%d %H:%M')}",
        "",
        f"- Model: `{model_name}` via Ollama (temperature 0, thinking off)",
        f"- Turns: {result.turns}{' (hit the turn cap)' if result.hit_turn_cap else ''}",
        f"- Tool calls: {len(result.audit.allowed)} allowed, {len(result.audit.denied)} denied",
        f"- Wall time: {seconds:.1f} s",
        "",
        "## Question",
        "",
        question,
        "",
        "## Tool calls, in order",
        "",
    ]
    step = 0
    for m in result.transcript:
        if m["role"] == "assistant":
            for c in m.get("tool_calls") or []:
                step += 1
                f = c["function"]
                lines.append(f"{step}. `{f['name']}` {json.dumps(f['arguments'], ensure_ascii=False)}")
        elif m["role"] == "tool":
            first = m["content"].strip().splitlines()[0] if m["content"].strip() else "(empty)"
            lines.append(f"   → {first[:160]}")
    if result.audit.denied:
        lines += ["", "## Denied", ""] + [f"- `{n}`: {r}" for n, r in result.audit.denied]
    lines += ["", "## Final answer", "", result.answer or "(none — turn cap reached)", ""]
    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("question")
    parser.add_argument("--model", default="qwen3.5:9b")
    parser.add_argument("--max-turns", type=int, default=8)
    parser.add_argument("--log", type=Path, help="write a markdown run log here")
    args = parser.parse_args()

    started = time.perf_counter()
    result = asyncio.run(run_loop(args.question, OllamaModel(args.model), max_turns=args.max_turns))
    seconds = time.perf_counter() - started
    log = render_run_log(args.question, args.model, result, seconds)
    if args.log:
        args.log.parent.mkdir(parents=True, exist_ok=True)
        args.log.write_text(log, encoding="utf-8")
    print(log)


if __name__ == "__main__":
    main()
