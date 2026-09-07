# Microsoft Agent Framework

These Python examples connect Microsoft Agent Framework to Agentic Data Kernel
through supported MCP transports.

## Requirements

- Python 3.12
- Node.js 22.19 or newer for the local stdio example
- Azure CLI authentication or another credential supported by
  `AzureCliCredential`
- a Microsoft Foundry project and deployed model

Install:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r examples\microsoft-agent-framework\requirements.txt
$env:FOUNDRY_PROJECT_ENDPOINT = "https://<resource>.services.ai.azure.com/api/projects/<project>"
$env:FOUNDRY_MODEL = "<deployment-name>"
az login
```

## Local embedded MCP

`local_stdio.py` lets Agent Framework launch the published ADK MCP process over
stdio. The example uses the embedded SQLite profile and is suitable for local
development:

```powershell
python examples\microsoft-agent-framework\local_stdio.py
```

The agent is instructed to create source records and resolve a claim through
Agent Intent. The local profile accepts caller-supplied identity and must not
be exposed as a network production service.

Override the package or database when needed:

```powershell
$env:AGENTIC_DATA_KERNEL_PACKAGE = "agentic-data-kernel@1.2.0"
$env:AGENTIC_DATA_SQLITE_PATH = ".data\framework.db"
```

## Production Streamable HTTP MCP

`remote_http.py` connects Agent Framework to a deployed ADK `/mcp` endpoint.
Enable remote MCP on the production API:

```text
MCP_HTTP_ENABLED=true
MCP_HTTP_PUBLIC_ORIGIN=https://agent-data.example.com
MCP_HTTP_WRITE_ENABLED=false
```

Create a purpose-bound API key with only the scopes the agent needs. The
read-only example requires `data:read`.

```powershell
$env:AGENTIC_DATA_MCP_URL = "https://agent-data.example.com/mcp"
$env:AGENTIC_DATA_API_KEY = "<ADK API key>"
$env:AGENTIC_DATA_PURPOSE = "incident-response"
$env:AGENTIC_DATA_INSTANCE_ID = "incident:1001" # optional
python examples\microsoft-agent-framework\remote_http.py
```

The header provider supplies credentials on connection, discovery, health, and
tool-call requests. Credentials never appear in model-visible arguments.

Keep `MCP_HTTP_WRITE_ENABLED=false` unless the agent must write knowledge,
advance workflows, or request effects. When enabled, use a narrowly scoped API
key and the Agent Framework approval features appropriate to the action risk.

Official references:

- [Microsoft Agent Framework overview](https://learn.microsoft.com/en-us/agent-framework/overview/)
- [Using MCP tools](https://learn.microsoft.com/en-us/agent-framework/agents/tools/local-mcp-tools)
- [Agent middleware](https://learn.microsoft.com/en-us/agent-framework/concepts/agents/middleware/defining-middleware)
