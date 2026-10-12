import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import {
  readFileSync,
  writeFileSync,
  existsSync,
  copyFileSync,
  mkdirSync,
  rmSync,
} from 'fs';
import { join, basename } from 'path';

export interface VisualRegressionResult {
  hasBaseline: boolean;
  hasDiff: boolean;
  diffPixels: number;
  totalPixels: number;
  diffPercent: number;
  diffPath: string | null;
}

/**
 * If the baseline image does not already exist under `{outDir}/baseline/{basename}`,
 * copies `screenshotPath` there and returns `true`. Otherwise returns `false`.
 */
export async function ensureBaseline(
  screenshotPath: string,
  outDir: string,
): Promise<boolean> {
  const name = basename(screenshotPath);
  const baselineDir = join(outDir, 'baseline');
  const baselinePath = join(baselineDir, name);

  if (existsSync(baselinePath)) {
    return false;
  }

  mkdirSync(baselineDir, { recursive: true });
  copyFileSync(screenshotPath, baselinePath);
  return true;
}

/**
 * Compares `screenshotPath` against the baseline stored at
 * `{outDir}/baseline/{basename}`.
 *
 * When no baseline exists it is created via `ensureBaseline` and the returned
 * result has `hasBaseline: false`.
 *
 * The diff image is written to `{outDir}/diff-{basename}`.
 *
 * @param thresholdPercent - If provided, `hasDiff` is `true` only when
 *   `diffPercent > thresholdPercent`. When omitted, any differing pixel sets
 *   `hasDiff` to `true`.
 */
export async function compareScreenshot(
  screenshotPath: string,
  outDir: string,
  thresholdPercent?: number,
): Promise<VisualRegressionResult> {
  const name = basename(screenshotPath);
  const baselineDir = join(outDir, 'baseline');
  const baselinePath = join(baselineDir, name);

  // No baseline yet -- create one and report that no comparison was performed.
  if (!existsSync(baselinePath)) {
    await ensureBaseline(screenshotPath, outDir);
    return {
      hasBaseline: false,
      hasDiff: false,
      diffPixels: 0,
      totalPixels: 0,
      diffPercent: 0,
      diffPath: null,
    };
  }

  // Read both images.
  const screenshotBuf = readFileSync(screenshotPath);
  const baselineBuf = readFileSync(baselinePath);

  const screenshotPng = PNG.sync.read(screenshotBuf);
  const baselinePng = PNG.sync.read(baselineBuf);

  const { width, height } = screenshotPng;
  const totalPixels = width * height;

  // Allocate a fresh PNG for the diff output.
  const diffPng = new PNG({ width, height });

  const diffPixels = pixelmatch(
    screenshotPng.data,
    baselinePng.data,
    diffPng.data,
    width,
    height,
    { threshold: 0.1 },
  );

  const diffPercent = totalPixels > 0 ? (diffPixels / totalPixels) * 100 : 0;

  // Write the diff image to disk.
  mkdirSync(outDir, { recursive: true });
  const diffPath = join(outDir, `diff-${name}`);
  writeFileSync(diffPath, PNG.sync.write(diffPng));

  const hasDiff =
    thresholdPercent !== undefined
      ? diffPercent > thresholdPercent
      : diffPixels > 0;

  return {
    hasBaseline: true,
    hasDiff,
    diffPixels,
    totalPixels,
    diffPercent,
    diffPath,
  };
}

/**
 * Deletes the entire baseline directory at `{outDir}/baseline/`.
 */
export function deleteBaseline(outDir: string): void {
  const baselineDir = join(outDir, 'baseline');
  if (existsSync(baselineDir)) {
    rmSync(baselineDir, { recursive: true, force: true });
  }
}
