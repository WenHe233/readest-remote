import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import UnifiedSearchResults from '@/app/library/components/UnifiedSearchResults';
import type { SourceInstance } from '@/services/contentSources/instances';
const state = vi.hoisted(() => ({ call: vi.fn(), signals: [] as AbortSignal[] }));
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => (value: string) => value }));
vi.mock('@/context/EnvContext', () => ({ useEnv: () => ({ appService: null }) }));
vi.mock('@/app/library/hooks/useOpenBook', () => ({ useOpenBook: () => ({ openBook: vi.fn() }) }));
vi.mock('@/services/contentSources/runtime', () => ({
  getSourceRuntime: async (id: string) => ({
    call: async (_operation: string, payload: unknown, signal: AbortSignal) => {
      state.signals.push(signal);
      return state.call(id, payload, signal);
    },
  }),
}));
vi.mock('@/services/contentSources/instances', () => ({
  useSourceInstances: (select: (value: { instances: SourceInstance[] }) => unknown) =>
    select({
      instances: ['a', 'b'].map(
        (id) =>
          ({ id, name: id, pluginId: 'plugin', fingerprint: 'a'.repeat(64) }) as SourceInstance,
      ),
    }),
}));
vi.mock('@/services/plugins/persistence', () => ({ readPluginRecord: async () => undefined }));
vi.mock('@/services/plugins/manager', () => ({ getLibraryRuntime: vi.fn() }));
vi.mock('@/services/plugins/library', () => {
  const tasks = {};
  return { useExternalLibrarySync: () => tasks, syncExternalLibrary: vi.fn() };
});
vi.mock('@/services/contentSources/catalog', () => ({
  getSourceBookRef: () => undefined,
  sourceBookHash: (id: string, work: string) => id + ':' + work,
  addSourceWork: vi.fn(),
}));
vi.mock('@/components/contentSources/SourceCover', () => ({ default: () => <span>Cover</span> }));
vi.mock('@/components/contentSources/SourceWorkDetails', () => ({
  default: () => <span>Details</span>,
}));
const scopes = ['a', 'b'].map((id) => ({
  id: `source:${id}`,
  kind: 'source' as const,
  name: `Source ${id}`,
  instanceId: id,
}));
const props = {
  books: [],
  query: 'needle',
  scopes,
  submitted: { id: 0, query: '' },
  handleBookDownload: async () => true,
};
beforeEach(() => {
  state.call.mockReset();
  state.signals = [];
});
afterEach(cleanup);
describe('unified source search', () => {
  it('does not contact sources while typing and keeps failures and pagination independent', async () => {
    state.call.mockImplementation(async (id, payload) => {
      if (id === 'b')
        throw Object.assign(new Error('secret token must stay hidden'), {
          code: 'SOURCE_NETWORK_FAILED',
          status: 503,
          stage: 'response',
        });
      return {
        items: [
          {
            id: payload.cursor ? '2' : '1',
            title: payload.cursor ? 'Next result' : 'First result',
            author: '',
            kind: 'comic',
          },
        ],
        nextCursor: payload.cursor ? undefined : 'next',
      };
    });
    const rendered = render(<UnifiedSearchResults {...props} />);
    expect(state.call).not.toHaveBeenCalled();
    rendered.rerender(<UnifiedSearchResults {...props} submitted={{ id: 1, query: 'needle' }} />);
    await screen.findByText('First result');
    await screen.findByText(/SOURCE_NETWORK_FAILED/);
    expect(screen.getByText(/HTTP 503/)).toBeTruthy();
    expect(screen.queryByText(/secret token/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await screen.findByText('Next result');
    expect(screen.getByText('First result')).toBeTruthy();
    expect(state.call.mock.calls.filter(([id]) => id === 'b')).toHaveLength(1);
  });
  it('cancels the old query and ignores its late response', async () => {
    let complete!: (value: unknown) => void;
    state.call.mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const rendered = render(
      <UnifiedSearchResults
        {...props}
        scopes={[scopes[0]!]}
        submitted={{ id: 1, query: 'needle' }}
      />,
    );
    await waitFor(() => expect(state.call).toHaveBeenCalledOnce());
    rendered.rerender(<UnifiedSearchResults {...props} query='changed' scopes={[scopes[0]!]} />);
    expect(state.signals[0]?.aborted).toBe(true);
    await act(async () =>
      complete({ items: [{ id: 'stale', title: 'Stale result', author: '', kind: 'comic' }] }),
    );
    expect(screen.queryByText('Stale result')).toBeNull();
    expect(state.call).toHaveBeenCalledOnce();
  });
});
