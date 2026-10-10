import { describe, it, expect } from 'vitest';
import { platform } from '@tauri-apps/plugin-os';
import { getTauri, invoke } from './tauri-invoke';

describe('Tauri Smoke Tests', () => {
  it('should have __TAURI_INTERNALS__ available via window.top', () => {
    const tauri = getTauri();
    expect(tauri).toBeDefined();
    expect(typeof tauri.invoke).toBe('function');
  });

  it('should invoke get_executable_dir', async () => {
    const execDir = (await invoke('get_executable_dir')) as string;
    expect(typeof execDir).toBe('string');
    expect(execDir.length).toBeGreaterThan(0);
  });

  it('should invoke get_environment_variable for the platform home directory', async () => {
    const name = platform() === 'windows' ? 'USERPROFILE' : 'HOME';
    const home = (await invoke('get_environment_variable', { name })) as string;
    expect(typeof home).toBe('string');
    expect(home.length).toBeGreaterThan(0);
  });

  it('should return empty string for non-existent env var', async () => {
    const result = await invoke('get_environment_variable', {
      name: '__TAURI_SMOKE_TEST_NONEXISTENT__',
    });
    expect(result).toBe('');
  });

  it('should invoke get_environment_variable for PATH', async () => {
    const pathVar = (await invoke('get_environment_variable', { name: 'PATH' })) as string;
    expect(typeof pathVar).toBe('string');
    const entries = pathVar.split(platform() === 'windows' ? ';' : ':');
    expect(entries.some((entry) => /^(?:[A-Z]:[\\/]|\\\\|\/)/i.test(entry))).toBe(true);
  });

  it('should get executable dir that contains the app name', async () => {
    const execDir = (await invoke('get_executable_dir')) as string;
    expect(execDir.toLowerCase()).toMatch(/readest|target/);
  });
});
