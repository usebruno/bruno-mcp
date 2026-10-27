import fs from 'node:fs';
import path from 'node:path';
import { stringifyRequest } from '@usebruno/filestore';

import { SKIPPED_DIRS, isInEnvironmentsDir, isRequestFile, type CollectionFormat } from './readCollection.js';

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS', 'TRACE'] as const;
export const HTTP_REQUEST_TYPES = ['http-request', 'graphql-request'];

// Same as sanitizeName in @usebruno/common, so files get the names the Bruno app would give them.
export const sanitizeName = (name: string): string =>
  name
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '-')
    .replace(/^[\s-]+/, '')
    .replace(/[.\s]+$/, '');

export interface KeyValue {
  name: string;
  value: string;
  enabled?: boolean;
}

export type BodyEdit =
  | { mode: 'none' }
  | { mode: 'json'; json: string | Record<string, unknown> | unknown[] }
  | { mode: 'text'; text: string }
  | { mode: 'xml'; xml: string }
  | { mode: 'sparql'; sparql: string }
  | { mode: 'formUrlEncoded'; formUrlEncoded: KeyValue[] }
  | { mode: 'multipartForm'; multipartForm: KeyValue[] }
  | { mode: 'graphql'; graphql: { query: string; variables?: string } };

export type AuthEdit =
  | { mode: 'none' }
  | { mode: 'inherit' }
  | { mode: 'basic'; basic: { username: string; password: string } }
  | { mode: 'bearer'; bearer: { token: string } }
  | { mode: 'apikey'; apikey: { key: string; value: string; placement: 'header' | 'queryparams' } };

export interface RequestEdit {
  name?: string;
  method?: string;
  url?: string;
  headers?: KeyValue[];
  body?: BodyEdit;
  auth?: AuthEdit;
  assert?: KeyValue[];
}

const toKeyValue = ({ name, value, enabled }: KeyValue) => ({ name, value, enabled: enabled !== false });

export const newRequestItem = (name: string, graphql: boolean, seq: number): any => ({
  type: graphql ? 'graphql-request' : 'http-request',
  name,
  seq,
  settings: {},
  tags: [],
  request: {
    method: graphql ? 'POST' : 'GET',
    url: '',
    headers: [],
    params: [],
    body: graphql ? { mode: 'graphql', graphql: { query: '', variables: '' } } : { mode: 'none' },
    auth: { mode: 'inherit' },
    script: {},
    vars: {},
    assertions: [],
    tests: '',
    docs: ''
  }
});

const queryParamsFromUrl = (url: string) => {
  const query = url.split('#')[0].split('?').slice(1).join('?');
  return query
    .split('&')
    .filter(Boolean)
    .map((pair) => {
      const [name, ...value] = pair.split('=');
      return { name, value: value.join('='), type: 'query', enabled: true };
    });
};

// Bruno keeps query params mirrored from the URL, and path params (`:id`) keyed by name; the CLI reads both.
const paramsForUrl = (params: any[], url: string) => {
  const pathNames = [...url.split(/[?#]/)[0].matchAll(/\/:([^/]+)/g)].map((m) => m[1]);
  const pathParams = pathNames.map(
    (name) => params.find((p) => p.type === 'path' && p.name === name) ?? { name, value: '', type: 'path', enabled: true }
  );
  const disabledQuery = params.filter((p) => p.type === 'query' && p.enabled === false);
  return [...queryParamsFromUrl(url), ...disabledQuery, ...pathParams];
};

const bodyFields = (body: BodyEdit): Record<string, unknown> => {
  switch (body.mode) {
    case 'json':
      return { mode: 'json', json: typeof body.json === 'string' ? body.json : JSON.stringify(body.json, null, 2) };
    case 'formUrlEncoded':
      return { mode: body.mode, formUrlEncoded: body.formUrlEncoded.map(toKeyValue) };
    case 'multipartForm':
      return { mode: body.mode, multipartForm: body.multipartForm.map((f) => ({ ...toKeyValue(f), type: 'text', contentType: '' })) };
    case 'graphql':
      return { mode: body.mode, graphql: { query: body.graphql.query, variables: body.graphql.variables ?? '' } };
    default:
      return { ...body };
  }
};

export const requestEditError = (type: string, edit: RequestEdit): string | null => {
  if (!HTTP_REQUEST_TYPES.includes(type)) {
    return `write_request only edits HTTP and GraphQL requests; this one is a ${type}.`;
  }
  if (edit.body && (edit.body.mode === 'graphql') !== (type === 'graphql-request')) {
    return type === 'graphql-request'
      ? 'A GraphQL request only takes a body with mode "graphql".'
      : 'A body with mode "graphql" needs a GraphQL request; create a new request with that body instead.';
  }
  return null;
};

// Fields left out of the edit keep their current value; other body and auth modes' data is kept, as the app does.
export const applyRequestEdit = (item: any, edit: RequestEdit): any => {
  const request = { ...item.request };
  if (edit.method) request.method = edit.method.toUpperCase();
  if (edit.url !== undefined) {
    request.url = edit.url;
    request.params = paramsForUrl(request.params || [], edit.url);
  }
  if (edit.headers) request.headers = edit.headers.map(toKeyValue);
  if (edit.body) request.body = { ...request.body, ...bodyFields(edit.body) };
  if (edit.auth) request.auth = { ...request.auth, ...edit.auth };
  if (edit.assert) request.assertions = edit.assert.map(toKeyValue);
  return { ...item, ...(edit.name ? { name: edit.name } : {}), request };
};

export const serializeRequest = (item: any, format: CollectionFormat): string => stringifyRequest(item, { format });

// The app numbers a new item after every folder and request already beside it.
export const nextSeq = (dir: string, collectionPath: string, format: CollectionFormat): number => {
  if (!fs.existsSync(dir)) return 1;
  const siblings = fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return !SKIPPED_DIRS.has(entry.name) && !isInEnvironmentsDir(collectionPath, entryPath);
    return isRequestFile(collectionPath, entryPath, format);
  });
  return siblings.length + 1;
};

export const SCRIPT_TYPES = ['pre-request', 'post-response', 'tests'] as const;
export type ScriptType = (typeof SCRIPT_TYPES)[number];

const SCRIPT_KEYS: Record<Exclude<ScriptType, 'tests'>, 'req' | 'res'> = { 'pre-request': 'req', 'post-response': 'res' };

export const readScript = (item: any, type: ScriptType): string =>
  (type === 'tests' ? item.request?.tests : item.request?.script?.[SCRIPT_KEYS[type]]) || '';

export const withScript = (item: any, type: ScriptType, code: string): any => {
  const request = { ...item.request };
  if (type === 'tests') request.tests = code;
  else request.script = { ...request.script, [SCRIPT_KEYS[type]]: code };
  return { ...item, request };
};
