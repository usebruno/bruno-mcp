import path from 'node:path';
import fs from 'node:fs';
import yaml from 'js-yaml';

import type { DiscoveryConfig, RegisteredCollection, CollectionListItem, RequestInfo } from '../types.js';
import { collectionsFromWorkspace, discoverCollections, isCollectionDir, isWorkspaceDir } from './discover.js';
import {
  ENVIRONMENTS_DIR,
  SKIPPED_DIRS,
  detectFormat,
  isRequestFile,
  readCollectionIndex,
  type CollectionFormat
} from './readCollection.js';
import { listEnvironmentFiles, type EnvironmentFile } from './environments.js';

const collectionNameFromConfig = (collectionPath: string): string => {
  const brunoJsonPath = path.join(collectionPath, 'bruno.json');
  if (fs.existsSync(brunoJsonPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(brunoJsonPath, 'utf8'));
      if (config && config.name) return config.name;
    } catch (_) {}
  }

  const openCollPath = path.join(collectionPath, 'opencollection.yml');
  if (fs.existsSync(openCollPath)) {
    try {
      const doc: any = yaml.load(fs.readFileSync(openCollPath, 'utf8'));
      if (doc && doc.info && doc.info.name) return doc.info.name;
    } catch (_) {}
  }

  return path.basename(collectionPath);
};

const listEnvironments = (collectionPath: string): string[] =>
  listEnvironmentFiles(collectionPath).map((env) => env.name);

export const filterCollections = (
  collections: CollectionListItem[],
  { search }: { search?: string } = {}
): CollectionListItem[] => {
  if (!search) return collections;
  const q = String(search).toLowerCase();
  return collections.filter((c) =>
    [c.name, c.path, c.workspaceName].some((f) => typeof f === 'string' && f.toLowerCase().includes(q))
  );
};

export const filterRequests = (
  requests: RequestInfo[],
  { search, method }: { search?: string; method?: string } = {}
): RequestInfo[] => {
  let out = Array.isArray(requests) ? requests : [];
  if (method) {
    const m = String(method).toUpperCase();
    out = out.filter((r) => (r.method || '').toUpperCase() === m);
  }
  if (search) {
    const q = String(search).toLowerCase();
    out = out.filter((r) =>
      [r.name, r.relativePath, r.url].some((f) => typeof f === 'string' && f.toLowerCase().includes(q))
    );
  }
  return out;
};

export interface ResolvedRequestFile {
  path: string;
  format: CollectionFormat;
}

/** True when `child` sits under `parent`: not equal to it, and not reachable only via `..`. */
const isInside = (parent: string, child: string): boolean => {
  const rel = path.relative(parent, child);
  return rel.length > 0 && !rel.startsWith('..') && !path.isAbsolute(rel);
};

// Case-insensitive, since macOS and Windows volumes resolve `Environments/` and `.GIT/` to the real folders.
const isReservedPath = (collectionPath: string, target: string): boolean => {
  const segments = path.relative(collectionPath, target).toLowerCase().split(path.sep);
  return segments[0] === ENVIRONMENTS_DIR || segments.some((segment) => SKIPPED_DIRS.has(segment));
};

const pathExists = (p: string): boolean => {
  try {
    fs.lstatSync(p);
    return true;
  } catch (_) {
    return false;
  }
};

// Checks the real path of the deepest part of `child` that exists, so a symlink can't lead out of the collection or into a reserved folder.
const isInsideOnDisk = (parent: string, child: string): boolean => {
  let existing = child;
  while (!pathExists(existing)) existing = path.dirname(existing);
  try {
    const realParent = fs.realpathSync.native(parent);
    const real = fs.realpathSync.native(existing);
    if (real === realParent) return existing !== child;
    return isInside(realParent, real) && !isReservedPath(realParent, real);
  } catch (_) {
    return false;
  }
};

export class CollectionRegistry {
  private config: DiscoveryConfig;
  private collections: RegisteredCollection[] = [];

  constructor(config: DiscoveryConfig) {
    this.config = config;
    this.refresh();
  }

  refresh(): void {
    const { collections } = discoverCollections(this.config);
    this.collections = collections.map((entry) => ({
      name: entry.nameInWorkspace || collectionNameFromConfig(entry.path),
      path: entry.path,
      workspacePath: entry.workspacePath || null,
      workspaceName: entry.workspaceName || null
    }));
  }

  private find(collectionPath: string): RegisteredCollection | null {
    const target = path.resolve(String(collectionPath));
    const configured = this.collections.find((c) => c.path === target);
    if (configured) return configured;

    if (!isCollectionDir(target)) return null;
    return {
      path: target,
      name: collectionNameFromConfig(target),
      workspacePath: null,
      workspaceName: null
    };
  }

  list(): CollectionListItem[] {
    return this.collections.map((c) => ({
      name: c.name,
      path: c.path,
      workspaceName: c.workspaceName,
      workspacePath: c.workspacePath,
      environments: listEnvironments(c.path)
    }));
  }

  listWorkspace(workspacePath: string): { name: string; collections: CollectionListItem[] } | null {
    const target = path.resolve(String(workspacePath));
    if (!isWorkspaceDir(target)) return null;

    const members = collectionsFromWorkspace(target);
    return {
      name: members[0]?.workspaceName || path.basename(target),
      collections: members.map((entry) => ({
        name: entry.nameInWorkspace || collectionNameFromConfig(entry.path),
        path: entry.path,
        workspaceName: entry.workspaceName,
        workspacePath: entry.workspacePath,
        environments: listEnvironments(entry.path)
      }))
    };
  }

  resolve(collectionPath: string): RegisteredCollection | null {
    return this.find(collectionPath);
  }

  environments(collectionPath: string): string[] {
    const collection = this.find(collectionPath);
    if (!collection) return [];
    return listEnvironments(collection.path);
  }

  environmentFiles(collectionPath: string): EnvironmentFile[] {
    const collection = this.find(collectionPath);
    if (!collection) return [];
    return listEnvironmentFiles(collection.path);
  }

  listRequests(collectionPath: string): RequestInfo[] | null {
    const collection = this.find(collectionPath);
    if (!collection) return null;
    return readCollectionIndex(collection.path);
  }

  // A request file path that may not exist yet: inside the collection, outside `environments`, `.git`, and `node_modules`.
  resolveRequestTarget(collectionPath: string, relativePath: string): ResolvedRequestFile | null {
    const collection = this.find(collectionPath);
    if (!collection) return null;

    const format = detectFormat(collection.path);
    if (!format) return null;

    const target = path.resolve(collection.path, relativePath);
    if (!isInside(collection.path, target) || isReservedPath(collection.path, target)) return null;
    if (!isRequestFile(collection.path, target, format)) return null;
    if (!isInsideOnDisk(collection.path, target)) return null;

    return { path: target, format };
  }

  resolveRequestPath(collectionPath: string, relativePath: string): ResolvedRequestFile | null {
    const resolved = this.resolveRequestTarget(collectionPath, relativePath);
    if (!resolved) return null;
    try {
      return fs.statSync(resolved.path).isFile() ? resolved : null;
    } catch (_) {
      return null;
    }
  }

  // A folder to put requests in, created on write if missing; "" is the collection root.
  resolveFolderTarget(collectionPath: string, relativePath: string): string | null {
    const collection = this.find(collectionPath);
    if (!collection) return null;

    const target = path.resolve(collection.path, relativePath);
    if (target === collection.path) return target;
    if (!isInside(collection.path, target) || isReservedPath(collection.path, target)) return null;
    if (!isInsideOnDisk(collection.path, target)) return null;

    try {
      return fs.statSync(target).isDirectory() ? target : null;
    } catch (_) {
      return target;
    }
  }

  resolveFolderPath(collectionPath: string, relativePath: string): string | null {
    const collection = this.find(collectionPath);
    if (!collection) return null;

    const target = path.resolve(collection.path, relativePath);
    if (!isInside(collection.path, target)) return null;

    const prefix = path.relative(collection.path, target) + path.sep;
    try {
      return readCollectionIndex(collection.path).some((r) => r.relativePath.startsWith(prefix)) ? target : null;
    } catch (_) {
      return null;
    }
  }
}
