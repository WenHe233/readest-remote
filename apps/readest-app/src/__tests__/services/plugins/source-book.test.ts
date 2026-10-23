import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ResourceRef } from '@readest/plugin-sdk';
import { CFI } from '@/libs/document';
import {
  makeSourceBook,
  restoreSourceLocator,
  captureSourceTextAnchor,
} from '@/services/contentSources/sourceBook';
import type { SourceBookRef, ChapterEntry } from '@/services/contentSources/catalog';

const ref: SourceBookRef = {
  instanceId: '00000000-0000-4000-8000-000000000001',
  pluginId: 'native.text',
  fingerprint: 'a'.repeat(64),
  work: { id: 'work', title: 'Book', author: 'Author', kind: 'text' },
};
const chapters: ChapterEntry[] = [
  { id: 'first', title: 'First', slot: 42 },
  { id: 'second', title: 'Second', slot: 7 },
];

describe('network source reader document', () => {
  afterEach(() => vi.restoreAllMocks());

  it('releases only the unloaded section and recreates its chapter and image URLs on revisit', async () => {
    let nextUrl = 0;
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:section-${++nextUrl}`);
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const load = vi.fn(async () => ({ kind: 'html' as const, html: '<img src="image">' }));
    const doc = makeSourceBook(
      ref,
      chapters.map((chapter) => ({ ...chapter, url: 'https://example.com/chapter' })),
      load,
      vi.fn(async () => new Blob(['image'])),
    );
    const first = doc.sections[0]!;
    const second = doc.sections[1]!;
    const firstUrl = await first.load();
    const secondUrl = await second.load();
    first.unload?.();
    expect(revoke.mock.calls.map(([url]) => url)).toEqual(['blob:section-1', firstUrl]);
    expect(await second.load()).toBe(secondUrl);
    expect(await first.load()).not.toBe(firstUrl);
    expect(load).toHaveBeenCalledTimes(3);
    await doc.destroy?.();
    expect(new Set(revoke.mock.calls.map(([url]) => url)).size).toBe(6);
  });

  it('aborts an unloaded section and discards a late image without disrupting its replacement', async () => {
    let nextUrl = 0;
    const create = vi
      .spyOn(URL, 'createObjectURL')
      .mockImplementation(() => `blob:section-${++nextUrl}`);
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    let resolveLate!: (blob: Blob) => void;
    const late = new Promise<Blob>((resolve) => {
      resolveLate = resolve;
    });
    const loadResource = vi.fn(
      async (_resource: ResourceRef, _chapter: ChapterEntry, _signal: AbortSignal) =>
        new Blob(['image']),
    );
    loadResource.mockImplementationOnce(() => late);
    const doc = makeSourceBook(
      ref,
      chapters,
      async () => ({ kind: 'pages', pages: [{ id: 'image' }] }),
      loadResource,
    );
    const section = doc.sections[0]!;
    const stale = section.load();
    const rejection = expect(stale).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(loadResource).toHaveBeenCalledTimes(1));
    const signal = loadResource.mock.calls[0]![2];
    section.unload?.();
    expect(signal.aborted).toBe(true);
    const replacement = await section.load();
    resolveLate(new Blob(['late image']));
    await rejection;
    expect(await section.load()).toBe(replacement);
    expect(create).toHaveBeenCalledTimes(2);
    await doc.destroy?.();
    expect(revoke).toHaveBeenCalledTimes(2);
  });

  it('cancels a pending HTML transform when its section is unloaded', async () => {
    let finishTransform!: (html: string) => void;
    const transform = new Promise<string>((resolve) => {
      finishTransform = resolve;
    });
    const doc = makeSourceBook(
      ref,
      chapters,
      async () => ({ kind: 'html', html: '<p>Chapter</p>' }),
      vi.fn(),
    );
    const listener = vi.fn((event: Event) => {
      (event as CustomEvent<{ data: string | Promise<string> }>).detail.data = transform;
    });
    doc.transformTarget?.addEventListener('data', listener);
    const section = doc.sections[0]!;
    const pending = section.loadContent!();
    const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(1));
    section.unload?.();
    finishTransform('<p>Old transform</p>');
    await rejection;
    await doc.destroy?.();
    await expect(section.load()).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('does not mistake inherited object members for explicit image mappings', async () => {
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:owned');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const loadResource = vi.fn(
      async (_resource: ResourceRef) => new Blob(['image'], { type: 'image/png' }),
    );
    const doc = makeSourceBook(
      ref,
      [{ ...chapters[0]!, url: 'https://source.example/chapter' }],
      async () => ({ kind: 'html', html: '<img src="constructor">', resources: {} }),
      loadResource,
    );
    try {
      await doc.sections[0]!.createDocument();
      expect(loadResource.mock.calls[0]?.[0]).toEqual({
        id: 'https://source.example/constructor',
        url: 'https://source.example/constructor',
      });
    } finally {
      await doc.destroy?.();
      create.mockRestore();
      revoke.mockRestore();
    }
  });
  it('loads only the requested chapter and resolves CFIs by persistent slots after reordering', async () => {
    const load = vi.fn(async (_chapter: ChapterEntry) => ({
      kind: 'html' as const,
      html: '<p>Text</p>',
    }));
    const doc = makeSourceBook(ref, chapters, load, vi.fn());
    expect(load).not.toHaveBeenCalled();
    expect(doc.sections[0]?.cfi).toBe(CFI.fake.fromIndex(42));
    await doc.sections[1]!.createDocument();
    expect(load).toHaveBeenCalledTimes(1);
    expect(load.mock.calls[0]?.[0]).toEqual(chapters[1]);
    const reordered = makeSourceBook(ref, [...chapters].reverse(), load, vi.fn());
    expect(reordered.resolveCFI?.(CFI.fake.fromIndex(42))?.index).toBe(1);
    expect(reordered.resolveCFI?.(CFI.fake.fromIndex(100))).toBeNull();
  });

  it('removes active markup and replaces every network image with a broker-owned blob', async () => {
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:owned-image');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const loadResource = vi.fn(async () => new Blob(['image'], { type: 'image/png' }));
    const doc = makeSourceBook(
      ref,
      chapters,
      async () => ({
        kind: 'html',
        html: '<script>evil()</script><img src="https://example.com/a.png" onerror="evil()"><iframe src="https://example.com"></iframe>',
      }),
      loadResource,
    );
    const chapterDoc = await doc.sections[0]!.createDocument();
    expect(chapterDoc.querySelector('script,iframe,[onerror]')).toBeNull();
    expect(chapterDoc.querySelector('img')?.getAttribute('src')).toBe('blob:owned-image');
    expect(loadResource).toHaveBeenCalledTimes(1);
    await doc.destroy?.();
    expect(revoke).toHaveBeenCalledWith('blob:owned-image');
    create.mockRestore();
    revoke.mockRestore();
  });

  it('recovers a text anchor after preceding content changes and marks missing anchors approximate', async () => {
    const previous = new DOMParser().parseFromString(
      '<p>Before target passage after</p>',
      'text/html',
    );
    const range = previous.createRange();
    range.setStart(previous.querySelector('p')!.firstChild!, 7);
    range.setEnd(previous.querySelector('p')!.firstChild!, 21);
    const anchor = captureSourceTextAnchor(range);
    const doc = makeSourceBook(
      ref,
      chapters,
      async () => ({ kind: 'html', html: '<p>Inserted words. Before target passage after</p>' }),
      vi.fn(),
    );
    const locator = { workId: 'work', chapterId: 'first', text: anchor, modified: 1 };
    const restored = await restoreSourceLocator(doc, locator);
    expect(restored?.approximate).toBe(false);
    const resolved = doc.resolveCFI?.(restored!.cfi);
    const restoredRange = resolved?.anchor?.(await doc.sections[0]!.createDocument()) as Range;
    expect(restoredRange.toString()).toContain('target passage');
    expect(
      (await restoreSourceLocator(doc, { ...locator, text: { exact: 'deleted passage' } }))
        ?.approximate,
    ).toBe(true);
  });
});
