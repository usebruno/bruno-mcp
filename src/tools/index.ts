import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { ToolContext } from './helpers.js';
import { registerListCollectionsTool } from './list-collections.js';
import { registerListRequestsTool } from './list-requests.js';
import { registerGetRequestTool } from './get-request.js';
import { registerExecuteRequestTool } from './execute-request.js';
import { registerRunCollectionTool } from './run-collection.js';
import { registerListEnvironmentsTool } from './list-environments.js';
import { registerGetEnvironmentTool } from './get-environment.js';
import { registerListFoldersTool } from './list-folders.js';
import { registerGetCollectionStatsTool } from './get-collection-stats.js';
import { registerSetEnvironmentVariableTool } from './set-environment-variable.js';
import { registerRemoveEnvironmentVariableTool } from './remove-environment-variable.js';
import { registerCreateCollectionTool } from './create-collection.js';
import { registerWriteRequestTool } from './write-request.js';
import { registerDeleteRequestTool } from './delete-request.js';
import { registerMoveRequestTool } from './move-request.js';
import { registerAddTestScriptTool } from './add-test-script.js';
import { registerRemoveScriptTool } from './remove-script.js';

export const registerTools = (server: McpServer, ctx: ToolContext): void => {
  registerListCollectionsTool(server, ctx);
  registerListRequestsTool(server, ctx);
  registerGetRequestTool(server, ctx);
  registerExecuteRequestTool(server, ctx);
  registerRunCollectionTool(server, ctx);
  registerListEnvironmentsTool(server, ctx);
  registerGetEnvironmentTool(server, ctx);
  registerListFoldersTool(server, ctx);
  registerGetCollectionStatsTool(server, ctx);
  registerSetEnvironmentVariableTool(server, ctx);
  registerRemoveEnvironmentVariableTool(server, ctx);
  registerCreateCollectionTool(server, ctx);
  registerWriteRequestTool(server, ctx);
  registerDeleteRequestTool(server, ctx);
  registerMoveRequestTool(server, ctx);
  registerAddTestScriptTool(server, ctx);
  registerRemoveScriptTool(server, ctx);
};

export type { ToolContext } from './helpers.js';
