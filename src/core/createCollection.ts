import fs from 'node:fs';
import path from 'node:path';
import { stringifyCollection } from '@usebruno/filestore';
import { isMap, isSeq, parseDocument, type YAMLSeq } from 'yaml';

import type { CollectionFormat } from './readCollection.js';

// Same files the Bruno app writes for a new collection.
const IGNORE = ['node_modules', '.git'];
const DEFAULT_GITIGNORE = ['# Secrets', '.env*', '', '# Dependencies', 'node_modules', '', '# OS files', '.DS_Store', 'Thumbs.db'].join('\n');

export interface NewCollection {
  dir: string;
  name: string;
  format: CollectionFormat;
  description?: string;
  baseUrl?: string;
}

export const createCollection = ({ dir, name, format, description, baseUrl }: NewCollection): void => {
  const root = {
    meta: { name },
    ...(baseUrl ? { request: { vars: { req: [{ name: 'baseUrl', value: baseUrl, enabled: true }] } } } : {}),
    ...(description ? { docs: description } : {})
  };

  fs.mkdirSync(dir, { recursive: true });
  if (format === 'yml') {
    const brunoConfig = { opencollection: '1.0.0', name, type: 'collection', ignore: IGNORE };
    fs.writeFileSync(path.join(dir, 'opencollection.yml'), stringifyCollection(root as any, brunoConfig, { format }));
  } else {
    const brunoConfig = { version: '1', name, type: 'collection', ignore: IGNORE };
    fs.writeFileSync(path.join(dir, 'bruno.json'), JSON.stringify(brunoConfig, null, 2));
    if (baseUrl || description) {
      fs.writeFileSync(path.join(dir, 'collection.bru'), stringifyCollection(root as any, brunoConfig, { format }));
    }
  }
  fs.writeFileSync(path.join(dir, '.gitignore'), DEFAULT_GITIGNORE);
};

// Same rule as the app: relative to the workspace, unless that takes more than two `..` hops.
const workspaceEntryPath = (workspacePath: string, collectionPath: string): string => {
  const relative = path.relative(workspacePath, collectionPath);
  const hops = relative.split(path.sep).filter((segment) => segment === '..').length;
  return (hops > 2 ? collectionPath : relative).split(path.sep).join('/');
};

// Edited as a document so the rest of workspace.yml, comments included, is left as it was.
export const addCollectionToWorkspace = (workspacePath: string, collection: { name: string; path: string }): boolean => {
  const file = path.join(workspacePath, 'workspace.yml');
  const doc = parseDocument(fs.readFileSync(file, 'utf8'));
  if (doc.errors.length > 0) throw new Error(doc.errors[0].message);

  if (!isSeq(doc.get('collections'))) doc.set('collections', doc.createNode([]));
  const seq = doc.get('collections') as YAMLSeq;
  const listed = seq.items.some((item) => {
    const entryPath = isMap(item) ? item.get('path') : null;
    return typeof entryPath === 'string' && path.resolve(workspacePath, entryPath) === collection.path;
  });
  if (listed) return false;

  seq.add(doc.createNode({ name: collection.name, path: workspaceEntryPath(workspacePath, collection.path) }));
  fs.writeFileSync(file, doc.toString());
  return true;
};
