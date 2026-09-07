import assert from "node:assert/strict";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import test from "node:test";
import { AgenticKernel } from "../kernel.js";
import { createMcpServer } from "../mcp.js";
import { SqliteStore } from "../store.js";

test("MCP exposes catalog and executes an intent", async () => {
  const store = new SqliteStore(":memory:");
  const kernel = new AgenticKernel(store);
  const server = createMcpServer(kernel);
  const client = new Client({
    name: "agentic-data-test-client",
    version: "0.1.0",
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const tools = await client.listTools();
  const executeIntentTool = tools.tools.find(
    (tool) => tool.name === "execute_intent",
  );
  assert.ok(executeIntentTool);
  const executeIntentSchema = JSON.stringify(
    executeIntentTool.inputSchema,
  );
  assert.match(executeIntentSchema, /protocolVersion/);
  assert.match(executeIntentSchema, /put_entity/);
  assert.ok(tools.tools.some((tool) => tool.name === "search_knowledge"));
  assert.ok(tools.tools.some((tool) => tool.name === "explain_trace"));

  const resource = await client.readResource({
    uri: "agentic-data://catalog",
  });
  const catalogText = resource.contents[0];
  assert.ok(catalogText && "text" in catalogText);
  assert.match(catalogText.text, /\"protocolVersion\": \"1.0\"/);

  const result = await client.callTool({
    name: "execute_intent",
    arguments: {
      envelope: {
        protocolVersion: "0.1",
        requestId: "mcp-request-1",
        principal: {
          tenantId: "tenant-mcp",
          principalId: "mcp-agent",
          purpose: "test",
        },
        operation: {
          op: "put_entity",
          entity: {
            entityId: "entity:1",
            entityType: "test",
            canonicalName: "MCP Entity",
          },
        },
      },
    },
  });
  assert.ok(isTextContent(result.content));
  const text = result.content[0];
  assert.ok(text);
  const execution = JSON.parse(text.text) as { status: string };
  assert.equal(execution.status, "ok");

  const receiptsBefore = kernel.readSql(
    "SELECT COUNT(*) AS count FROM execution_receipts",
  )[0]?.count;
  await client.callTool({
    name: "search_knowledge",
    arguments: {
      tenantId: "tenant-mcp",
      principalId: "mcp-agent",
      purpose: "test",
      text: "nothing stored yet",
    },
  });
  const receiptsAfter = kernel.readSql(
    "SELECT COUNT(*) AS count FROM execution_receipts",
  )[0]?.count;
  assert.equal(receiptsAfter, receiptsBefore);

  await client.close();
  await server.close();
  store.close();
});

test("packaged CLI serves MCP over stdio", async () => {
  const client = new Client({
    name: "agentic-data-cli-test",
    version: "0.1.0",
  });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      "--no-warnings",
      resolve(process.cwd(), "dist", "cli.js"),
      "mcp",
      "--db",
      ":memory:",
    ],
    stderr: "pipe",
  });
  await client.connect(transport);
  const tools = await client.listTools();
  assert.ok(tools.tools.some((tool) => tool.name === "execute_intent"));
  await client.close();
});

function isTextContent(
  value: unknown,
): value is Array<{ type: "text"; text: string }> {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        item !== null &&
        typeof item === "object" &&
        "type" in item &&
        item.type === "text" &&
        "text" in item &&
        typeof item.text === "string",
    )
  );
}
