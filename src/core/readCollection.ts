import path from 'node:path';
import fs from 'node:fs';
import yaml from 'js-yaml';
import { parseFolder, parseRequest } from '@usebruno/filestore';

import type { RequestInfo } from '../types.js';

export type CollectionFormat = 'bru' | 'yml';

export const FORMAT_FILES: Record<CollectionFormat, { ext: string; collectionFile: string; folderFile: string }> = {
  yml: { ext: '.yml', collectionFile: 'opencollection.yml', folderFile: 'folder.yml' },
  bru: { ext: '.bru', collectionFile: 'collection.bru', folderFile: 'folder.bru' }
};

export const detectFormat = (collectionPath: string): CollectionFormat | null => {
  if (fs.existsSync(path.join(collectionPath, 'opencollection.yml'))) return 'yml';
  if (fs.existsSync(path.join(collectionPath, 'bruno.json'))) return 'bru';
  return null;
};

export const ENVIRONMENTS_DIR = 'environments';
export const SKIPPED_DIRS = new Set(['.git', 'node_modules']);

// Root `environments` only, a nested folder of that name holds ordinary requests.
export const isInEnvironmentsDir = (collectionPath: string, target: string): boolean =>
  path.relative(collectionPath, target).split(path.sep)[0] === ENVIRONMENTS_DIR;

export const isRequestFile = (collectionPath: string, filePath: string, format: CollectionFormat): boolean => {
  const { ext, collectionFile, folderFile } = FORMAT_FILES[format];
  if (path.extname(filePath) !== ext) return false;

  const base = path.basename(filePath);
  if (base === collectionFile || base === folderFile) return false;

  return !isInEnvironmentsDir(collectionPath, filePath);
};

export const parseRequestFile = (filePath: string, format: CollectionFormat): any =>
  parseRequest(fs.readFileSync(filePath, 'utf8'), { format });

interface FolderMeta {
  name?: string;
  seq?: number;
}

const readFolderMeta = (dir: string, format: CollectionFormat): FolderMeta => {
  const folderPath = path.join(dir, FORMAT_FILES[format].folderFile);
  if (!fs.existsSync(folderPath)) return {};
  try {
    const parsed = parseFolder(fs.readFileSync(folderPath, 'utf8'), { format });
    // The .bru parser returns a rejected promise on malformed files instead of throwing.
    if (typeof parsed?.then === 'function') {
      parsed.catch(() => {});
      return {};
    }
    return { name: parsed?.meta?.name || undefined, seq: parsed?.meta?.seq };
  } catch (_) {
    return {};
  }
};

// folders first (by seq, then name), then requests by seq: mirrors how Bruno lists a collection
const bySeqThenName = (a: any, b: any): number => {
  const sa = typeof a.seq === 'number' ? a.seq : Infinity;
  const sb = typeof b.seq === 'number' ? b.seq : Infinity;
  return sa !== sb ? sa - sb : String(a.name).localeCompare(String(b.name));
};

const REQUEST_TYPES: Record<string, string> = {
  http: 'http-request',
  graphql: 'graphql-request',
  grpc: 'grpc-request',
  ws: 'ws-request'
};

interface ScannedRequest {
  name: string;
  type: string | null;
  seq: number | undefined;
  method: string | null;
  url: string | null;
}

type IndexedRequest = ScannedRequest & { pathname: string };
interface IndexedFolder {
  name: string;
  pathname: string;
  seq: number | undefined;
}

/**
 * For quick scanning, we only read the first part of .bru files.
 * This is enough to get the meta block (name, type, seq) and HTTP verb block (method, url)
 * without parsing the potentially large body, scripts, or tests that come later.
 */
const HEAD_BYTES = 4096;

const readHead = (filePath: string): string => {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    const bytesRead = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
    return buf.subarray(0, bytesRead).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
};

// Regex patterns to extract key info from .bru files
const BRU_META_BLOCK = /^meta\s*\{([\s\S]*?)^\}/m;           // The meta { ... } block with name, type, seq
const BRU_VERB_BLOCK = /^(get|post|put|delete|patch|head|options|trace)\s*\{([\s\S]*?)^\}/im;  // HTTP verb block
const BRU_NAME = /^\s*name:\s*(.*)$/m;   // Request name inside meta block
const BRU_TYPE = /^\s*type:\s*(.*)$/m;   // Request type (http, graphql, etc.)
const BRU_SEQ = /^\s*seq:\s*(\d+)\s*$/m; // Sequence number for ordering
const BRU_URL = /^\s*url:\s*(.*)$/m;     // URL inside verb block

const field = (block: string, pattern: RegExp): string | null => {
  const match = block.match(pattern);
  const value = match ? match[1].trim() : '';
  return value.length > 0 ? value : null;
};

const scanBruHead = (filePath: string): ScannedRequest | null => {
  const head = readHead(filePath);
  const verb = head.match(BRU_VERB_BLOCK);
  if (!verb) return null;

  const meta = head.match(BRU_META_BLOCK);
  const metaBlock = meta ? meta[1] : '';
  const seq = field(metaBlock, BRU_SEQ);

  return {
    name: field(metaBlock, BRU_NAME) || path.basename(filePath, '.bru'),
    type: REQUEST_TYPES[field(metaBlock, BRU_TYPE) || ''] || null,
    seq: seq === null ? undefined : Number(seq),
    method: verb[1].toUpperCase(),
    url: field(verb[2], BRU_URL)
  };
};

const scanYmlFile = (filePath: string): ScannedRequest | null => {
  let doc: any;
  try {
    doc = yaml.load(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return null;
  }
  if (!doc || typeof doc !== 'object') return null;

  const protocol = doc.http || doc.graphql || doc.grpc || doc.ws;
  if (!protocol || typeof protocol !== 'object') return null;

  const info = doc.info || {};
  return {
    name: info.name ? String(info.name) : path.basename(filePath, '.yml'),
    type: REQUEST_TYPES[String(info.type || '')] || null,
    seq: typeof info.seq === 'number' ? info.seq : undefined,
    method: protocol.method != null ? String(protocol.method).toUpperCase() : null,
    url: protocol.url != null ? String(protocol.url) : null
  };
};

const scanViaParse = (filePath: string, format: CollectionFormat): ScannedRequest | null => {
  try {
    const parsed = parseRequestFile(filePath, format);
    return {
      name: parsed.name || path.basename(filePath, FORMAT_FILES[format].ext),
      type: parsed.type || null,
      seq: typeof parsed.seq === 'number' ? parsed.seq : undefined,
      method: parsed.request?.method || null,
      url: parsed.request?.url || null
    };
  } catch (_) {
    // malformed files are skipped
    return null;
  }
};

const scanRequest = (filePath: string, format: CollectionFormat): ScannedRequest | null => {
  try {
    return (format === 'bru' ? scanBruHead(filePath) : scanYmlFile(filePath)) ?? scanViaParse(filePath, format);
  } catch (_) {
    return null;
  }
};

export const readCollectionIndex = (collectionPath: string): RequestInfo[] => {
  const format = detectFormat(collectionPath);
  if (!format) {
    throw new Error(`Not a Bruno collection: ${collectionPath}`);
  }

  const index: RequestInfo[] = [];

  const traverse = (currentPath: string): void => {
    const folders: IndexedFolder[] = [];
    const requests: IndexedRequest[] = [];

    for (const file of fs.readdirSync(currentPath)) {
      const filePath = path.join(currentPath, file);
      const stats = fs.lstatSync(filePath);

      if (stats.isDirectory()) {
        if (isInEnvironmentsDir(collectionPath, filePath) || SKIPPED_DIRS.has(file)) continue;
        folders.push({ name: file, pathname: filePath, seq: readFolderMeta(filePath, format).seq });
      } else {
        if (!isRequestFile(collectionPath, filePath, format)) continue;
        const scanned = scanRequest(filePath, format);
        if (scanned) requests.push({ ...scanned, pathname: filePath });
      }
    }

    for (const folder of folders.sort(bySeqThenName)) traverse(folder.pathname);
    for (const request of requests.sort(bySeqThenName)) {
      index.push({
        name: request.name,
        pathname: request.pathname,
        relativePath: path.relative(collectionPath, request.pathname),
        type: request.type,
        method: request.method,
        url: request.url
      });
    }
  };

  traverse(collectionPath);
  return index;
};

export interface FolderNode {
  name: string;
  path: string;
  requestCount: number;
  children: FolderNode[];
}

export const readFolderTree = (collectionPath: string): FolderNode[] => {
  const format = detectFormat(collectionPath);
  if (!format) {
    throw new Error(`Not a Bruno collection: ${collectionPath}`);
  }

  const requestPaths = readCollectionIndex(collectionPath).map((r) => r.relativePath);

  const traverse = (currentPath: string): FolderNode[] =>
    fs
      .readdirSync(currentPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !SKIPPED_DIRS.has(entry.name))
      .map((entry) => path.join(currentPath, entry.name))
      .filter((pathname) => !isInEnvironmentsDir(collectionPath, pathname))
      .map((pathname) => ({ name: path.basename(pathname), pathname, meta: readFolderMeta(pathname, format) }))
      .sort((a, b) => bySeqThenName({ name: a.name, seq: a.meta.seq }, { name: b.name, seq: b.meta.seq }))
      .map(({ name, pathname, meta }) => {
        const relativePath = path.relative(collectionPath, pathname);
        return {
          name: meta.name || name,
          path: relativePath,
          requestCount: requestPaths.filter((p) => p.startsWith(relativePath + path.sep)).length,
          children: traverse(pathname)
        };
      });

  return traverse(collectionPath);
};

export const directorySizeBytes = (dir: string): number =>
  fs.readdirSync(dir, { withFileTypes: true }).reduce((total, entry) => {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return SKIPPED_DIRS.has(entry.name) ? total : total + directorySizeBytes(entryPath);
    return total + fs.lstatSync(entryPath).size;
  }, 0);
