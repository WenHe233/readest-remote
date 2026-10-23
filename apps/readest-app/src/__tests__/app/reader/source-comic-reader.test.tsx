import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { BookConfig } from '@/types/book';
import type { SourceBookDocument } from '@/services/contentSources/sourceBook';
import SourceComicReader from '@/app/reader/components/SourceComicReader';

const state = vi.hoisted(() => ({
  config: { updatedAt: 0 } as BookConfig,
  resolve: vi.fn(),
  resource: vi.fn(),
  save: vi.fn(),
  env: {},
}));
vi.mock('@/context/EnvContext', () => ({ useEnv: () => ({ envConfig: state.env }) }));
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => (text: string) => text }));
vi.mock('@/store/settingsStore', () => ({
  useSettingsStore: { getState: () => ({ settings: {} }) },
}));
vi.mock('@/store/readerStore', () => ({
  useReaderStore: { getState: () => ({ setViewInited: vi.fn() }) },
}));
vi.mock('@/store/bookDataStore', () => ({
  useBookDataStore: {
    getState: () => ({
      getConfig: () => state.config,
      setConfig: (_key: string, update: Partial<BookConfig>) => {
        state.config = { ...state.config, ...update };
      },
      updateBooknotes: (_key: string, notes: BookConfig['booknotes']) => {
        state.config.booknotes = notes;
      },
      saveConfig: state.save,
    }),
  },
}));
vi.mock('@/services/contentSources/catalog', () => ({
  resolveSourceChapter: state.resolve,
  loadSourceResource: state.resource,
}));

const bookDoc = {
  sourceReference: { instanceId: 'instance', work: { id: 'comic', title: 'Comic', kind: 'comic' } },
  sourceChapters: [
    { id: 'first', title: 'First', slot: 9 },
    { id: 'second', title: 'Second', slot: 42 },
  ],
} as unknown as SourceBookDocument;
const renderReader = () =>
  render(
    <SourceComicReader
      bookKey='book-1'
      bookDoc={bookDoc}
      insets={{ top: 0, bottom: 0, left: 0, right: 0 }}
      onCloseBook={vi.fn()}
      onGoToLibrary={vi.fn()}
    />,
  );

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  state.config = { updatedAt: 0 };
  state.resolve.mockReset().mockImplementation(async (_ref, chapter) => ({
    kind: 'pages',
    pages: chapter.id === 'first' ? [{ id: 'one' }, { id: 'two' }] : [{ id: 'three' }],
  }));
  state.resource.mockReset().mockResolvedValue(new Blob(['image'], { type: 'image/png' }));
  state.save.mockReset().mockResolvedValue(undefined);
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:${Math.random()}`);
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
});

describe('source comic reader', () => {
  it('fetches only the current chapter and visible image, and persists stable chapter/page positions', async () => {
    const view = renderReader();
    await screen.findByAltText('First · 1');
    await waitFor(() => expect(state.config.progress).toEqual([1, 4]));
    expect(state.resolve).toHaveBeenCalledTimes(1);
    expect(state.resource).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Next Page' }));
    await screen.findByAltText('First · 2');
    expect(state.resolve).toHaveBeenCalledTimes(1);
    expect(state.resource).toHaveBeenCalledTimes(2);
    await waitFor(() =>
      expect(state.config.sourceLocator).toMatchObject({ chapterId: 'first', pageIndex: 1 }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Next Chapter' }));
    await screen.findByAltText('Second · 1');
    expect(state.resolve).toHaveBeenCalledTimes(2);
    expect(state.resource).toHaveBeenCalledTimes(3);
    view.unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalled();
  });

  it('restores a page locator and creates a bookmark tied to chapter identity', async () => {
    state.config.sourceLocator = { workId: 'comic', chapterId: 'first', pageIndex: 1, modified: 1 };
    renderReader();
    await screen.findByAltText('First · 2');
    fireEvent.click(screen.getByRole('button', { name: 'Add Bookmark' }));
    expect(state.config.booknotes?.[0]?.sourceLocator).toMatchObject({
      chapterId: 'first',
      pageIndex: 1,
    });
  });
});
