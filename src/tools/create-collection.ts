import fs from 'node:fs';
import path from 'node:path';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { addCollectionToWorkspace, createCollection } from '../core/createCollection.js';
import { isCollectionDir, isWorkspaceDir } from '../core/discover.js';
import { errorText, textResult, type ToolContext } from './helpers.js';

const isEmptyDir = (dir: string): boolean => fs.statSync(dir).isDirectory() && fs.readdirSync(dir).length === 0;

export const registerCreateCollectionTool = (server: McpServer, _ctx: ToolContext): void => {
  server.registerTool(
    'create_collection',
    {
      title: 'Create a Bruno collection',
      description:
        'Create a new, empty collection on disk, with the same files the Bruno app writes. ' +
        'Optionally set a {{baseUrl}} collection variable and a description, and list the collection in a Bruno workspace. ' +
        'Pass the returned collectionPath to write_request to add requests.',
      inputSchema: {
        name: z.string().trim().min(1).describe('Collection name, as shown in Bruno.'),
        outputPath: z
          .string()
          .describe('Absolute path of the directory to create the collection in, e.g. "/Users/me/api/payments". It must not exist yet, or be empty.'),
        description: z.string().optional().describe('Collection docs, in Markdown.'),
        baseUrl: z.string().optional().describe('Saved as the collection variable "baseUrl", so requests can use {{baseUrl}}.'),
        format: z
          .enum(['yml', 'bru'])
          .optional()
          .describe('File format: "yml" (OpenCollection YAML, the default) or "bru".'),
        workspacePath: z
          .string()
          .optional()
          .describe('Absolute path to a Bruno workspace (the directory containing workspace.yml) to list the new collection in.')
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async ({ name, outputPath, description, baseUrl, format = 'yml', workspacePath }) => {
      if (!path.isAbsolute(outputPath)) {
        return textResult({ error: `outputPath must be an absolute path: ${outputPath}` }, true);
      }
      const dir = path.resolve(outputPath);
      if (fs.existsSync(dir) && !isEmptyDir(dir)) {
        return textResult(
          {
            error: isCollectionDir(dir) ? `There is already a Bruno collection at: ${dir}` : `Not an empty directory: ${dir}`,
            hint: 'Pass a path that doesn\'t exist yet, or an empty directory.'
          },
          true
        );
      }
      if (workspacePath && !isWorkspaceDir(path.resolve(workspacePath))) {
        return textResult(
          {
            error: `Not a Bruno workspace: ${workspacePath}`,
            hint: 'workspacePath must be the directory containing workspace.yml. Omit it to create the collection on its own.'
          },
          true
        );
      }

      try {
        createCollection({ dir, name, format, description, baseUrl });
      } catch (err: any) {
        return textResult({ error: `Could not create the collection: ${errorText(err)}` }, true);
      }

      let registered = false;
      if (workspacePath) {
        try {
          registered = addCollectionToWorkspace(path.resolve(workspacePath), { name, path: dir });
        } catch (err: any) {
          return textResult(
            {
              error: `Created the collection at ${dir}, but could not add it to the workspace: ${errorText(err)}`,
              collectionPath: dir
            },
            true
          );
        }
      }

      return textResult({
        ok: true,
        collectionPath: dir,
        name,
        format,
        registered,
        ...(workspacePath ? { workspacePath: path.resolve(workspacePath) } : {})
      });
    }
  );
};
