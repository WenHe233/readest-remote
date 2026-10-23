import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { Book } from '@/types/book';
import type { SourceBookRef } from '@/services/contentSources/catalog';
const state = vi.hoisted(() => ({
  chapters: vi.fn(),
  runtime: vi.fn(),
  enqueue: vi.fn(),
  remove: vi.fn(),
  saveConfig: vi.fn(),
  navigate: vi.fn(),
  books: [] as Book[],
  downloaded: vi.fn(),
}));
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => (value: string) => value }));
vi.mock('@/context/EnvContext', () => ({
  useEnv: () => ({
    appService: { loadBookConfig: async () => ({}), saveBookConfig: state.saveConfig },
  }),
}));
vi.mock('@/hooks/useAppRouter', () => ({ useAppRouter: () => ({}) }));
vi.mock('@/utils/nav', () => ({ navigateToReader: state.navigate }));
vi.mock('@/store/settingsStore', () => ({ useSettingsStore: () => ({}) }));
vi.mock('@/store/libraryStore', () => ({
  useLibraryStore: (selector: (value: { library: Book[] }) => unknown) =>
    selector({ library: state.books }),
}));
vi.mock('@/services/contentSources/instances', () => ({ useSourceInstances: () => undefined }));
vi.mock('@/services/contentSources/runtime', () => ({ getSourceRuntime: state.runtime }));
vi.mock('@/services/contentSources/catalog', () => ({
  addSourceWork: vi.fn(),
  listSourceChapters: state.chapters,
  sourceBookHash: () => 'saved',
  sourceChapterDownloaded: state.downloaded,
  removeSourceDownloadedChapter: state.remove,
  useSourceDownloads: () => undefined,
}));
vi.mock('@/services/contentSources/downloads', () => ({ enqueueSourceDownloads: state.enqueue }));
vi.mock('@/components/contentSources/SourceCover', () => ({ default: () => <span>Cover</span> }));
vi.mock('@/components/Dialog', () => ({
  default: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
import SourceWorkDetails from '@/components/contentSources/SourceWorkDetails';
const source = {
  instanceId: 'a',
  work: { id: 'work', title: 'Offline novel', author: 'Author', kind: 'text' },
} as SourceBookRef;
beforeEach(() => {
  vi.clearAllMocks();
  state.books = [{ hash: 'saved', title: source.work.title, sourceBook: source } as Book];
  state.chapters.mockResolvedValue(
    Array.from({ length: 101 }, (_, slot) => ({
      id: `c${slot}`,
      slot,
      title: `Chapter ${slot + 1}`,
    })),
  );
  state.downloaded.mockResolvedValue(false);
  state.enqueue.mockResolvedValue('task');
});
afterEach(cleanup);
describe('source work details', () => {
  it('pages the directory, queues selected chapters independently of closing and removes downloads', async () => {
    state.downloaded.mockResolvedValue(true);
    const view = render(<SourceWorkDetails source={source} onClose={vi.fn()} />);
    await screen.findByText('Chapter 100');
    expect(screen.queryByText('Chapter 101')).toBeNull();
    fireEvent.click(screen.getByText('Load more'));
    await screen.findByText('Chapter 101');
    fireEvent.click(view.container.querySelector<HTMLInputElement>('input[type="checkbox"]')!);
    fireEvent.click(screen.getByText('Download selected'));
    await waitFor(() => expect(state.enqueue).toHaveBeenCalledWith(source, ['c0']));
    await waitFor(() =>
      expect((screen.getByText('Remove selected downloads') as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    fireEvent.click(screen.getByText('Remove selected downloads'));
    await waitFor(() => expect(state.remove).toHaveBeenCalledWith(source, 'c0'));
  });
  it('opens a downloaded chapter after the source plugin is unavailable', async () => {
    render(<SourceWorkDetails source={source} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByText('Chapter 1'));
    await waitFor(() => expect(state.saveConfig).toHaveBeenCalled());
    expect(state.saveConfig.mock.calls[0]?.[1]).toMatchObject({
      sourceLocator: { workId: 'work', chapterId: 'c0' },
    });
    expect(state.runtime).not.toHaveBeenCalled();
    expect(state.navigate).toHaveBeenCalled();
  });
});
