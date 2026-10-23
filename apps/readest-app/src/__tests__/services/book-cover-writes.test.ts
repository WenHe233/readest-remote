import { expect, it, vi } from 'vitest';
import type { Book } from '@/types/book';
import type { FileSystem } from '@/types/system';
import { updateCoverImage } from '@/services/bookService';
import { withBookCoverWrite } from '@/services/bookCoverWrites';

it('queues the real manual cover update behind a running source write', async () => {
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let started!: () => void;
  const writing = new Promise<void>((resolve) => {
    started = resolve;
  });
  let file = '';
  const automatic = withBookCoverWrite('cover-inflight', async () => {
    started();
    await gate;
    file = 'automatic';
  });
  await writing;
  const fs = {
    openFile: vi.fn(async () => new File(['manual'], 'cover.png')),
    writeFile: vi.fn(async (_path: string, _base: string, bytes: ArrayBuffer) => {
      file = new TextDecoder().decode(bytes);
    }),
  };
  const manual = updateCoverImage(
    { fs: fs as unknown as FileSystem, appPlatform: 'tauri', localBooksDir: '/books' },
    { hash: 'cover-inflight' } as Book,
    undefined,
    '/chosen.png',
  );
  await vi.waitFor(() => expect(fs.openFile).toHaveBeenCalledOnce());
  expect(fs.writeFile).not.toHaveBeenCalled();
  finish();
  await Promise.all([automatic, manual]);
  expect(file).toBe('manual');
});
