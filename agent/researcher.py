"""A compensation-research agent built on the Claude Agent SDK.

The agent answers questions like "is this company's pay competitive?" — which
cannot be answered by a single lookup. It has to plan: find the company, pull
its sector baseline, read the multi-year trend, then judge. That planning is
the agent's job; this module supplies the tools, the guardrails, and the
budget, and stays out of the way.

Guardrails, and why each one is here:

* **The agent reaches the data only through the MCP server.** It has no shell,
  no filesystem, no network. The tool surface is the four read-only tools in
  `salary_mcp.server`, so the reachable action space is fully enumerable.
* **`can_use_tool` is a second gate.** Even within that surface, every call is
  checked against an allow-list before it runs. The MCP server would reject a
  bad argument anyway; this stops it one layer earlier and gives the host an
  audit hook. Two independent gates means a mistake in either one alone is not
  sufficient to reach the data.
* **Turn and spend caps are set, not left to default.** An agent that plans its
  own steps needs a ceiling that does not depend on it deciding to stop.
"""

from __future__ import annotations

import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from claude_agent_sdk import (
    AssistantMessage,
    ClaudeAgentOptions,
    ClaudeSDKClient,
    PermissionResultAllow,
    PermissionResultDeny,
    ResultMessage,
    TextBlock,
    ToolUseBlock,
)

REPO_ROOT = Path(__file__).resolve().parent.parent

MCP_SERVER_NAME = "salary"

# The four read-only tools the MCP server exposes, namespaced the way the SDK
# addresses MCP tools: mcp__<server>__<tool>.
ALLOWED_TOOLS = tuple(
    f"mcp__{MCP_SERVER_NAME}__{name}"
    for name in ("lookup_company", "industry_stats", "top_by_median", "company_trend")
)

SYSTEM_PROMPT = """\
You research Taiwanese listed-company compensation using the `salary` tools.

Work in steps and gather before you judge. A question about whether one
company's pay is good is not answerable from that company's number alone —
look up the company, then its industry distribution, then its multi-year
trend, and only then answer.

Rules that come from how this data is built:
- Quote the median, not the mean. When median/mean is below about 0.85 the
  distribution is right-skewed and the mean is misleading; say so when it is.
- A company missing from a year was below the disclosure threshold or not yet
  listed. Report it as not disclosed. Never treat it as zero.
- These are company-wide non-managerial figures, not role-specific. Do not
  present one as an expected offer for a particular job.
- If the tools do not cover something, say so instead of estimating.

Answer in the language the user asked in. Lead with the finding, then the
evidence that supports it.
"""


def mcp_server_config(python: str | None = None) -> dict[str, Any]:
    """Config for launching the salary MCP server over stdio.

    Kept separate from the options so tests can take this dict and connect to
    the server with a plain MCP client — that verifies the wiring is real
    without needing a model in the loop.
    """
    return {
        MCP_SERVER_NAME: {
            "type": "stdio",
            "command": python or sys.executable,
            "args": ["-m", "salary_mcp.server"],
            "cwd": str(REPO_ROOT),
        }
    }


@dataclass
class ToolAudit:
    """Records every tool call the agent attempted, allowed or denied.

    An agent that plans its own steps is only auditable if the host keeps this
    record — the transcript alone shows what it said, not what it reached for.
    """

    allowed: list[tuple[str, dict[str, Any]]] = field(default_factory=list)
    denied: list[tuple[str, str]] = field(default_factory=list)

    def __len__(self) -> int:
        return len(self.allowed) + len(self.denied)


def make_permission_handler(audit: ToolAudit):
    """Allow-list gate for tool calls, recording each decision in `audit`.

    Deny is the default: a tool that is not on the list is refused even if the
    SDK, a plugin, or a future version of the server offers it.
    """

    async def can_use_tool(tool_name: str, input_data: dict[str, Any], context: Any):
        if tool_name in ALLOWED_TOOLS:
            audit.allowed.append((tool_name, input_data))
            return PermissionResultAllow(updated_input=input_data)

        reason = (
            f"{tool_name} is not on this agent's allow-list. "
            f"Only these are permitted: {', '.join(ALLOWED_TOOLS)}"
        )
        audit.denied.append((tool_name, reason))
        return PermissionResultDeny(message=reason)

    return can_use_tool


def build_options(
    audit: ToolAudit,
    *,
    model: str = "claude-opus-5",
    max_turns: int = 12,
    max_budget_usd: float = 0.50,
) -> ClaudeAgentOptions:
    """Assemble the agent's configuration.

    `max_turns` and `max_budget_usd` are set explicitly rather than left to
    default: an agent that decides its own next step needs a ceiling that does
    not depend on it choosing to stop.
    """
    return ClaudeAgentOptions(
        model=model,
        system_prompt=SYSTEM_PROMPT,
        mcp_servers=mcp_server_config(),
        allowed_tools=list(ALLOWED_TOOLS),
        can_use_tool=make_permission_handler(audit),
        permission_mode="default",
        max_turns=max_turns,
        max_budget_usd=max_budget_usd,
    )


@dataclass
class Answer:
    text: str
    audit: ToolAudit
    cost_usd: float | None = None


async def research(question: str, **option_overrides) -> Answer:
    """Run one research question to completion and return the answer plus the
    tool-call audit."""
    audit = ToolAudit()
    options = build_options(audit, **option_overrides)

    chunks: list[str] = []
    cost: float | None = None

    async with ClaudeSDKClient(options=options) as client:
        await client.query(question)
        async for message in client.receive_response():
            if isinstance(message, AssistantMessage):
                for block in message.content:
                    if isinstance(block, TextBlock):
                        chunks.append(block.text)
                    elif isinstance(block, ToolUseBlock):
                        print(f"  [tool] {block.name} {block.input}", file=sys.stderr)
            elif isinstance(message, ResultMessage):
                cost = getattr(message, "total_cost_usd", None)

    return Answer(text="".join(chunks), audit=audit, cost_usd=cost)


async def _main() -> None:
    question = " ".join(sys.argv[1:]) or "崇越科技 (5434) 的薪資水準在同業裡算好嗎？"
    answer = await research(question)
    print(answer.text)
    print(
        f"\n[{len(answer.audit.allowed)} tool calls allowed, "
        f"{len(answer.audit.denied)} denied"
        + (f", ${answer.cost_usd:.4f}" if answer.cost_usd else "")
        + "]",
        file=sys.stderr,
    )


if __name__ == "__main__":
    import asyncio

    asyncio.run(_main())
