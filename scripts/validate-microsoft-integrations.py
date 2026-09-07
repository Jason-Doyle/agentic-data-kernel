from pathlib import Path
import inspect

import yaml
from agent_framework import Agent, MCPStdioTool, MCPStreamableHTTPTool
from agent_framework.foundry import FoundryChatClient
from azure.identity.aio import AzureCliCredential


ROOT = Path(__file__).resolve().parent.parent
MICROSOFT_EXAMPLES = ROOT / "examples" / "microsoft-agent-framework"
AZURE_SRE_EXAMPLE = ROOT / "examples" / "azure-sre-agent"


def main() -> None:
    for source in [
        MICROSOFT_EXAMPLES / "local_stdio.py",
        MICROSOFT_EXAMPLES / "remote_http.py",
    ]:
        compile(source.read_text(encoding="utf-8"), str(source), "exec")

    definition = yaml.safe_load(
        (AZURE_SRE_EXAMPLE / "durable-incident-agent.yaml").read_text(
            encoding="utf-8"
        )
    )
    assert definition["name"] == "durable_incident_context"
    assert definition["enable_skills"] is True
    assert definition["mcp_tools"] == [
        "agentic-data_search_knowledge",
        "agentic-data_resolve_claims",
        "agentic-data_get_machine",
        "agentic-data_list_effects",
        "agentic-data_explain_trace",
    ]

    for imported in [
        Agent,
        MCPStdioTool,
        MCPStreamableHTTPTool,
        FoundryChatClient,
        AzureCliCredential,
    ]:
        assert imported is not None

    expected_parameters = {
        MCPStdioTool: {"name", "command", "args"},
        MCPStreamableHTTPTool: {"name", "url", "header_provider"},
        Agent: {"client", "name", "instructions", "tools"},
        FoundryChatClient: {"project_endpoint", "model", "credential"},
    }
    for callable_value, expected in expected_parameters.items():
        actual = set(inspect.signature(callable_value).parameters)
        missing = expected - actual
        assert not missing, (
            f"{callable_value.__name__} is missing parameters: "
            f"{', '.join(sorted(missing))}"
        )

    print("Microsoft Agent Framework and Azure SRE Agent examples validated.")


if __name__ == "__main__":
    main()
