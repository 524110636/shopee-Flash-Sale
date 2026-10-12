export interface HarnessMeta {
  timestamp: string;
  harnessVersion: string;
  extensionPath: string;
  targetUrl: string;
}

export interface HarnessManifest {
  manifestVersion: number;
  name: string;
  version: string;
  defaultPopup: string | null;
  serviceWorker: string | null;
  permissions: string[];
  hostPermissions: string[];
  contentScripts: { matches: string[]; js: string[] }[];
}

export interface ConsoleEntry {
  level: string;
  text: string;
  timestamp: string;
}

export interface PopupReport {
  opened: boolean;
  url: string;
  title: string;
  visibleText: string;
  console: ConsoleEntry[];
  pageErrors: string[];
  screenshot: string | null;
}

export interface TargetPageReport {
  opened: boolean;
  url: string;
  console: ConsoleEntry[];
  pageErrors: string[];
  contentScriptDetected: boolean;
  screenshot: string | null;
}

export interface ServiceWorkerReport {
  detected: boolean;
  url: string | null;
  console: ConsoleEntry[];
  errors: string[];
}

export interface FailedRequest {
  url: string;
  method: string;
  failure: string;
}

export interface BadResponse {
  url: string;
  method: string;
  status: number;
  statusText: string;
}

export interface NetworkReport {
  failedRequests: FailedRequest[];
  badResponses: BadResponse[];
}

export interface VisualDiffResult {
  checked: boolean;
  baselineCreated: boolean;
  hasDiff: boolean;
  diffPercent: number;
  diffPath: string | null;
}

export interface VisualRegressionReport {
  popup: VisualDiffResult | null;
  targetPage: VisualDiffResult | null;
}

export interface DiagnosticsReport {
  status: 'pass' | 'warning' | 'error' | 'harness-error';
  summary: string[];
  probableCauses: string[];
  suggestedNextChecks: string[];
}

export interface HarnessReport {
  meta: HarnessMeta;
  manifest: HarnessManifest;
  runtime: {
    extensionId: string;
    serviceWorkerUrl: string | null;
  };
  popup: PopupReport;
  targetPage: TargetPageReport;
  serviceWorker: ServiceWorkerReport;
  network: NetworkReport;
  visualRegression?: VisualRegressionReport;
  diagnostics: DiagnosticsReport;
}
