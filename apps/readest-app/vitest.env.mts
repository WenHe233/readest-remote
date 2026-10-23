import { readFileSync } from 'node:fs';

export function loadEnvFile(filePath: string): Record<string, string> {
  try {
    const content = readFileSync(filePath, 'utf-8');
    const env: Record<string, string> = {};
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let value = trimmed.slice(eqIdx + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      env[key] = value;
    }
    return env;
  } catch {
    return {};
  }
}

/** Test overrides win even when dotenv-cli loaded deployment defaults first. */
export function applyUnitTestEnv(): void {
  Object.assign(process.env, loadEnvFile('.env.test.local'));
}

export function loadBrowserTestEnv(): Record<string, string> {
  return { ...loadEnvFile('.env'), ...loadEnvFile('.env.web'), ...loadEnvFile('.env.test.local') };
}
