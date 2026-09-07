import asyncio
import os
from pathlib import Path

from agent_framework import Agent, MCPStdioTool
from agent_framework.foundry import FoundryChatClient
from azure.identity.aio import AzureCliCredential


def required(name: str) -> str:
    value = os.getenv(name)
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


async def main() -> None:
    database_path = Path(
        os.getenv(
            "AGENTIC_DATA_SQLITE_PATH",
            ".data/microsoft-agent-framework.db",
        )
    )
    database_path.parent.mkdir(parents=True, exist_ok=True)
    package = os.getenv(
        "AGENTIC_DATA_KERNEL_PACKAGE",
        "agentic-data-kernel@1.2.0",
    )

    async with AzureCliCredential() as credential:
        chat_client = FoundryChatClient(
            project_endpoint=required("FOUNDRY_PROJECT_ENDPOINT"),
            model=required("FOUNDRY_MODEL"),
            credential=credential,
        )
        async with (
            MCPStdioTool(
                name="agentic-data-kernel",
                command="npx",
                args=[
                    "--yes",
                    package,
                    "mcp",
                    "--db",
                    str(database_path),
                ],
            ) as agentic_data,
            Agent(
                client=chat_client,
                name="DurableIncidentAgent",
                instructions=(
                    "You investigate service incidents. Use Agentic Data "
                    "Kernel tools to preserve evidence, distinguish "
                    "observations from hypotheses, retain conflicts, and "
                    "cite durable receipt identifiers. For execute_intent, "
                    "use protocolVersion '1.0', a unique requestId, "
                    "tenantId 'framework-example', principalId "
                    "'incident-agent', and purpose 'incident-response'."
                ),
                tools=agentic_data,
            ) as agent,
        ):
            result = await agent.run(
                "Create a checkout service entity, record an observation "
                "that its error rate is 0.42, then resolve the current "
                "error_rate claim and explain what was durably stored."
            )
            print(result.text)


if __name__ == "__main__":
    asyncio.run(main())
