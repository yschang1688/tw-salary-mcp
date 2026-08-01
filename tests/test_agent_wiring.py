"""Tests for the agent's guardrails and its wiring to the MCP server.

What these cover and what they deliberately do not:

* The permission gate is pure logic and is tested directly, including the
  denial path — the case that matters and the one that is easy to leave
  untested because the happy path passes without it.
* The MCP config the agent hands the SDK is used to launch the server for
  real, and every tool the agent allow-lists is checked to exist on that
  server. A typo in a tool name would otherwise surface only at runtime, as
  the model silently failing to call a tool it was told it had.
* The agent *loop* — the SDK driving a model through those tools — is not
  covered here. It needs API credentials, and it is Anthropic's code rather
  than this repo's. See README "Verification status".
"""

from __future__ import annotations

import sys

import pytest
from claude_agent_sdk import PermissionResultAllow, PermissionResultDeny
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

from agent.researcher import (
    ALLOWED_TOOLS,
    MCP_SERVER_NAME,
    ToolAudit,
    build_options,
    make_permission_handler,
    mcp_server_config,
)

pytestmark = pytest.mark.anyio


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def test_allowed_tool_passes_and_is_audited():
    audit = ToolAudit()
    handler = make_permission_handler(audit)

    result = await handler(ALLOWED_TOOLS[0], {"query": "5434"}, None)

    assert isinstance(result, PermissionResultAllow)
    assert audit.allowed == [(ALLOWED_TOOLS[0], {"query": "5434"})]
    assert not audit.denied


@pytest.mark.parametrize(
    "tool_name",
    ["Bash", "Write", "Edit", "WebFetch", "mcp__salary__drop_table", "read_file"],
)
async def test_tools_outside_the_allow_list_are_denied(tool_name: str):
    """Deny is the default. A tool the agent was never granted must be refused
    even when it looks like it belongs to our own MCP server."""
    audit = ToolAudit()
    handler = make_permission_handler(audit)

    result = await handler(tool_name, {"anything": "goes"}, None)

    assert isinstance(result, PermissionResultDeny)
    assert tool_name in result.message
    assert not audit.allowed
    assert audit.denied and audit.denied[0][0] == tool_name


async def test_denial_message_names_what_is_permitted():
    """A bare refusal makes an agent retry blindly; naming the allowed tools
    lets it re-plan instead of looping."""
    audit = ToolAudit()
    result = await make_permission_handler(audit)("Bash", {}, None)

    for tool in ALLOWED_TOOLS:
        assert tool in result.message


async def test_audit_counts_both_outcomes():
    audit = ToolAudit()
    handler = make_permission_handler(audit)

    await handler(ALLOWED_TOOLS[0], {"query": "2330"}, None)
    await handler("Bash", {"command": "rm -rf /"}, None)

    assert len(audit) == 2
    assert len(audit.allowed) == 1 and len(audit.denied) == 1


def test_options_set_explicit_ceilings():
    """An agent that plans its own steps needs limits that do not depend on it
    deciding to stop."""
    options = build_options(ToolAudit())

    assert options.max_turns is not None and options.max_turns > 0
    assert options.max_budget_usd is not None and options.max_budget_usd > 0
    assert options.can_use_tool is not None
    assert options.permission_mode == "default"


def test_options_grant_no_tool_beyond_the_mcp_server():
    """The agent must not be granted a shell, file, or network tool."""
    options = build_options(ToolAudit())

    assert set(options.allowed_tools) == set(ALLOWED_TOOLS)
    for tool in options.allowed_tools:
        assert tool.startswith(f"mcp__{MCP_SERVER_NAME}__")


async def test_every_allow_listed_tool_exists_on_the_real_server():
    """Launch the server using the exact config the agent hands the SDK, and
    confirm each allow-listed name is a tool it actually serves.

    This is the test that catches a renamed or misspelled tool. Without it, a
    typo shows up only as the model quietly never calling that tool.
    """
    config = mcp_server_config()[MCP_SERVER_NAME]
    params = StdioServerParameters(
        command=config["command"], args=config["args"], cwd=config["cwd"]
    )

    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            served = {t.name for t in (await session.list_tools()).tools}

    expected = {name.split("__", 2)[2] for name in ALLOWED_TOOLS}
    assert expected == served, (
        f"allow-list and server disagree — only on server: {served - expected}; "
        f"only on allow-list: {expected - served}"
    )


def test_mcp_config_uses_the_running_interpreter():
    """Hard-coding `python` would launch whatever is first on PATH, which in a
    virtualenv is usually the wrong interpreter and fails at import."""
    config = mcp_server_config()[MCP_SERVER_NAME]

    assert config["command"] == sys.executable
    assert config["type"] == "stdio"
