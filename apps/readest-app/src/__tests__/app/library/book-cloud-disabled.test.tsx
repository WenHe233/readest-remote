import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Book } from '@/types/book';
import BookItem from '@/app/library/components/BookItem';
import { useSettingsStore } from '@/store/settingsStore';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/context/EnvContext', () => ({ useEnv: () => ({ appService: null }) }));
vi.mock('@/context/AuthContext', () => ({ useAuth: () => ({ user: null }) }));
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => (text: string) => text }));
vi.mock('@/hooks/useResponsiveSize', () => ({ useResponsiveSize: (size: number) => size }));
vi.mock('@/hooks/useMedianPageDurationSecs', () => ({
  useMedianPageDurationSecs: () => undefined,
}));
vi.mock('@/components/BookCover', () => ({ default: () => null }));

const initialSettings = useSettingsStore.getState().settings;
const book: Book = {
  hash: 'cloud-disabled',
  title: 'Test Book',
  author: 'Author',
  format: 'EPUB',
  createdAt: 1,
  updatedAt: 1,
  downloadedAt: 1,
};
const props = {
  coverFit: 'crop' as const,
  isSelectMode: false,
  bookSelected: false,
  transferProgress: null,
  handleBookUpload: vi.fn(),
  handleBookDownload: vi.fn(),
  showBookDetailsModal: vi.fn(),
  showTimeRemaining: false,
};
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  useSettingsStore.setState({ settings: initialSettings });
});
describe('library cards without Readest Cloud', () => {
  it.each(['grid', 'list'] as const)('hides cloud transfer controls in %s mode', (mode) => {
    vi.stubEnv('NEXT_PUBLIC_READEST_CLOUD_ENABLED', 'false');
    const view = render(<BookItem {...props} book={book} mode={mode} />);
    expect(screen.queryByRole('button', { name: 'Upload Book' })).toBeNull();
    view.rerender(
      <BookItem
        {...props}
        book={{ ...book, downloadedAt: undefined, uploadedAt: 1 }}
        mode={mode}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Download Book' })).toBeNull();
  });
  it('keeps configured file providers usable without a Readest login', () => {
    vi.stubEnv('NEXT_PUBLIC_READEST_CLOUD_ENABLED', 'false');
    useSettingsStore.setState({
      settings: { ...initialSettings, webdav: { ...initialSettings.webdav, enabled: true } },
    });
    render(<BookItem {...props} book={book} mode='grid' />);
    fireEvent.click(screen.getByRole('button', { name: 'Upload Book' }));
    expect(props.handleBookUpload).toHaveBeenCalledWith(book);
  });
});
