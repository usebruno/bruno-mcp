import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

import * as log from '../log.js';
import type { CollectionRunOptions, VariableOverrides } from '../types.js';
import { detectFormat, type CollectionFormat } from './readCollection.js';

const require = createRequire(import.meta.url);
const BRU_BIN: string = require.resolve('@usebruno/cli/bin/bru.js');

const DEFAULT_TIMEOUT_MS = 120 * 1000;
export const COLLECTION_TIMEOUT_MS = 10 * 60 * 1000;

let sessionTmpDir: string | null = null;

const getSessionTmpDir = (): string => {
  if (sessionTmpDir && fs.existsSync(sessionTmpDir)) return sessionTmpDir;
  sessionTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bruno-mcp-'));
  return sessionTmpDir;
};

export const cleanupSessionTmpDir = (): void => {
  if (sessionTmpDir) {
    try {
      fs.rmSync(sessionTmpDir, { recursive: true, force: true });
    } catch (_) { }
    sessionTmpDir = null;
  }
};

let cleanupRegistered = false;
const registerCleanup = (): void => {
  if (cleanupRegistered) return;
  cleanupRegistered = true;
  process.once('exit', cleanupSessionTmpDir);
};

// Build the `bru run` argv from the run options.
const buildRunArgs = (
  paths: string[],
  { environment, variables, iterations, dataFile, parallel, bail }: CollectionRunOptions = {},
  reportPath: string
): string[] => {
  const args = ['run', ...paths, '--reporter-json', reportPath];

  if (environment) args.push('--env', String(environment));
  if (iterations && !dataFile) args.push('--iteration-count', String(iterations));
  if (dataFile) {
    args.push(path.extname(dataFile).toLowerCase() === '.csv' ? '--csv-file-path' : '--json-file-path', dataFile);
  }
  if (parallel) args.push('--parallel');
  if (bail) args.push('--bail');

  if (variables && typeof variables === 'object') {
    for (const [name, value] of Object.entries(variables)) {
      // Name should not contain '=' as it will be split on the first '='
      if (String(name).includes('=')) {
        throw new Error(`variable name must not contain '=': ${name}`);
      }
      args.push('--env-var', `${name}=${value}`);
    }
  }

  return args;
};

const formatBody = (body: unknown): string | null => {
  if (body == null) return null;
  return typeof body === 'string' ? body : JSON.stringify(body);
};

const formatResponse = (response: any) => {
  if (!response) return null;
  return {
    status: response.status,
    statusText: response.statusText,
    responseTimeMs: response.responseTime,
    headers: response.headers || null,
    body: formatBody(response.data)
  };
};

const formatResultEntry = (entry: any) => {
  const rawRequest = entry && entry.request ? entry.request : null;
  const request = rawRequest
    ? { method: rawRequest.method, url: rawRequest.url ?? null, headers: rawRequest.headers || null }
    : null;
  const response = formatResponse(entry && entry.response ? entry.response : null);
  const responseOk = response && typeof response.status === 'number' && response.status > 0;
  return {
    path: (entry && entry.path) || null,
    ok: Boolean(responseOk),
    request,
    response,
    assertionResults: entry ? entry.assertionResults : null,
    testResults: entry ? entry.testResults : null,
    error: entry && entry.error ? entry.error : null
  };
};

const formatRunFailure = (
  exitCode: number | null,
  stderr: string,
  parseError: string | null,
  hasReport: boolean
): string => {
  const details = stderr.trim();
  if (parseError) {
    return `Could not parse the run report: ${parseError}${details ? `\n${details}` : ''}`;
  }
  if (details) return details;
  return hasReport
    ? `bru exited with code ${exitCode} but the report contained no results`
    : `bru exited with code ${exitCode} without producing a report`;
};

interface RawRunResult {
  exitCode: number | null;
  report: any;
  stderr: string;
  parseError: string | null;
}

const normalizeReport = (report: any): { entries: any[]; summary: any } => {
  const iterations = Array.isArray(report) ? report : [];
  const entries = iterations.flatMap((iteration) =>
    iteration && Array.isArray(iteration.results) ? iteration.results : []
  );
  const first = iterations[0];
  const summary = first && first.summary != null ? first.summary : null;
  return { entries, summary };
};

export const formatResult = ({ exitCode, report, stderr, parseError }: RawRunResult) => {
  const { entries, summary } = normalizeReport(report);
  const entry = formatResultEntry(entries.length > 0 ? entries[0] : null);
  const error =
    entry.error ?? (entries.length === 0 ? formatRunFailure(exitCode, stderr, parseError, report != null) : null);
  return {
    exitCode,
    ok: Boolean(exitCode === 0 && entry.ok),
    request: entry.request,
    response: entry.response,
    assertionResults: entry.assertionResults,
    testResults: entry.testResults,
    error,
    summary
  };
};

const CHECK_RESULT_KEYS = ['preRequestTestResults', 'assertionResults', 'testResults', 'postResponseTestResults'];

const failedChecksOf = (entry: any) =>
  CHECK_RESULT_KEYS.flatMap((key) => (Array.isArray(entry[key]) ? entry[key] : []))
    .filter((check: any) => check && check.status !== 'pass')
    .map((check: any) => ({
      name: check.description ?? `${check.lhsExpr}: ${check.rhsExpr}`,
      error: check.error ?? null
    }));

// The CLI strips `.bru` from report paths; restore it so they can be passed to get_request/execute_request.
const requestPathOf = (reportedPath: string | null, format: CollectionFormat | null): string | null => {
  if (!reportedPath || format !== 'bru' || path.extname(reportedPath) === '.bru') return reportedPath;
  return `${reportedPath}.bru`;
};

// Same pass/fail rules as the CLI's runner summary.
const outcomeOf = (entry: any, failedChecks: unknown[]): string => {
  if (entry.status === 'skipped') return 'skipped';
  if (failedChecks.length > 0) return 'failed';
  return entry.status === 'error' ? 'error' : 'passed';
};

// The CLI exits 0 when nothing ran: it takes the iteration count from the data file, and it silently
// skips paths missing from its collection tree.
const NO_ITERATIONS_ERROR =
  'Nothing ran: the data file has no rows. A CSV needs a header plus at least one row; a JSON data file must be a non-empty array of objects.';
const NO_REQUESTS_ERROR = 'Nothing ran: no runnable requests were found in the selection.';

const emptyRunError = (exitCode: number | null, report: unknown, iterationCount: number, stderr: string | null) => {
  if (exitCode !== 0 || !Array.isArray(report)) return stderr;
  return iterationCount === 0 ? NO_ITERATIONS_ERROR : NO_REQUESTS_ERROR;
};

const sumSummaries = (iterations: any[]): Record<string, number> => {
  const totals: Record<string, number> = {};
  for (const iteration of iterations) {
    for (const [key, value] of Object.entries(iteration?.summary || {})) {
      if (typeof value === 'number') totals[key] = (totals[key] || 0) + value;
    }
  }
  return totals;
};

export const formatRunResult = (
  { exitCode, report, stderr, stdout, reportParseError }: RawRunResult,
  format: CollectionFormat | null,
  durationMs: number
) => {
  const iterations: any[] = Array.isArray(report) ? report : [];
  const multiIteration = iterations.length > 1;
  const totals = sumSummaries(iterations);
  const ran = (totals.totalRequests || 0) > 0;
  const diagnostics = diagnosticsOf(stderr, stdout, reportParseError);

  const requests = iterations.flatMap((iteration) =>
    (Array.isArray(iteration?.results) ? iteration.results : []).map((entry: any) => {
      const failedChecks = failedChecksOf(entry);
      return {
        ...(multiIteration ? { iteration: iteration.iterationIndex } : {}),
        path: requestPathOf(entry.path ?? null, format),
        name: entry.name ?? null,
        outcome: outcomeOf(entry, failedChecks),
        status: typeof entry.response?.status === 'number' ? entry.response.status : null,
        responseTimeMs: entry.response?.responseTime ?? null,
        ...(failedChecks.length > 0 ? { failedChecks } : {}),
        ...(entry.error ? { error: entry.error } : {})
      };
    })
  );

  return {
    exitCode,
    ok: exitCode === 0 && ran,
    summary: {
      iterations: iterations.length,
      total: totals.totalRequests || 0,
      passed: totals.passedRequests || 0,
      failed: totals.failedRequests || 0,
      errored: totals.errorRequests || 0,
      skipped: totals.skippedRequests || 0,
      assertions: { passed: totals.passedAssertions || 0, failed: totals.failedAssertions || 0 },
      tests: {
        passed: (totals.passedTests || 0) + (totals.passedPreRequestTests || 0) + (totals.passedPostResponseTests || 0),
        failed: (totals.failedTests || 0) + (totals.failedPreRequestTests || 0) + (totals.failedPostResponseTests || 0)
      },
      durationMs
    },
    requests,
    error: ran ? null : emptyRunError(exitCode, report, iterations.length, diagnostics.stderr),
    diagnostics
  };
};

interface RunBruArgs {
  collectionPath: string;
  paths: string[];
  options?: CollectionRunOptions;
  extraArgs?: string[];
  verbose?: boolean;
  timeoutMs?: number;
}

// Spawn `bru run` for the given paths + options.
const runBru = async ({
  collectionPath,
  paths,
  options = {},
  extraArgs = [],
  timeoutMs = DEFAULT_TIMEOUT_MS
}: RunBruArgs): Promise<RawRunResult> => {
  const dir = getSessionTmpDir();
  registerCleanup();
  const reportPath = path.join(dir, `report-${crypto.randomBytes(8).toString('hex')}.json`);
  const args = [...buildRunArgs(paths, options, reportPath), ...extraArgs];

  log.debug(`spawn: node ${BRU_BIN} ${args.join(' ')} (cwd=${collectionPath})`);

  const stderrChunks: Buffer[] = [];
  const child = spawn(process.execPath, [BRU_BIN, ...args], {
    cwd: collectionPath,
    stdio: ['ignore', 'ignore', 'pipe']
  });

  child.stderr.on('data', (chunk) => stderrChunks.push(chunk));

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    // Kill the spawned bru process if it becomes unresponsive
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`bru run timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('exit', (code) => { clearTimeout(timer); resolve(code); });
  });

  const stderr = Buffer.concat(stderrChunks).toString('utf8');

  let report: any = null;
  let parseError: string | null = null;
  if (fs.existsSync(reportPath)) {
    try {
      report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    } catch (err: any) {
      parseError = err.message;
    } finally {
      try { fs.unlinkSync(reportPath); } catch (_) { }
    }
  }

  return { exitCode, report, stderr, parseError };
};

interface ExecuteRequestArgs {
  collectionPath: string;
  requestPath: string;
  environment?: string;
  variables?: VariableOverrides;
  timeoutMs?: number;
}

// Execute a single request with the given paths and options.
export const executeRequest = async ({
  collectionPath,
  requestPath,
  environment,
  variables,
  timeoutMs = DEFAULT_TIMEOUT_MS
}: ExecuteRequestArgs) => {
  const raw = await runBru({ collectionPath, paths: [requestPath], options: { environment, variables }, timeoutMs });
  return formatResult(raw);
};

interface RunCollectionArgs extends CollectionRunOptions {
  collectionPath: string;
  /** Request files and/or folders relative to the collection; empty runs the whole collection. */
  paths?: string[];
  verbose?: boolean;
  timeoutMs?: number;
}

export const runCollection = async ({
  collectionPath,
  paths = [],
  verbose = false,
  timeoutMs = COLLECTION_TIMEOUT_MS,
  ...options
}: RunCollectionArgs) => {
  const startedAt = Date.now();
  const raw = await runBru({
    collectionPath,
    paths,
    options,
    // The roll-up never returns headers or bodies, so keep them out of the report file too.
    extraArgs: ['-r', '--reporter-skip-body', '--reporter-skip-all-headers'],
    verbose,
    timeoutMs
  });
  return formatRunResult(raw, detectFormat(collectionPath), Date.now() - startedAt);
};
