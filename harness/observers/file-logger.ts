import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import type { ConsoleEntry, NetworkReport } from '../report/report-types.js';

/**
 * Save console log entries to a file.
 * Format: [timestamp] [level] message
 * Returns the file path.
 */
export function saveConsoleLog(
  entries: ConsoleEntry[],
  outDir: string,
  prefix: string,
): string {
  mkdirSync(outDir, { recursive: true });

  const filePath = join(outDir, `${prefix}-console.log`);
  const lines = entries.map(
    (entry) => `[${entry.timestamp}] [${entry.level}] ${entry.text}`,
  );
  writeFileSync(filePath, lines.join('\n') + '\n', 'utf-8');
  return filePath;
}

/**
 * Save network report (failed requests and bad responses) to a file.
 * Failed requests appear first, then bad responses.
 * Returns the file path.
 */
export function saveNetworkLog(network: NetworkReport, outDir: string): string {
  mkdirSync(outDir, { recursive: true });

  const filePath = join(outDir, 'network.log');
  const lines: string[] = [];

  for (const req of network.failedRequests) {
    lines.push(`[FAIL] ${req.method} ${req.url} — ${req.failure}`);
  }

  for (const res of network.badResponses) {
    lines.push(`[HTTP ${res.status}] ${res.method} ${res.url}`);
  }

  writeFileSync(filePath, lines.join('\n') + '\n', 'utf-8');
  return filePath;
}

/**
 * Save all console logs and network log.
 * Iterates over results, calling saveConsoleLog for each, then saveNetworkLog.
 */
export function saveAllLogs(
  results: { console: ConsoleEntry[]; prefix: string }[],
  network: NetworkReport,
  outDir: string,
): void {
  for (const result of results) {
    saveConsoleLog(result.console, outDir, result.prefix);
  }
  saveNetworkLog(network, outDir);
}
