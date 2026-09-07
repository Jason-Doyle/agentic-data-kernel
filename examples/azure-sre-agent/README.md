# Azure SRE Agent

This example connects Azure SRE Agent to Agentic Data Kernel as a remote,
durable incident-context service.

```text
Azure Monitor, Log Analytics, Resource Graph, Azure CLI
                         |
                         v
                  Azure SRE Agent
                         |
              Streamable HTTP MCP
                         |
                         v
             Agentic Data Kernel /mcp
                |                  |
          PostgreSQL state     effect worker
```

Azure SRE Agent remains responsible for Azure-native investigation and tool
selection. ADK preserves source-backed observations, conflicting hypotheses,
decisions, workflow revisions, effect state, and causal explanations across
threads and restarts.

## Why remote MCP

Azure SRE Agent can run stdio MCP processes, but its documented hosted runtime
currently provides Node.js 20. Agentic Data Kernel requires Node.js 22.19 or
newer. Use the remote Streamable HTTP connector rather than bypassing the
package runtime requirement.

## 1. Deploy ADK with remote MCP

Use an immutable ADK image and enable the `/mcp` route:

```text
MCP_HTTP_ENABLED=true
MCP_HTTP_PUBLIC_ORIGIN=https://agent-data.example.com
MCP_HTTP_WRITE_ENABLED=false
```

The public origin must be the exact HTTPS scheme and host used by Azure SRE
Agent. ADK validates the `Host` header and any supplied `Origin` header before
authentication.

For the included Azure Container Apps Bicep module:

```bicep
param mcpHttpEnabled = true
param mcpHttpPublicHostname = 'agent-data.example.com'
param mcpHttpWriteEnabled = false
```

## 2. Create a read-only identity

Create a dedicated API key:

```powershell
node --env-file=.env dist\production\cli.js create-key `
  --tenant operations `
  --tenant-name "Operations" `
  --principal azure-sre-agent `
  --scopes data:read `
  --purposes incident-response `
  --effect-budget 0
```

Store the token in the Azure SRE Agent connector. Do not put it in the custom
agent YAML or knowledge files.

## 3. Add the MCP connector

In the Azure SRE Agent portal:

1. Open the agent at <https://sre.azure.com>.
2. Select **Builder > Connectors > Add connector > MCP Server**.
3. Name the connection `agentic-data`.
4. Choose **Streamable-HTTP**.
5. Set the URL to `https://agent-data.example.com/mcp`.
6. Choose custom-header authentication.
7. Add:

   ```text
   Authorization: Bearer <ADK API key>
   X-Agent-Purpose: incident-response
   ```

8. Wait for the connector to show **Connected**.
9. Select only:

   ```text
   search_knowledge
   resolve_claims
   get_machine
   list_effects
   explain_trace
   ```

Remote MCP is read-only by default, so `execute_operation` is not advertised.

## 4. Add the custom agent

Import or reproduce
[`durable-incident-agent.yaml`](durable-incident-agent.yaml) in **Builder >
Agent Canvas**. Azure prefixes individual MCP tool names with the connector ID.
If your selected connection ID differs from `agentic-data`, update the YAML
tool names to match those shown in the portal.

Use **Review** mode for incident response plans until the integration has been
tested against representative incidents.

## 5. Test the integration

Preload an incident through an application, the ADK HTTP API, or the
repository's SRE scenario, then invoke the custom agent:

```text
/agent durable_incident_context

For incident:checkout-1001:
- summarize source-backed observations;
- identify conflicting hypotheses and the selected decision;
- report the current workflow revision;
- report any unknown or reconciling effects;
- explain the causal chain to the latest verification.
```

Expected behavior:

- statements distinguish observations, hypotheses, directives, and decisions;
- unknown or conflicting state remains visible;
- workflow and effect identifiers are cited;
- timed-out external actions are not described as failed or successful until
  reconciliation resolves them;
- the explanation follows stored lineage rather than reconstructing a story
  from conversation text.

## Optional write mode

To let Azure SRE Agent write assertions, workflows, or effect requests:

1. set `MCP_HTTP_WRITE_ENABLED=true`;
2. create a separate API key with only required scopes and purposes;
3. select `execute_operation` explicitly;
4. use **Review** mode for material or difficult-to-reverse actions;
5. keep provider delivery in the ADK effect worker rather than Azure SRE Agent
   retrying the external action directly.

Do not use a broad wildcard when write mode is enabled. Tool descriptions and
API-key scopes are both part of the control boundary.

Official references:

- [MCP connectors in Azure SRE Agent](https://learn.microsoft.com/en-us/azure/sre-agent/mcp-connectors)
- [Set up an MCP connector](https://learn.microsoft.com/en-us/azure/sre-agent/mcp-connector)
- [Custom agents](https://learn.microsoft.com/en-us/azure/sre-agent/sub-agents)
- [Tools in Azure SRE Agent](https://learn.microsoft.com/en-us/azure/sre-agent/tools)
