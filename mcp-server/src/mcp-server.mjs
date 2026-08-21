import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { registerReadTools } from './tools.mjs';

export function createSessionMcpServer(repository) {
  const server = new McpServer(
    { name: 'ai-xing-okr', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );
  registerReadTools(server, repository);
  return server;
}
