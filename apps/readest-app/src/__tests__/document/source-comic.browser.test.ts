import { afterEach, describe, expect, it, vi } from 'vitest';
import 'foliate-js/view.js';
import { makeSourceBook } from '@/services/contentSources/sourceBook';
import type { SourceBookRef } from '@/services/contentSources/catalog';
import type { FoliateView } from '@/types/view';
import type { ResourceRef } from '@readest/plugin-sdk';
import type { ChapterEntry } from '@/services/contentSources/catalog';

const views: FoliateView[] = [];
afterEach(() => {
  for (const view of views.splice(0)) {
    view.close();
    void view.book.destroy?.();
    view.remove();
  }
});
const image = new Blob(
  [
    '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="600"><rect width="400" height="600" fill="blue"/></svg>',
  ],
  { type: 'image/svg+xml' },
);
async function open(scroll = false, failPage?: string, target = '7', invalidPage?: string) {
  let failed = false;
  const loadResource = vi.fn(
    async (resource: ResourceRef, _chapter: ChapterEntry, _signal: AbortSignal) => {
      if (resource.id === invalidPage && !failed) {
        failed = true;
        return new Blob(['not an image'], { type: 'image/png' });
      }
      if (resource.id === failPage && !failed) {
        failed = true;
        throw new Error('offline');
      }
      return image;
    },
  );
  const doc = makeSourceBook(
    { instanceId: 'one', work: { id: 'comic', kind: 'comic', title: 'Comic' } } as SourceBookRef,
    [
      { id: 'a', title: 'A', slot: 7 },
      { id: 'b', title: 'B', slot: 8 },
    ],
    async (chapter) => ({
      kind: 'pages',
      pages:
        chapter.id === 'a'
          ? [{ id: 'a1' }, { id: 'a2' }]
          : [{ id: 'b1' }, { id: 'b2' }, { id: 'b3' }],
    }),
    loadResource,
  );
  doc.setPreloadPages?.(0);
  const view = document.createElement('foliate-view') as FoliateView;
  view.style.cssText = 'display:block;width:400px;height:600px';
  document.body.append(view);
  views.push(view);
  await view.open(doc);
  view.renderer.setAttribute('spread', 'none');
  if (scroll) view.renderer.setAttribute('flow', 'scrolled');
  await view.goTo(target);
  return { view, doc, loadResource };
}
describe('source comic in the standard fixed-layout reader', () => {
  it('releases a slow chapter parser before entering the next chapter in a serial runtime', async () => {
    let parserSignal: AbortSignal | undefined;
    const doc = makeSourceBook(
      { instanceId: 'one', work: { id: 'comic', kind: 'comic', title: 'Comic' } } as SourceBookRef,
      [
        { id: 'a', title: 'A', slot: 1 },
        { id: 'b', title: 'B', slot: 2 },
        { id: 'c', title: 'C', slot: 3 },
      ],
      async (chapter, signal) => {
        if (chapter.id === 'b') {
          parserSignal = signal;
          return new Promise<never>((_resolve, reject) =>
            signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
          );
        }
        if (chapter.id === 'c') expect(parserSignal?.aborted).toBe(true);
        return { kind: 'pages', pages: [{ id: `${chapter.id}-page` }] };
      },
      async () => image,
    );
    doc.setPreloadPages?.(0);
    doc.rendition.spread = 'none';
    const view = document.createElement('foliate-view') as FoliateView;
    view.style.cssText = 'display:block;width:400px;height:600px';
    views.push(view);
    document.body.append(view);
    await view.open(doc);
    await view.goTo('1');
    const old = view.goTo('2');
    await expect.poll(() => !!parserSignal).toBe(true);
    await view.goTo('3');
    await old;
    expect(parserSignal?.aborted).toBe(true);
    expect(doc.getSourceLocator?.(view.renderer.primaryIndex)?.resourceId).toBe('c-page');
  });
  it('cancels a slow page when a newer chapter jump wins', async () => {
    const { view, doc, loadResource } = await open();
    let finish!: (blob: Blob) => void;
    let oldSignal!: AbortSignal;
    loadResource.mockImplementation(async (resource, _chapter, signal) => {
      if (resource.id === 'a2') {
        oldSignal = signal;
        return new Promise<Blob>((resolve) => {
          finish = resolve;
        });
      }
      return image;
    });
    const first = view.goTo('7#1');
    await expect.poll(() => !!finish).toBe(true);
    await view.goTo('8#2');
    finish(image);
    await first;
    const visible =
      view.renderer.getContents().find((content) => content.index === view.renderer.primaryIndex)
        ?.index ?? -1;
    expect(doc.getSourceLocator?.(visible)?.resourceId).toBe('b3');
    expect(oldSignal.aborted).toBe(true);
  });
  it('turns through lazily expanded chapters and navigates the original chapter directory', async () => {
    const { view, doc } = await open();
    expect(view.isFixedLayout).toBe(true);
    expect(view.renderer.tagName).toBe('FOLIATE-FXL');
    expect(doc.getSourceLocator?.(view.renderer.primaryIndex)?.resourceId).toBe('a1');
    await view.next();
    expect(doc.getSourceLocator?.(view.renderer.primaryIndex)?.resourceId).toBe('a2');
    await view.next();
    expect(doc.getSourceLocator?.(view.renderer.primaryIndex)?.resourceId).toBe('b1');
    await view.goTo('8#2');
    expect(doc.getSourceLocator?.(view.renderer.primaryIndex)?.resourceId).toBe('b3');
    await view.goTo('7');
    expect(doc.getSourceLocator?.(view.renderer.primaryIndex)?.resourceId).toBe('a1');
  });
  it('updates the continuous scroll strip without losing the current page', async () => {
    const { view, doc } = await open(true);
    await expect.poll(() => view.renderer.getContents().length).toBeGreaterThan(0);
    view.renderer.scrollTop = view.renderer.scrollHeight - view.renderer.clientHeight;
    view.renderer.dispatchEvent(new Event('scroll'));
    await expect.poll(() => doc.sections.length).toBe(5);
    await view.goTo('8#2');
    await expect
      .poll(() => doc.getSourceLocator?.(view.renderer.primaryIndex)?.resourceId)
      .toBe('b3');
    expect(view.renderer.pages).toBe(5);
  });
  it('keeps a distant chapter visible when an earlier chapter expands', async () => {
    const { view, doc } = await open(true, undefined, '8#2');
    await expect
      .poll(() => doc.getSourceLocator?.(view.renderer.primaryIndex)?.resourceId)
      .toBe('b3');
    const before = view.renderer.scrollTop;
    await doc.prepareNavigation?.('7');
    expect(doc.getSourceLocator?.(view.renderer.primaryIndex)?.resourceId).toBe('b3');
    expect(view.renderer.scrollTop).toBeGreaterThan(before);
  });
  it('keeps the visible page on failure and retries the requested page', async () => {
    const { view, doc } = await open(false, 'a2');
    const errors = vi.fn();
    view.addEventListener('load-error', errors);
    await view.next();
    expect(errors).toHaveBeenCalledTimes(1);
    expect(doc.getSourceLocator?.(view.renderer.primaryIndex)?.resourceId).toBe('a1');
    const target = (errors.mock.calls[0]![0] as CustomEvent<{ target: number }>).detail.target;
    await view.goTo(target);
    expect(doc.getSourceLocator?.(view.renderer.primaryIndex)?.resourceId).toBe('a2');
  });
  it('reports undecodable images instead of treating an empty page as a successful read', async () => {
    const { view, doc } = await open(false, undefined, '7', 'a2');
    const errors = vi.fn();
    view.addEventListener('load-error', errors);
    await view.next();
    expect(errors).toHaveBeenCalledTimes(1);
    expect(doc.getSourceLocator?.(view.renderer.primaryIndex)?.resourceId).toBe('a1');
    await doc.retrySection?.(1);
    await view.goTo(1);
    expect(doc.getSourceLocator?.(view.renderer.primaryIndex)?.resourceId).toBe('a2');
  });
});
