import path from 'node:path';
import fs from 'node:fs';
import { parseEnvironment, stringifyEnvironment } from '@usebruno/filestore';
import { isMap, isSeq, parseDocument, type YAMLMap, type YAMLSeq } from 'yaml';

import type { EnvironmentVariable } from '../types.js';
import { ENVIRONMENTS_DIR, detectFormat, FORMAT_FILES, type CollectionFormat } from './readCollection.js';

export const REDACTED = '<redacted>';

export interface EnvironmentFile {
  name: string;
  path: string;
  format: CollectionFormat;
}

export const listEnvironmentFiles = (collectionPath: string): EnvironmentFile[] => {
  const format = detectFormat(collectionPath);
  const envDir = path.join(collectionPath, ENVIRONMENTS_DIR);
  if (!format || !fs.existsSync(envDir)) return [];
  const { ext } = FORMAT_FILES[format];
  return fs
    .readdirSync(envDir)
    .filter((file) => path.extname(file) === ext)
    .map((file) => ({ name: path.basename(file, ext), path: path.join(envDir, file), format }));
};

// Secret values never leave the server, only their names.
export const readEnvironmentVariables = async (env: EnvironmentFile): Promise<EnvironmentVariable[]> => {
  // Awaited because the .bru parser returns a rejected promise on malformed files instead of throwing.
  const parsed = await parseEnvironment(fs.readFileSync(env.path, 'utf8'), { format: env.format });
  const variables: any[] = Array.isArray(parsed?.variables) ? parsed.variables : [];
  return variables.map((v) => ({
    name: String(v.name),
    value: v.secret ? REDACTED : v.value ?? null,
    enabled: v.enabled !== false,
    secret: Boolean(v.secret)
  }));
};

export const VARIABLE_NAME_PATTERN = /^[\w.-]+$/;

export interface VariableUpdate {
  name: string;
  value: string;
  enabled: boolean;
  secret: boolean;
}

// yml environments are edited in place: the yml serializer drops comments and in-file secret values.
const loadYmlVariables = (content: string) => {
  const doc = parseDocument(content);
  if (doc.errors.length > 0) throw new Error(doc.errors[0].message);
  if (!isSeq(doc.get('variables'))) doc.set('variables', doc.createNode([]));
  const seq = doc.get('variables') as YAMLSeq;
  const indexOf = (name: string) => seq.items.findIndex((item) => isMap(item) && item.get('name') === name);
  return { doc, seq, indexOf };
};

// Bruno keeps secret values out of collection files, so a secret variable is written by name only.
export const setEnvironmentVariable = async (env: EnvironmentFile, update: VariableUpdate): Promise<string> => {
  const { name, value, enabled, secret } = update;
  const content = fs.readFileSync(env.path, 'utf8');

  if (env.format === 'bru') {
    const parsed = await parseEnvironment(content, { format: 'bru' });
    const variables: any[] = Array.isArray(parsed?.variables) ? parsed.variables : [];
    const next = { name, value, enabled, secret, type: 'text' };
    const index = variables.findIndex((v) => v.name === name);
    if (index === -1) variables.push(next);
    else variables[index] = { ...variables[index], ...next };
    return stringifyEnvironment({ ...parsed, variables }, { format: 'bru' });
  }

  const { doc, seq, indexOf } = loadYmlVariables(content);
  let item = seq.items[indexOf(name)] as YAMLMap | undefined;
  if (!item) {
    item = doc.createNode({ name }) as YAMLMap;
    seq.add(item);
  }
  if (secret) {
    item.delete('value');
    item.set('secret', true);
  } else {
    item.set('value', value);
    item.delete('secret');
  }
  if (enabled) item.delete('disabled');
  else item.set('disabled', true);
  return doc.toString();
};

// Returns null when the variable isn't there, so nothing needs writing.
export const removeEnvironmentVariable = async (env: EnvironmentFile, name: string): Promise<string | null> => {
  const content = fs.readFileSync(env.path, 'utf8');

  if (env.format === 'bru') {
    const parsed = await parseEnvironment(content, { format: 'bru' });
    const variables: any[] = Array.isArray(parsed?.variables) ? parsed.variables : [];
    if (!variables.some((v) => v.name === name)) return null;
    return stringifyEnvironment({ ...parsed, variables: variables.filter((v) => v.name !== name) }, { format: 'bru' });
  }

  const { doc, seq, indexOf } = loadYmlVariables(content);
  const index = indexOf(name);
  if (index === -1) return null;
  seq.items.splice(index, 1);
  return doc.toString();
};
