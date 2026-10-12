import { exec } from 'child_process';
import { readFileSync, readdirSync, statSync } from 'fs';
import { promisify } from 'util';
import { join, relative } from 'path';
import { deleteBaseline } from '../observers/visual-regression.js';

// =============================================================================
// Types
// =============================================================================

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }>;
}

// =============================================================================
// Helpers
// =============================================================================

const execAsync = promisify(exec);

const ROOT = process.cwd();

/**
 * Execute a shell command via promisified exec.
 * Returns combined output and exit code on both success and failure.
 */
async function runCommand(command: string): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
}> {
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: ROOT,
      maxBuffer: 10 * 1024 * 1024, // 10 MB
      shell: true,
    });
    return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode: 0 };
  } catch (err: unknown) {
    const error = err as {
      stdout?: string;
      stderr?: string;
      code?: number;
      status?: number;
      message?: string;
    };
    return {
      stdout: (error.stdout || '').trim(),
      stderr: (error.stderr || '').trim(),
      exitCode: error.code ?? error.status ?? 1,
    };
  }
}

/**
 * Build the result object consumed by the MCP transport.
 */
function result(text: string, isError = false) {
  return {
    content: [{ type: 'text' as const, text }],
    isError,
  };
}

// =============================================================================
// Tool Definitions
// =============================================================================

export const toolDefinitions: ToolDefinition[] = [
  // ── run_harness ────────────────────────────────────────────────────────────
  {
    name: 'run_harness',
    description: 'Execute the extension harness CLI to test a browser extension against a target page',
    inputSchema: {
      type: 'object',
      properties: {
        extension: {
          type: 'string',
          description: 'Path to the extension build directory (e.g. .output/chrome-mv3)',
        },
        target: {
          type: 'string',
          description: 'Target page URL to test against (e.g. https://seller.shopee.tw)',
        },
        headed: {
          type: 'boolean',
          description: 'Run browser in headed mode (visible window). Default: true',
          default: true,
        },
        timeout: {
          type: 'number',
          description: 'Global timeout in milliseconds. Default: 30000',
          default: 30000,
        },
        popupWait: {
          type: 'number',
          description: 'Popup observation time in milliseconds. Default: 10000',
          default: 10000,
        },
      },
      required: ['extension', 'target'],
    },
    handler: async (args: Record<string, unknown>) => {
      try {
        const extension = String(args.extension ?? '');
        const target = String(args.target ?? '');
        const headed = args.headed !== false;
        const timeout = Number(args.timeout ?? 30000);
        const popupWait = Number(args.popupWait ?? 10000);

        let cmd = `npx tsx harness/cli.ts`;
        cmd += ` --extension "${extension}"`;
        cmd += ` --target "${target}"`;
        cmd += ` --headed ${headed}`;
        cmd += ` --timeout ${timeout}`;
        cmd += ` --popup-wait ${popupWait}`;

        const { stdout, stderr, exitCode } = await runCommand(cmd);

        const lines: string[] = [];
        if (stdout) lines.push(stdout);
        if (stderr) lines.push(`STDERR:\n${stderr}`);
        lines.push(`\nExit code: ${exitCode}`);

        return result(lines.join('\n\n'), exitCode !== 0);
      } catch (err: unknown) {
        return result(
          `run_harness failed: ${err instanceof Error ? err.message : String(err)}`,
          true,
        );
      }
    },
  },

  // ── read_report ────────────────────────────────────────────────────────────
  {
    name: 'read_report',
    description: 'Read a harness report JSON file and return its contents as formatted JSON',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to the report JSON file. Default: .harness/latest-report.json',
          default: '.harness/latest-report.json',
        },
      },
    },
    handler: async (args: Record<string, unknown>) => {
      try {
        const reportPath = String(args.path ?? '.harness/latest-report.json');
        const resolvedPath = join(ROOT, reportPath);
        const raw = readFileSync(resolvedPath, 'utf-8');
        const parsed = JSON.parse(raw);
        return result(JSON.stringify(parsed, null, 2));
      } catch (err: unknown) {
        return result(
          `read_report failed: ${err instanceof Error ? err.message : String(err)}`,
          true,
        );
      }
    },
  },

  // ── compare_reports ────────────────────────────────────────────────────────
  {
    name: 'compare_reports',
    description: 'Compare two harness reports and show the differences (regressions, improvements, unchanged)',
    inputSchema: {
      type: 'object',
      properties: {
        oldReport: {
          type: 'string',
          description: 'Path to the old/previous report JSON file',
        },
        newReport: {
          type: 'string',
          description: 'Path to the new/current report JSON file',
        },
      },
      required: ['oldReport', 'newReport'],
    },
    handler: async (args: Record<string, unknown>) => {
      try {
        const oldReport = String(args.oldReport ?? '');
        const newReport = String(args.newReport ?? '');
        const cmd = `npx tsx harness/scripts/compare-reports.ts "${oldReport}" "${newReport}"`;

        const { stdout, stderr, exitCode } = await runCommand(cmd);

        const lines: string[] = [];
        if (stdout) lines.push(stdout);
        if (stderr) lines.push(`STDERR:\n${stderr}`);
        lines.push(`\nExit code: ${exitCode}`);

        return result(lines.join('\n\n'), exitCode !== 0);
      } catch (err: unknown) {
        return result(
          `compare_reports failed: ${err instanceof Error ? err.message : String(err)}`,
          true,
        );
      }
    },
  },

  // ── build_extension ────────────────────────────────────────────────────────
  {
    name: 'build_extension',
    description: 'Build the extension by running npm run build (wxt build)',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    handler: async (_args: Record<string, unknown>) => {
      try {
        const { stdout, stderr, exitCode } = await runCommand('npm run build');

        const lines: string[] = [];
        if (stdout) lines.push(stdout);
        if (stderr) lines.push(`STDERR:\n${stderr}`);
        lines.push(`\nExit code: ${exitCode}`);

        return result(lines.join('\n\n'), exitCode !== 0);
      } catch (err: unknown) {
        return result(
          `build_extension failed: ${err instanceof Error ? err.message : String(err)}`,
          true,
        );
      }
    },
  },

  // ── run_repair_loop ────────────────────────────────────────────────────────
  {
    name: 'run_repair_loop',
    description: 'Run the full repair cycle: (optional build) -> harness -> analyze',
    inputSchema: {
      type: 'object',
      properties: {
        extension: {
          type: 'string',
          description: 'Path to the extension build directory',
        },
        target: {
          type: 'string',
          description: 'Target page URL to test against',
        },
        headed: {
          type: 'boolean',
          description: 'Run browser in headed mode. Default: true',
          default: true,
        },
        timeout: {
          type: 'number',
          description: 'Global timeout in milliseconds. Default: 30000',
          default: 30000,
        },
        popupWait: {
          type: 'number',
          description: 'Popup observation time in milliseconds. Default: 10000',
          default: 10000,
        },
        build: {
          type: 'boolean',
          description: 'Run npm run build before the harness step. Default: true',
          default: true,
        },
      },
    },
    handler: async (args: Record<string, unknown>) => {
      try {
        let cmd = 'npx tsx harness/scripts/repair-loop.ts --run';

        // --no-build when build is explicitly false
        if (args.build === false) {
          cmd += ' --no-build';
        }

        // Pass-through harness args
        const extension = args.extension !== undefined ? String(args.extension) : undefined;
        const target = args.target !== undefined ? String(args.target) : undefined;
        const headed = args.headed !== undefined ? args.headed : undefined;
        const timeout = args.timeout !== undefined ? Number(args.timeout) : undefined;
        const popupWait = args.popupWait !== undefined ? Number(args.popupWait) : undefined;

        if (extension !== undefined) cmd += ` --extension "${extension}"`;
        if (target !== undefined) cmd += ` --target "${target}"`;
        if (headed !== undefined) cmd += ` --headed ${headed}`;
        if (timeout !== undefined) cmd += ` --timeout ${timeout}`;
        if (popupWait !== undefined) cmd += ` --popup-wait ${popupWait}`;

        const { stdout, stderr, exitCode } = await runCommand(cmd);

        const lines: string[] = [];
        if (stdout) lines.push(stdout);
        if (stderr) lines.push(`STDERR:\n${stderr}`);
        lines.push(`\nExit code: ${exitCode}`);

        return result(lines.join('\n\n'), exitCode !== 0);
      } catch (err: unknown) {
        return result(
          `run_repair_loop failed: ${err instanceof Error ? err.message : String(err)}`,
          true,
        );
      }
    },
  },

  // ── list_outputs ───────────────────────────────────────────────────────────
  {
    name: 'list_outputs',
    description: 'List all files in the .harness output directory with size and modification time',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    handler: async (_args: Record<string, unknown>) => {
      try {
        const harnessDir = join(ROOT, '.harness');
        const entries: Array<{ name: string; size: number; mtime: Date }> = [];

        function walk(dir: string): void {
          let dirEntries: string[];
          try {
            dirEntries = readdirSync(dir);
          } catch {
            return;
          }
          for (const entry of dirEntries) {
            const fullPath = join(dir, entry);
            try {
              const s = statSync(fullPath);
              if (s.isDirectory()) {
                walk(fullPath);
              } else {
                entries.push({
                  name: relative(harnessDir, fullPath),
                  size: s.size,
                  mtime: s.mtime,
                });
              }
            } catch {
              // skip inaccessible entries
            }
          }
        }

        walk(harnessDir);

        if (entries.length === 0) {
          return result('.harness directory is empty or does not exist');
        }

        entries.sort((a, b) => a.name.localeCompare(b.name));

        const lines = entries.map(
          (e) => `${e.name}\t${e.size} bytes\t${e.mtime.toISOString()}`,
        );

        return result(lines.join('\n'));
      } catch (err: unknown) {
        return result(
          `list_outputs failed: ${err instanceof Error ? err.message : String(err)}`,
          true,
        );
      }
    },
  },

  // ── delete_baseline ────────────────────────────────────────────────────────
  {
    name: 'delete_baseline',
    description: 'Delete the visual regression baseline directory (.harness/baseline/)',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    handler: async (_args: Record<string, unknown>) => {
      try {
        const outDir = join(ROOT, '.harness');
        deleteBaseline(outDir);
        return result(`Baseline deleted from ${outDir}/baseline/`);
      } catch (err: unknown) {
        return result(
          `delete_baseline failed: ${err instanceof Error ? err.message : String(err)}`,
          true,
        );
      }
    },
  },
];
