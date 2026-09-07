import asyncio
import os

from agent_framework import Agent, MCPStreamableHTTPTool
from agent_framework.foundry import FoundryChatClient
from azure.identity.aio import AzureCliCredential


def required(name: str) -> str:
    value = os.getenv(name)
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


async def main() -> None:
    mcp_url = required("AGENTIC_DATA_MCP_URL")
    api_key = required("AGENTIC_DATA_API_KEY")
    purpose = required("AGENTIC_DATA_PURPOSE")
    instance_id = os.getenv("AGENTIC_DATA_INSTANCE_ID")

    def headers(_: dict[str, object]) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {api_key}",
            "X-Agent-Purpose": purpose,
        }

    async with AzureCliCredential() as credential:
        chat_client = FoundryChatClient(
            project_endpoint=required("FOUNDRY_PROJECT_ENDPOINT"),
            model=required("FOUNDRY_MODEL"),
            credential=credential,
        )
        async with (
            MCPStreamableHTTPTool(
                name="agentic-data-kernel",
                url=mcp_url,
                header_provider=headers,
            ) as agentic_data,
            Agent(
                client=chat_client,
                name="DurableOperationsAgent",
                instructions=(
                    "Use Agentic Data Kernel as the durable source for "
                    "incident knowledge, conflicts, workflow state, effect "
                    "status, and causal explanation. Do not claim that an "
                    "external action succeeded unless the durable effect "
                    "record says it succeeded."
                ),
                tools=agentic_data,
            ) as agent,
        ):
            prompt = (
                "Summarize the durable operational context and identify "
                "unknown or conflicting claims."
            )
            if instance_id:
                prompt += (
                    f" Inspect workflow {instance_id}, its effects, and "
                    "the causal trace around material decisions."
                )
            result = await agent.run(prompt)
            print(result.text)


if __name__ == "__main__":
    asyncio.run(main())
