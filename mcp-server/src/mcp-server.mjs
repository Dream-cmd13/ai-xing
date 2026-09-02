import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { registerReadTools } from './tools.mjs';
import { registerWriteTools } from './write-tools.mjs';

export function createSessionMcpServer(repository, writeRepository = repository, confirmationStore) {
  const server = new McpServer(
    { name: 'ai-xing-okr', version: '0.2.0' },
    { capabilities: { tools: {} } },
  );
  registerReadTools(server, repository);
  if (confirmationStore && writeRepository) registerWriteTools(server, writeRepository, confirmationStore);
  return server;
}
