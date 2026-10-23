import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Book } from '@/types/book';
import type { SourceBookRef } from '@/services/contentSources/catalog';
const state = vi.hoisted(() => ({
  load: vi.fn(),
  invalidate: vi.fn(),
  generate: vi.fn(),
  books: [] as Book[],
}));
vi.mock('@/context/EnvContext', () => ({
  useEnv: () => ({ appService: { generateCoverImageUrl: state.generate } }),
}));
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => (value: string) => value }));
vi.mock('@/services/contentSources/covers', () => ({ loadSourceCover: state.load }));
vi.mock('@/services/contentSources/catalog', () => ({
  sourceBookHash: () => 'book',
  invalidateSourceResource: state.invalidate,
}));
vi.mock('@/store/libraryStore', () => ({
  useLibraryStore: (select: (value: { library: Book[] }) => unknown) =>
    select({ library: state.books }),
}));
import SourceCover from '@/components/contentSources/SourceCover';
const source = {
  instanceId: 'instance',
  work: {
    id: 'work',
    title: 'Example',
    cover: { id: 'cover', url: 'https://private.example/image?token=not-for-dom' },
  },
} as SourceBookRef;
beforeEach(() => {
  state.books = [];
  state.load.mockReset();
  state.invalidate.mockReset().mockResolvedValue(undefined);
  state.generate.mockReset().mockResolvedValue('asset://fresh-cover');
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it('shows a persisted cover without contacting an unavailable source', async () => {
  state.books = [{ hash: 'book', coverImageUrl: 'asset://saved-cover' } as Book];
  const view = render(<SourceCover source={source} />);
  await waitFor(() =>
    expect(view.container.querySelector('img')?.getAttribute('src')).toBe('asset://saved-cover'),
  );
  expect(state.load).not.toHaveBeenCalled();
});
it('renders broker bytes through an owned blob URL and revokes it on unmount', async () => {
  const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:source-cover');
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  state.load.mockResolvedValue(new Blob(['fixture'], { type: 'image/png' }));
  const view = render(<SourceCover source={source} />);
  await waitFor(() =>
    expect(view.container.querySelector('img')?.getAttribute('src')).toBe('blob:source-cover'),
  );
  expect(view.container.innerHTML).not.toContain('not-for-dom');
  expect(create).toHaveBeenCalledOnce();
  view.unmount();
  expect(revoke).toHaveBeenCalledWith('blob:source-cover');
});
it('invalidates a failed temporary cover before retrying its resource', async () => {
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:bad-cover');
  state.load.mockResolvedValue(new Blob(['fixture'], { type: 'image/png' }));
  const view = render(<SourceCover source={source} />);
  await waitFor(() => expect(view.container.querySelector('img')).toBeTruthy());
  fireEvent.error(view.container.querySelector('img')!);
  fireEvent.click(screen.getByText('Retry cover'));
  await waitFor(() => expect(state.load).toHaveBeenCalledTimes(2));
  expect(state.invalidate).toHaveBeenCalledWith(source, source.work.cover);
});
it('regenerates a persisted cover URL on retry without downloading over a manual cover', async () => {
  state.books = [{ hash: 'book', coverImageUrl: 'blob:expired-cover', coverUpdatedAt: 1 } as Book];
  const view = render(<SourceCover source={source} />);
  await waitFor(() => expect(view.container.querySelector('img')).toBeTruthy());
  fireEvent.error(view.container.querySelector('img')!);
  fireEvent.click(screen.getByText('Retry cover'));
  await waitFor(() =>
    expect(view.container.querySelector('img')?.getAttribute('src')).toBe('asset://fresh-cover'),
  );
  expect(state.load).not.toHaveBeenCalled();
});
