import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { HarnessManifest } from './report/report-types';

export interface ManifestRaw {
  manifest_version: number;
  name?: string;
  version?: string;
  action?: { default_popup?: string; default_title?: string };
  background?: { service_worker?: string };
  permissions?: string[];
  host_permissions?: string[];
  content_scripts?: {
    matches: string[];
    js: string[];
    run_at?: string;
  }[];
}

export function readManifest(extensionPath: string): ManifestRaw {
  const manifestPath = join(extensionPath, 'manifest.json');
  if (!existsSync(manifestPath)) {
    throw new Error(`manifest.json not found at ${manifestPath}`);
  }
  const raw = JSON.parse(readFileSync(manifestPath, 'utf-8')) as ManifestRaw;

  if (raw.manifest_version !== 3) {
    throw new Error(
      `Unsupported manifest_version: ${raw.manifest_version}. Only MV3 is supported.`,
    );
  }

  return raw;
}

export function parseManifest(raw: ManifestRaw): HarnessManifest {
  return {
    manifestVersion: raw.manifest_version,
    name: raw.name || 'unknown',
    version: raw.version || '0.0.0',
    defaultPopup: raw.action?.default_popup || null,
    serviceWorker: raw.background?.service_worker || null,
    permissions: raw.permissions || [],
    hostPermissions: raw.host_permissions || [],
    contentScripts: (raw.content_scripts || []).map((cs) => ({
      matches: cs.matches,
      js: cs.js,
    })),
  };
}
