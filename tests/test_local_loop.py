"""The local tool-calling loop, driven by a scripted model against the real server.

The model is a fake that replays a fixed script, so these tests are
deterministic and need no Ollama. Everything else is real: the MCP server runs
as a subprocess over stdio and every allowed call goes through the protocol.
What is under test is the loop's own behaviour — does a tool call reach the
server and come back, is a forbidden tool refused without crashing, does the
turn cap hold when the model never stops.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import pytest

from agent import local_loop, researcher
from agent.local_loop import ALLOWED_TOOLS, run_loop

pytestmark = pytest.mark.anyio


@pytest.fixture
def anyio_backend():
    return "asyncio"


@dataclass
class ScriptedModel:
    """Replays replies in order; records what it was shown each turn."""

    script: list[dict[str, Any]]
    seen_tools: list[list[str]] = field(default_factory=list)
    seen_messages: list[list[dict[str, Any]]] = field(default_factory=list)

    def chat(self, messages, tools):
        self.seen_tools.append([t["function"]["name"] for t in tools])
        self.seen_messages.append(list(messages))
        if len(self.seen_messages) <= len(self.script):
            return self.script[len(self.seen_messages) - 1]
        return self.script[-1]


def call(name, **arguments):
    return {"content": "", "tool_calls": [{"name": name, "arguments": arguments}]}


def answer(text):
    return {"content": text, "tool_calls": []}


async def test_tool_result_reaches_the_model_and_the_loop_ends_on_text():
    model = ScriptedModel([call("lookup_company", query="2330"), answer("done")])

    result = await run_loop("台積電薪資？", model)

    assert result.answer == "done"
    assert result.turns == 2
    assert not result.hit_turn_cap
    assert result.audit.allowed == [("lookup_company", {"query": "2330"})]
    # The second turn must see the server's real output, not a placeholder.
    tool_msgs = [m for m in model.seen_messages[1] if m["role"] == "tool"]
    assert tool_msgs and "台積電" in tool_msgs[0]["content"]


async def test_model_is_only_shown_allow_listed_tools():
    model = ScriptedModel([answer("ok")])

    await run_loop("hi", model)

    assert sorted(model.seen_tools[0]) == sorted(ALLOWED_TOOLS)


async def test_forbidden_tool_is_refused_recorded_and_recoverable():
    model = ScriptedModel([call("run_query", sql="DROP TABLE x"), answer("recovered")])

    result = await run_loop("try something", model)

    assert result.answer == "recovered"
    assert result.audit.allowed == []
    assert [name for name, _ in result.audit.denied] == ["run_query"]
    # The denial is fed back as the tool's result, so the model can recover.
    tool_msgs = [m for m in model.seen_messages[1] if m["role"] == "tool"]
    assert "not on this agent's allow-list" in tool_msgs[0]["content"]


async def test_turn_cap_holds_when_the_model_never_stops():
    model = ScriptedModel([call("lookup_company", query="2330")])

    result = await run_loop("loop forever", model, max_turns=3)

    assert result.hit_turn_cap
    assert result.turns == 3
    assert len(result.audit.allowed) == 3


def test_allow_list_matches_the_sdk_agent():
    bare = tuple(name.split("__")[-1] for name in researcher.ALLOWED_TOOLS)
    assert local_loop.ALLOWED_TOOLS == bare
