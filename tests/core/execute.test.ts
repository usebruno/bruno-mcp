import { describe, expect, it } from '@jest/globals';

import { formatRunResult } from '../../src/core/execute.js';

const rawRun = (report: unknown, exitCode = 0, stderr = '') => ({
  exitCode,
  report,
  stderr,
  parseError: null
});

const summary = (overrides: Record<string, number> = {}) => ({
  totalRequests: 0,
  passedRequests: 0,
  failedRequests: 0,
  errorRequests: 0,
  skippedRequests: 0,
  totalAssertions: 0,
  passedAssertions: 0,
  failedAssertions: 0,
  totalTests: 0,
  passedTests: 0,
  failedTests: 0,
  passedPreRequestTests: 0,
  failedPreRequestTests: 0,
  passedPostResponseTests: 0,
  failedPostResponseTests: 0,
  ...overrides
});

const entry = (overrides: Record<string, unknown>) => ({
  status: 'pass',
  response: { status: 200, responseTime: 10 },
  assertionResults: [],
  testResults: [],
  preRequestTestResults: [],
  postResponseTestResults: [],
  iterationIndex: 0,
  ...overrides
});

describe('formatRunResult', () => {
  it('rolls up each request with its outcome and failed checks', () => {
    const report = [
      {
        iterationIndex: 0,
        summary: summary({ totalRequests: 5, passedRequests: 1, failedRequests: 2, errorRequests: 1, skippedRequests: 1 }),
        results: [
          entry({
            path: 'users/get-user',
            name: 'Get user',
            assertionResults: [{ lhsExpr: 'res.status', rhsExpr: 'eq 200', status: 'pass' }],
            testResults: [{ description: 'returns the user', status: 'pass' }]
          }),
          entry({
            path: 'users/missing-user',
            name: 'Missing user',
            response: { status: 404, responseTime: 8 },
            assertionResults: [
              { lhsExpr: 'res.status', rhsExpr: 'eq 200', status: 'fail', error: 'expected 404 to equal 200' }
            ]
          }),
          entry({
            path: 'scripted',
            name: 'Scripted',
            postResponseTestResults: [
              { description: 'Post-Response Script Error', status: 'fail', error: 'boom', isScriptError: true }
            ]
          }),
          entry({
            path: 'down',
            name: 'Down',
            status: 'error',
            error: 'connect ECONNREFUSED',
            response: { status: 'error', responseTime: 0 }
          }),
          entry({
            path: 'health',
            name: 'Health',
            status: 'skipped',
            skipReason: 'bail',
            response: { status: 'skipped', responseTime: 0 }
          })
        ]
      }
    ];

    const result = formatRunResult(rawRun(report, 1), 'bru', 1234);

    expect(result.ok).toBe(false);
    expect(result.requests).toEqual([
      { path: 'users/get-user.bru', name: 'Get user', outcome: 'passed', status: 200, responseTimeMs: 10 },
      {
        path: 'users/missing-user.bru',
        name: 'Missing user',
        outcome: 'failed',
        status: 404,
        responseTimeMs: 8,
        failedChecks: [{ name: 'res.status: eq 200', error: 'expected 404 to equal 200' }]
      },
      {
        path: 'scripted.bru',
        name: 'Scripted',
        outcome: 'failed',
        status: 200,
        responseTimeMs: 10,
        failedChecks: [{ name: 'Post-Response Script Error', error: 'boom' }]
      },
      {
        path: 'down.bru',
        name: 'Down',
        outcome: 'error',
        status: null,
        responseTimeMs: 0,
        error: 'connect ECONNREFUSED'
      },
      { path: 'health.bru', name: 'Health', outcome: 'skipped', status: null, responseTimeMs: 0 }
    ]);
    expect(result.summary).toMatchObject({ total: 5, passed: 1, failed: 2, errored: 1, skipped: 1, durationMs: 1234 });
  });

  it('keeps the extension the CLI already reports for .yml collections', () => {
    const report = [{ iterationIndex: 0, summary: summary(), results: [entry({ path: 'users/get-user.yml', name: 'Get user' })] }];

    expect(formatRunResult(rawRun(report), 'yml', 0).requests[0].path).toBe('users/get-user.yml');
  });

  it('sums summaries across iterations and tags each request with its iteration', () => {
    const iteration = (iterationIndex: number) => ({
      iterationIndex,
      summary: summary({
        totalRequests: 1,
        passedRequests: 1,
        totalAssertions: 1,
        passedAssertions: 1,
        passedTests: 1,
        passedPreRequestTests: 1,
        passedPostResponseTests: 1
      }),
      results: [entry({ path: 'health', name: 'Health', iterationIndex })]
    });

    const result = formatRunResult(rawRun([iteration(0), iteration(1)]), 'bru', 0);

    expect(result.ok).toBe(true);
    expect(result.summary).toMatchObject({
      iterations: 2,
      total: 2,
      passed: 2,
      assertions: { passed: 2, failed: 0 },
      tests: { passed: 6, failed: 0 }
    });
    expect(result.requests.map((r: any) => r.iteration)).toEqual([0, 1]);
  });

  it('tags skipped-file entries, which carry no iterationIndex, with their iteration', () => {
    const { iterationIndex: _, ...skippedFile } = entry({ path: 'broken.bru', name: 'broken.bru', status: 'skipped' });
    const report = [0, 1].map((iterationIndex) => ({
      iterationIndex,
      summary: summary({ totalRequests: 1, skippedRequests: 1 }),
      results: [skippedFile]
    }));

    expect(formatRunResult(rawRun(report), 'bru', 0).requests.map((r: any) => r.iteration)).toEqual([0, 1]);
  });

  it('is not ok when the CLI ran no requests, even with a zero exit code', () => {
    const report = [{ iterationIndex: 0, summary: summary(), results: [] }];

    const result = formatRunResult(rawRun(report, 0), 'bru', 5);

    expect(result.ok).toBe(false);
    expect(result.error).toBe('Nothing ran: no runnable requests were found in the selection.');
  });

  it('omits the iteration field for a single iteration', () => {
    const report = [{ iterationIndex: 0, summary: summary(), results: [entry({ path: 'health', name: 'Health' })] }];

    expect(formatRunResult(rawRun(report), 'bru', 0).requests[0]).not.toHaveProperty('iteration');
  });

  it('explains an empty report from a data file with no rows', () => {
    const result = formatRunResult(rawRun([], 0), 'bru', 5);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/^Nothing ran: the data file has no rows/);
  });

  it('surfaces stderr as the error when the CLI produced no report', () => {
    const result = formatRunResult(rawRun(null, 1, 'Path not found: /x/nope.bru\n'), 'bru', 5);

    expect(result.ok).toBe(false);
    expect(result.error).toBe('Path not found: /x/nope.bru');
    expect(result.requests).toEqual([]);
    expect(result.summary).toMatchObject({ iterations: 0, total: 0 });
  });
});
