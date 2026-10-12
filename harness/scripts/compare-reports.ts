import { readFileSync } from 'fs';

interface FieldResult {
  label: string;
  oldDisplay: string;
  newDisplay: string;
  improved: boolean;
  regressed: boolean;
  isNew: boolean;   // old value was n/a (field appeared)
  isGone: boolean;  // new value is n/a (field disappeared)
}

function getField(obj: unknown, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function addBoolField(
  results: FieldResult[],
  label: string,
  path: string,
  trueDisplay: string,
  falseDisplay: string,
  oldReport: unknown,
  newReport: unknown,
): void {
  const oldV = getField(oldReport, path);
  const newV = getField(newReport, path);
  results.push({
    label,
    oldDisplay: oldV === undefined ? 'n/a' : oldV ? trueDisplay : falseDisplay,
    newDisplay: newV === undefined ? 'n/a' : newV ? trueDisplay : falseDisplay,
    improved:
      oldV !== undefined && newV !== undefined ? !oldV && newV : false,
    regressed:
      oldV !== undefined && newV !== undefined ? oldV && !newV : false,
    isNew: oldV === undefined && newV !== undefined,
    isGone: oldV !== undefined && newV === undefined,
  });
}

function addNumField(
  results: FieldResult[],
  label: string,
  path: string,
  oldReport: unknown,
  newReport: unknown,
): void {
  const oldV = getField(oldReport, path);
  const newV = getField(newReport, path);
  const oldNum =
    oldV !== undefined ? (typeof oldV === 'number' ? oldV : undefined) : undefined;
  const newNum =
    newV !== undefined ? (typeof newV === 'number' ? newV : undefined) : undefined;

  results.push({
    label,
    oldDisplay: oldNum !== undefined ? String(oldNum) : 'n/a',
    newDisplay: newNum !== undefined ? String(newNum) : 'n/a',
    improved:
      oldNum !== undefined && newNum !== undefined ? newNum < oldNum : false,
    regressed:
      oldNum !== undefined && newNum !== undefined ? newNum > oldNum : false,
    isNew: oldNum === undefined && newNum !== undefined,
    isGone: oldNum !== undefined && newNum === undefined,
  });
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.length !== 2) {
    console.error(
      'Usage: npx tsx harness/scripts/compare-reports.ts <old-report.json> <new-report.json>',
    );
    process.exit(2);
  }

  const [oldPath, newPath] = args;

  let oldRaw: string;
  let newRaw: string;
  try {
    oldRaw = readFileSync(oldPath, 'utf-8');
    newRaw = readFileSync(newPath, 'utf-8');
  } catch (err: any) {
    console.error(`Error: cannot read report file — ${err.message}`);
    process.exit(2);
  }

  let oldReport: unknown;
  let newReport: unknown;
  try {
    oldReport = JSON.parse(oldRaw);
    newReport = JSON.parse(newRaw);
  } catch (err: any) {
    console.error(`Error: invalid JSON in report file — ${err.message}`);
    process.exit(2);
  }

  // Status ordinal for comparison
  const statusOrder: Record<string, number> = {
    'harness-error': 0,
    error: 1,
    warning: 2,
    pass: 3,
  };

  const results: FieldResult[] = [];

  // diagnostics.status
  {
    const oldV = getField(oldReport, 'diagnostics.status') as string | undefined;
    const newV = getField(newReport, 'diagnostics.status') as string | undefined;
    const oldOrd = oldV !== undefined ? (statusOrder[oldV] ?? -1) : -1;
    const newOrd = newV !== undefined ? (statusOrder[newV] ?? -1) : -1;
    results.push({
      label: 'Status',
      oldDisplay: oldV ?? 'n/a',
      newDisplay: newV ?? 'n/a',
      improved: oldOrd >= 0 && newOrd >= 0 && newOrd > oldOrd,
      regressed: oldOrd >= 0 && newOrd >= 0 && newOrd < oldOrd,
      isNew: oldV === undefined && newV !== undefined,
      isGone: oldV !== undefined && newV === undefined,
    });
  }

  addBoolField(results, 'Popup', 'popup.opened', 'opened', 'failed', oldReport, newReport);
  addBoolField(results, 'Target page', 'targetPage.opened', 'loaded', 'failed', oldReport, newReport);
  addBoolField(results, 'Content Script', 'targetPage.contentScriptDetected', 'detected', 'not detected', oldReport, newReport);
  addBoolField(results, 'SW', 'serviceWorker.detected', 'detected', 'not detected', oldReport, newReport);
  addNumField(results, 'Failed reqs', 'network.failedRequests.length', oldReport, newReport);
  addNumField(results, 'Bad resp', 'network.badResponses.length', oldReport, newReport);
  addNumField(results, 'Page errors', 'popup.pageErrors.length', oldReport, newReport);

  // Compute stats
  let improvements = 0;
  let regressions = 0;
  let unchanged = 0;

  for (const r of results) {
    if (r.isNew || r.isGone) {
      // Added/disappeared fields are not counted in the three buckets
    } else if (r.improved) {
      improvements++;
    } else if (r.regressed) {
      regressions++;
    } else {
      unchanged++;
    }
  }

  // Display
  const labelWidth = Math.max(...results.map((r) => r.label.length));
  const oldWidth = Math.max(...results.map((r) => r.oldDisplay.length));

  console.log('========== Report Diff ==========');

  for (const r of results) {
    let icon: string;
    if (r.isNew) {
      icon = '➕';
    } else if (r.isGone) {
      icon = '➖';
    } else if (r.improved) {
      icon = '✅';
    } else if (r.regressed) {
      icon = '❌';
    } else {
      icon = '✓';
    }

    const label = r.label.padEnd(labelWidth);
    const oldVal = r.oldDisplay.padStart(oldWidth);

    console.log(`${label}: ${oldVal} → ${r.newDisplay}  ${icon}`);
  }

  console.log('');
  console.log(`改善: ${improvements}`);
  console.log(`恶化: ${regressions}`);
  console.log(`不变: ${unchanged}`);
  console.log('===================================');

  process.exit(regressions > 0 ? 1 : 0);
}

main();
