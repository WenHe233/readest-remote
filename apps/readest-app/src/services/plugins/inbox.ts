import { create } from 'zustand';
import type { VerifiedPluginPackage } from './package';
export const usePluginInbox = create<{
  candidate?: VerifiedPluginPackage;
  repositoryUrl?: string;
  error?: string;
}>(() => ({}));
