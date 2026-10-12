import type { BrowserContext, Page } from 'playwright';
import type { FailedRequest, BadResponse } from '../report/report-types';

export interface NetworkCapture {
  failedRequests: FailedRequest[];
  badResponses: BadResponse[];
}

export function setupPageNetworkCapture(page: Page): NetworkCapture {
  const result: NetworkCapture = {
    failedRequests: [],
    badResponses: [],
  };

  page.on('requestfailed', (request) => {
    result.failedRequests.push({
      url: request.url(),
      method: request.method(),
      failure: request.failure()?.errorText || 'unknown',
    });
  });

  page.on('response', (response) => {
    if (response.status() >= 400) {
      result.badResponses.push({
        url: response.url(),
        method: response.request().method(),
        status: response.status(),
        statusText: response.statusText(),
      });
    }
  });

  return result;
}

/** Set up context-level network capture that catches requests from all
 * pages, service workers, and extension pages. This is the preferred approach
 * over page-level capture since it catches extension-originated requests. */
export function setupContextNetworkCapture(
  context: BrowserContext,
): NetworkCapture {
  const result: NetworkCapture = {
    failedRequests: [],
    badResponses: [],
  };

  // Also capture from any new page created after setup
  context.on('page', (page) => {
    const pageCap = setupPageNetworkCapture(page);
    // Merge on the fly
    const origPush = pageCap.failedRequests.push.bind(result.failedRequests);
    page.on('requestfailed', (request) => {
      origPush({
        url: request.url(),
        method: request.method(),
        failure: request.failure()?.errorText || 'unknown',
      });
    });
    page.on('response', (response) => {
      if (response.status() >= 400) {
        result.badResponses.push({
          url: response.url(),
          method: response.request().method(),
          status: response.status(),
          statusText: response.statusText(),
        });
      }
    });
  });

  return result;
}

export function mergeNetworkCaptures(
  captures: NetworkCapture[],
): NetworkCapture {
  const failedRequests: FailedRequest[] = [];
  const badResponses: BadResponse[] = [];
  const seenFailed = new Set<string>();
  const seenBad = new Set<string>();

  for (const cap of captures) {
    for (const req of cap.failedRequests) {
      const key = `${req.method}:${req.url}`;
      if (!seenFailed.has(key)) {
        seenFailed.add(key);
        failedRequests.push(req);
      }
    }
    for (const res of cap.badResponses) {
      const key = `${res.method}:${res.url}:${res.status}`;
      if (!seenBad.has(key)) {
        seenBad.add(key);
        badResponses.push(res);
      }
    }
  }

  return { failedRequests, badResponses };
}

/** Categorize a failure for diagnostics */
export function categorizeFailure(
  url: string,
  errorText: string,
): 'cors' | 'dns' | 'timeout' | 'blocked' | 'other' {
  const lower = errorText.toLowerCase();
  if (lower.includes('cors') || lower.includes('blockedbyclientpolicy')) {
    return 'cors';
  }
  if (lower.includes('dns') || lower.includes('name_not_resolved')) {
    return 'dns';
  }
  if (lower.includes('timeout') || lower.includes('timed_out')) {
    return 'timeout';
  }
  if (lower.includes('blocked') || lower.includes('aborted')) {
    return 'blocked';
  }
  return 'other';
}
