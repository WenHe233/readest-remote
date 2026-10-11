import { describe, expect, it, vi } from 'vitest';
import { anySignal } from '@/services/reedy/runtime/abort';

describe('anySignal', () => {
  it('forwards the first abort reason and detaches from all inputs', () => {
    const caller = new AbortController();
    const owner = new AbortController();
    const removed = vi.spyOn(owner.signal, 'removeEventListener');
    const combined = anySignal(caller.signal, undefined, owner.signal);
    const reason = new DOMException('Cancelled', 'AbortError');
    caller.abort(reason);
    expect(combined.signal.reason).toBe(reason);
    expect(removed).toHaveBeenCalledWith('abort', expect.any(Function));
    owner.abort('later');
    expect(combined.signal.reason).toBe(reason);
    combined.cleanup();
  });

  it('cleans earlier listeners when a later input is already aborted', () => {
    const live = new AbortController();
    const stopped = new AbortController();
    stopped.abort('stopped');
    const removed = vi.spyOn(live.signal, 'removeEventListener');
    const combined = anySignal(live.signal, stopped.signal);
    expect(combined.signal.reason).toBe('stopped');
    expect(removed).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('lets a completed operation dispose its listeners without aborting', () => {
    const caller = new AbortController();
    const combined = anySignal(caller.signal);
    combined.cleanup();
    combined.cleanup();
    caller.abort();
    expect(combined.signal.aborted).toBe(false);
  });
});
