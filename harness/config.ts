export interface HarnessConfig {
  extensionPath: string;
  targetUrl: string;
  outDir: string;
  headed: boolean;
  timeout: number;
  popupWait: number;
}

export function parseArgs(argv: string[]): HarnessConfig {
  const args: Record<string, string> = {};
  for (let i = 2; i < argv.length; i++) {
    const key = argv[i];
    if (key.startsWith('--')) {
      const val = argv[i + 1];
      if (val !== undefined && !val.startsWith('--')) {
        args[key.slice(2)] = val;
        i++;
      } else {
        args[key.slice(2)] = 'true';
      }
    }
  }

  if (!args.extension) throw new Error('--extension is required');
  if (!args.target) throw new Error('--target is required');

  return {
    extensionPath: args.extension,
    targetUrl: args.target,
    outDir: args.out || '.harness',
    headed: args.headed !== 'false',
    timeout: parseInt(args.timeout || '30000', 10),
    popupWait: parseInt(args['popup-wait'] || '10000', 10),
  };
}
