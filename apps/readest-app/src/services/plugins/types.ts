import { z } from 'zod';
import { remoteBookSchema } from '@readest/plugin-sdk';
import type { PluginManifest, PluginPermissions } from '@readest/plugin-sdk';
export const pluginConnectionSchema = z.object({
  id: z.string().uuid(),
  pluginId: z.string().min(1).max(128),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  sourceId: z.string().min(1).max(128),
  name: z.string().min(1).max(256),
  url: z
    .string()
    .url()
    .refine((value) => {
      const url = new URL(value);
      return (
        ['http:', 'https:'].includes(url.protocol) &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash
      );
    }, 'Use an HTTP(S) server URL without credentials or query parameters'),
  config: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  libraryIds: z.array(z.string()).max(10000),
  secretNames: z.array(z.string()).max(16),
  lastSeenCipher: z.record(z.string(), z.string()).optional(),
  addedAt: z.number(),
  updatedAt: z.number(),
  deletedAt: z.number().optional(),
  reincarnation: z.string().optional(),
});
export type PluginConnection = z.infer<typeof pluginConnectionSchema>;
export interface PluginConnectionReplica extends PluginConnection {
  credentials?: string;
}
export interface PluginDeviceConfig {
  urlOverride?: string;
  allowInvalidTls?: boolean;
  cacheEnabled?: boolean;
}
export interface InstalledPlugin {
  id: string;
  manifest: PluginManifest;
  fingerprint: string;
  publicKey: string;
  activeHash: string;
  previousHash?: string;
  enabled: boolean;
  permissions: PluginPermissions;
  installedAt: number;
  error?: string;
}
export const externalBookSourceSchema = z.object({
  pluginId: z.string().min(1).max(128),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  sourceId: z.string().min(1).max(128),
  connectionId: z.string().uuid(),
  item: remoteBookSchema,
  unavailable: z.boolean().optional(),
});
export type ExternalBookSource = z.infer<typeof externalBookSourceSchema>;
