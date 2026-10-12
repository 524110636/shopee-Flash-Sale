/**
 * repair-loop.ts — 修复循环编排脚本
 *
 * 编排完整的 AI 修复循环流程:
 *   1. (可选) 运行 `npm run build` 构建扩展
 *   2. 运行 `npm run harness`
 *   3. 读取 `.harness/latest-report.json`
 *   4. 分析结果，输出结构化的修复建议
 *   5. (可选) 保存本次报告用于后续对比
 *
 * 用法:
 *   npx tsx harness/scripts/repair-loop.ts --run [options]
 *   npx tsx harness/scripts/repair-loop.ts --report <path>
 *   npx tsx harness/scripts/repair-loop.ts --help
 *
 * 退出码:
 *   0 — 无阻断错误
 *   1 — 有阻断错误
 *   2 — 脚本自身失败
 */

import { exec } from 'child_process';
import {
  existsSync,
  readFileSync,
  copyFileSync,
  mkdirSync,
  writeFileSync,
} from 'fs';
import { resolve } from 'path';
import { randomUUID } from 'crypto';
import { promisify } from 'util';

const execAsync = promisify(exec);
const ROOT = process.cwd();

// =============================================================================
// Types
// =============================================================================

interface StepResult {
  name: string;
  status: 'success' | 'failed' | 'skipped';
  duration: number;
  output: string;
  exitCode?: number;
  suggestions?: Suggestion[];
}

interface Suggestion {
  severity: 'error' | 'warning' | 'info';
  category: string;
  message: string;
  details: string[];
  actions: string[];
}

interface DiagnosticsLike {
  status?: string;
  summary?: string[];
  probableCauses?: string[];
  suggestedNextChecks?: string[];
  [key: string]: unknown;
}

interface RepairLoopReport {
  loopId: string;
  timestamp: string;
  steps: StepResult[];
  diagnostics: Record<string, unknown>;
  reportPath: string;
  previousReportPath: string;
  previousReportAvailable: boolean;
}

interface Config {
  mode: 'run' | 'report';
  reportPath: string;
  skipBuild: boolean;
  harnessArgs: string[];
  outDir: string;
}

// =============================================================================
// Argument Parsing
// =============================================================================

function showHelp(): void {
  console.log(`
Usage:
  npx tsx harness/scripts/repair-loop.ts --run [options]
  npx tsx harness/scripts/repair-loop.ts --report <path>
  npx tsx harness/scripts/repair-loop.ts --help

Modes:
  --run                  Run full cycle: build -> harness -> analyze (default if --run given)
  --report <path>        Analyze existing report only

Options:
  --build                Enable build step (default)
  --no-build             Skip build step
  --help                 Show this help message

Pass-through (forwarded to harness CLI):
  --headed               Run browser in headed mode
  --extension <path>     Extension build directory
  --target <url>         Target page URL
  --timeout <ms>         Global timeout in ms
  --popup-wait <ms>      Popup observation time in ms
  --out <dir>            Output directory (default: .harness)

Examples:
  npx tsx harness/scripts/repair-loop.ts --run
  npx tsx harness/scripts/repair-loop.ts --run --headed --extension .output/chrome-mv3 --target https://seller.shopee.tw
  npx tsx harness/scripts/repair-loop.ts --run --no-build
  npx tsx harness/scripts/repair-loop.ts --report .harness/latest-report.json
`);
}

/**
 * Parse CLI arguments. Returns a Config object and a showHelp boolean.
 * Exits with code 2 on invalid arguments.
 */
function parseArgs(): { config: Config; showHelp: boolean } {
  const args = process.argv.slice(2);
  let mode: 'run' | 'report' | undefined;
  let reportPath = '';
  let skipBuild = false;
  let showHelpFlag = false;
  const harnessArgs: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--help') {
      showHelpFlag = true;
      continue;
    }

    if (arg === '--run') {
      mode = 'run';
      continue;
    }

    if (arg === '--report') {
      if (i + 1 >= args.length || args[i + 1].startsWith('--')) {
        console.error('Error: --report requires a file path argument.');
        process.exit(2);
      }
      mode = 'report';
      reportPath = args[++i];
      continue;
    }

    if (arg === '--no-build') {
      skipBuild = true;
      continue;
    }

    if (arg === '--build') {
      // explicit --build, same as default (skipBuild stays false)
      continue;
    }

    // Pass-through: capture flag and its value (if next token is not a flag)
    harnessArgs.push(arg);
    if (i + 1 < args.length && !args[i + 1].startsWith('--')) {
      harnessArgs.push(args[++i]);
    }
  }

  // Detect --out from harness args to know where the report lives
  let outDir = '.harness';
  for (let i = 0; i < harnessArgs.length; i++) {
    if (harnessArgs[i] === '--out' && i + 1 < harnessArgs.length) {
      outDir = harnessArgs[i + 1];
      break;
    }
  }

  if (!showHelpFlag && !mode) {
    console.error('Error: either --run or --report is required.');
    console.error('Run with --help for usage information.');
    process.exit(2);
  }

  return {
    config: {
      mode: mode || 'run',
      reportPath,
      skipBuild,
      harnessArgs,
      outDir,
    },
    showHelp: showHelpFlag,
  };
}

// =============================================================================
// Command Execution
// =============================================================================

/**
 * Execute a shell command and return a structured step result.
 */
async function runStep(
  name: string,
  command: string,
): Promise<StepResult> {
  const start = Date.now();
  console.log(`\n[repair-loop] Starting step: ${name}`);
  console.log(`[repair-loop] Command: ${command}`);

  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: ROOT,
      maxBuffer: 10 * 1024 * 1024, // 10 MB
      shell: true,
    });

    const duration = Date.now() - start;
    const output = (stdout + stderr).trim();

    if (output) {
      console.log(`\n${output}`);
    }

    console.log(`[repair-loop] Step "${name}" completed in ${duration}ms`);
    return { name, status: 'success', duration, output, exitCode: 0 };
  } catch (err: unknown) {
    const duration = Date.now() - start;
    const error = err as {
      stdout?: string;
      stderr?: string;
      code?: number;
      status?: number;
      message?: string;
    };
    const stdoutChunk = error.stdout || '';
    const stderrChunk = error.stderr || '';
    const output = (stdoutChunk + '\n' + stderrChunk).trim();
    const exitCode = error.code ?? error.status ?? 1;

    console.error(`\n[repair-loop] Step "${name}" FAILED (exit code ${exitCode})`);
    if (output) {
      console.error(output);
    }
    console.error(`[repair-loop] Duration: ${duration}ms`);

    return { name, status: 'failed', duration, output, exitCode };
  }
}

// =============================================================================
// Analysis
// =============================================================================

/**
 * Categorize a diagnostic message into a suggestion category.
 */
function categorizeSuggestion(message: string): string {
  const lower = message.toLowerCase();
  if (lower.includes('service worker') || lower === 'sw') {
    return 'service-worker';
  }
  if (lower.includes('popup')) {
    return 'popup';
  }
  if (lower.includes('target page') || (lower.includes('target') && !lower.includes('content'))) {
    return 'target-page';
  }
  if (lower.includes('content script')) {
    return 'content-script';
  }
  if (
    lower.includes('cors') ||
    lower.includes('network') ||
    lower.includes('request') ||
    lower.includes('failed req') ||
    lower.includes('bad resp') ||
    lower.includes('server error')
  ) {
    return 'network';
  }
  if (lower.includes('spc_cds') || lower.includes('authentic') || lower.includes('401') || lower.includes('403')) {
    return 'authentication';
  }
  if (lower.includes('visual') || lower.includes('screenshot') || lower.includes('diff')) {
    return 'visual';
  }
  if (lower.includes('build')) {
    return 'build';
  }
  return 'general';
}

/**
 * Transform raw diagnostics into structured, actionable suggestions.
 */
function generateSuggestions(diagnostics: DiagnosticsLike): Suggestion[] {
  const status = diagnostics.status ?? 'error';
  const summary: string[] = diagnostics.summary ?? [];
  const probableCauses: string[] = diagnostics.probableCauses ?? [];
  const suggestedNextChecks: string[] = diagnostics.suggestedNextChecks ?? [];

  const suggestions: Suggestion[] = [];

  for (const msg of summary) {
    if (msg === 'All checks passed') {
      suggestions.push({
        severity: 'info',
        category: 'general',
        message: msg,
        details: [],
        actions: [],
      });
      continue;
    }

    const severity =
      status === 'error' || status === 'harness-error'
        ? 'error'
        : status === 'warning'
          ? 'warning'
          : 'info';

    suggestions.push({
      severity,
      category: categorizeSuggestion(msg),
      message: msg,
      details: [...probableCauses],
      actions: [...suggestedNextChecks],
    });
  }

  if (suggestions.length === 0) {
    suggestions.push({
      severity: status === 'error' || status === 'harness-error' ? 'warning' : 'info',
      category: 'general',
      message:
        status === 'pass'
          ? 'All checks passed'
          : `Diagnostic status: ${status}, but no specific summaries were reported.`,
      details: [...probableCauses],
      actions: [...suggestedNextChecks],
    });
  }

  return suggestions;
}

/**
 * Read and parse a JSON report file.
 */
function readReportFile(filePath: string): Record<string, unknown> {
  const resolvedPath = resolve(ROOT, filePath);
  if (!existsSync(resolvedPath)) {
    throw new Error(`Report file not found: ${resolvedPath}`);
  }
  const raw = readFileSync(resolvedPath, 'utf-8');
  return JSON.parse(raw) as Record<string, unknown>;
}

// =============================================================================
// Main
// =============================================================================

async function main(): Promise<number> {
  const { config, showHelp: showHelpFlag } = parseArgs();

  if (showHelpFlag) {
    showHelp();
    return 0;
  }

  const loopId = randomUUID();
  const timestamp = new Date().toISOString();
  const steps: StepResult[] = [];
  let diagnostics: DiagnosticsLike = {};
  let reportPath = '';
  const previousReportPath = `${config.outDir}/previous-report.json`;
  let previousReportAvailable = false;
  let hasBlockingError = false;

  // ================================================================
  // RUN mode
  // ================================================================
  if (config.mode === 'run') {
    // --- Back up existing report -------------------------------------------------
    const latestReportPath = resolve(ROOT, `${config.outDir}/latest-report.json`);

    if (existsSync(latestReportPath)) {
      try {
        const prevPath = resolve(ROOT, previousReportPath);
        copyFileSync(latestReportPath, prevPath);
        previousReportAvailable = true;
        console.log(
          `[repair-loop] Backed up existing report -> ${previousReportPath}`,
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[repair-loop] Warning: could not back up previous report: ${msg}`);
      }
    }

    // --- Build step --------------------------------------------------------------
    if (config.skipBuild) {
      steps.push({
        name: 'build',
        status: 'skipped',
        duration: 0,
        output: 'Build step skipped via --no-build',
      });
      console.log('[repair-loop] Build step skipped');
    } else {
      const buildResult = await runStep('build', 'npm run build');
      steps.push(buildResult);
      if (buildResult.status === 'failed') {
        hasBlockingError = true;
      }
    }

    // --- Harness step -----------------------------------------------------------
    const harnessCmd =
      config.harnessArgs.length > 0
        ? `npm run harness -- ${config.harnessArgs.join(' ')}`
        : 'npm run harness';

    const harnessResult = await runStep('harness', harnessCmd);
    steps.push(harnessResult);
    if (harnessResult.status === 'failed') {
      hasBlockingError = true;
    }

    // --- Read report ------------------------------------------------------------
    reportPath = `${config.outDir}/latest-report.json`;
    const fullReportPath = resolve(ROOT, reportPath);

    if (existsSync(fullReportPath)) {
      try {
        const report = readReportFile(fullReportPath);
        diagnostics = (report.diagnostics as DiagnosticsLike) ?? {};

        if (
          diagnostics.status === 'error' ||
          diagnostics.status === 'harness-error'
        ) {
          hasBlockingError = true;
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[repair-loop] Warning: could not read report: ${msg}`);
        diagnostics = {
          status: 'harness-error',
          summary: [`Failed to read harness report: ${msg}`],
        };
        hasBlockingError = true;
      }
    } else {
      console.warn(
        `[repair-loop] Warning: report not found at ${fullReportPath}`,
      );
      diagnostics = {
        status: 'harness-error',
        summary: ['No report file was found after the harness step completed.'],
        probableCauses: [
          'The harness may have crashed before writing the report, or the --out path differs from the default .harness.',
        ],
        suggestedNextChecks: [
          'Check harness output above for error messages.',
          'Verify the --out argument matches the harness output directory.',
        ],
      };
      hasBlockingError = true;
    }
  }

  // ================================================================
  // REPORT-only mode
  // ================================================================
  if (config.mode === 'report') {
    reportPath = config.reportPath;
    const resolvedReportPath = resolve(ROOT, config.reportPath);

    if (!existsSync(resolvedReportPath)) {
      console.error(`Error: report file not found: ${resolvedReportPath}`);
      return 2;
    }

    try {
      const report = readReportFile(config.reportPath);
      diagnostics = (report.diagnostics as DiagnosticsLike) ?? {};

      if (
        diagnostics.status === 'error' ||
        diagnostics.status === 'harness-error'
      ) {
        hasBlockingError = true;
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Error: cannot parse report file: ${msg}`);
      return 2;
    }

    // Check for previous report for context
    const defaultPrevPath = resolve(ROOT, '.harness/previous-report.json');
    if (existsSync(defaultPrevPath)) {
      previousReportAvailable = true;
    }
  }

  // ================================================================
  // Analyze step
  // ================================================================
  const analyzeStart = Date.now();
  const suggestions = generateSuggestions(diagnostics);
  const analyzeDuration = Date.now() - analyzeStart;

  steps.push({
    name: 'analyze',
    status: 'success',
    duration: analyzeDuration,
    output: `Generated ${suggestions.length} suggestion(s)`,
    suggestions,
  });

  // ================================================================
  // Write final report
  // ================================================================
  const finalReport: RepairLoopReport = {
    loopId,
    timestamp,
    steps,
    diagnostics: diagnostics as Record<string, unknown>,
    reportPath,
    previousReportPath,
    previousReportAvailable,
  };

  const outDir = resolve(ROOT, '.harness');
  if (!existsSync(outDir)) {
    mkdirSync(outDir, { recursive: true });
  }

  const finalReportPath = resolve(outDir, 'repair-loop-report.json');
  writeFileSync(finalReportPath, JSON.stringify(finalReport, null, 2), 'utf-8');

  // ================================================================
  // Summary
  // ================================================================
  console.log('\n========== Repair Loop Summary ==========');
  console.log(`  Loop ID:        ${loopId}`);
  console.log(`  Mode:           ${config.mode}`);
  console.log(`  Report:         ${finalReportPath}`);
  console.log('');

  for (const step of steps) {
    const icon =
      step.status === 'success' ? '  OK' : step.status === 'skipped' ? '  --' : 'FAIL';
    const extra =
      step.exitCode !== undefined ? ` (exit ${step.exitCode})` : '';
    const sug =
      step.suggestions !== undefined
        ? `, ${step.suggestions.length} suggestion(s)`
        : '';
    console.log(`  [${icon}] ${step.name}${extra} — ${step.duration}ms${sug}`);
  }

  const errorCount = suggestions.filter((s) => s.severity === 'error').length;
  const warnCount = suggestions.filter((s) => s.severity === 'warning').length;

  if (suggestions.length > 0) {
    console.log('');
    console.log('  Suggestions:');

    if (errorCount > 0) {
      console.log(`    Errors:   ${errorCount}`);
    }
    if (warnCount > 0) {
      console.log(`    Warnings: ${warnCount}`);
    }

    for (const s of suggestions) {
      const severityLabel =
        s.severity === 'error'
          ? 'ERROR'
          : s.severity === 'warning'
            ? 'WARN'
            : 'INFO';
      console.log(`    [${severityLabel}] [${s.category}] ${s.message}`);
    }
  }

  console.log('========================================\n');

  // ================================================================
  // Exit code
  // ================================================================
  const hasFailedStep = steps.some((s) => s.status === 'failed');

  if (hasFailedStep || hasBlockingError) {
    return 1;
  }

  return 0;
}

main().then(
  (code) => {
    process.exit(code);
  },
  (err: Error) => {
    console.error(`[repair-loop] Fatal error: ${err.message}`);
    process.exit(2);
  },
);
