import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

export function readSourceTestPackages(directory: string): Record<string, string> {
  return Object.fromEntries(['legado', 'venera'].map((name) => {
    const files = readdirSync(directory).filter((file) => file.startsWith(`${name}-`) && file.endsWith('.readest-plugin'));
    if (files.length !== 1) throw new Error(`Expected one signed ${name} compatibility package, found ${files.length}.`);
    return [name, readFileSync(resolve(directory, files[0]!)).toString('base64')];
  }));
}
