export interface ClawPackage {
  formatVersion: 1;
  name: string;
  language: string;
  description: string;
  parameters: Record<string, unknown>;
  code: string;
  wrapperCode?: string;
  skillMd: string;
  sampleArgs?: Record<string, unknown>;
  version: string;
  author: string;
  exportedAt: string;
  checksum: string;
  /** Ed25519 signed manifest (optional, added on export) */
  signedManifest?: import("../security/skillSigning.js").SignedManifest;
}

export interface HubRegistryEntry {
  name: string;
  version: string;
  language: string;
  description: string;
  author: string;
  exportedAt: string;
  fileName: string;
  checksum: string;
}

export interface HubRegistry {
  instanceName: string;
  packages: HubRegistryEntry[];
}
