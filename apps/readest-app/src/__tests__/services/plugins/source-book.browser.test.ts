import { afterEach, describe, expect, it, vi } from 'vitest';
import { CFI } from '@/libs/document';
import type { FoliateView } from '@/types/view';
import { makeSourceBook, type SourceBookDocument } from '@/services/contentSources/sourceBook';
import type { SourceBookRef } from '@/services/contentSources/catalog';

let view: FoliateView | undefined;
let book: SourceBookDocument | undefined;
afterEach(() => {
  view?.close();
  view?.remove();
  book?.destroy?.();
});

describe('native source chapters in the reader', () => {
  it('renders lazy chapters through Foliate and navigates using persistent chapter slots', async () => {
    await import('foliate-js/view.js');
    const ref: SourceBookRef = {
      instanceId: '00000000-0000-4000-8000-000000000001',
      pluginId: 'native.text',
      fingerprint: 'a'.repeat(64),
      work: { id: 'work', title: 'Native book', author: 'Author', kind: 'text' },
    };
    const chapters = Array.from({ length: 50 }, (_, index) => ({
      id: `chapter-${index}`,
      title: `Chapter ${index}`,
      slot: 100 + index * 7,
    }));
    const load = vi.fn(async (chapter) => ({
      kind: 'html' as const,
      html: `<p>Native content for ${chapter.id}</p>`,
    }));
    book = makeSourceBook(ref, chapters, load, async () => new Blob());
    view = document.createElement('foliate-view') as FoliateView;
    Object.assign(view.style, {
      width: '800px',
      height: '600px',
      position: 'absolute',
      inset: '0',
    });
    document.body.appendChild(view);
    await view.open(book);
    await view.goTo(CFI.fake.fromIndex(chapters[17]!.slot));
    await vi.waitFor(() => {
      const contents = view!.renderer.getContents();
      expect(
        contents.some((content) =>
          content.doc.body.textContent?.includes('Native content for chapter-17'),
        ),
      ).toBe(true);
    });
    expect(load.mock.calls.length).toBeLessThan(5);
    expect(view.resolveCFI(CFI.fake.fromIndex(chapters[17]!.slot)).index).toBe(17);
  }, 30000);
});
