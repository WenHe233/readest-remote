// Komga only exposes resources listed in the EPUB manifest, not container.xml or OPF.
// Reconstruct those small documents from its Readium manifest; chapter/resource bytes
// still come from the server unchanged and foliate-js handles EPUB loading.
interface Link {
  href: string;
  type?: string;
  title?: string;
  children?: Link[];
}
export interface EpubManifest {
  readingOrder: Link[];
  resources?: Link[];
  toc?: Link[];
}
const xml = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
export function epubPackage(
  manifest: EpubManifest,
  title: string,
  author: string,
): Record<string, string> {
  const path = (href: string): string => {
    const url = new URL(href, 'https://resource.invalid');
    const marker = '/resource/';
    const i = url.pathname.indexOf(marker);
    if (i < 0) throw new Error('Publication resource URL is invalid');
    return decodeURIComponent(url.pathname.slice(i + marker.length)) + url.hash;
  };
  const links = [
    ...manifest.readingOrder,
    ...(manifest.resources ?? []).filter((l) => l.href.includes('/resource/')),
  ];
  const entries = [...new Map(links.map((l) => [path(l.href).split('#')[0]!, l])).entries()];
  const ids = new Map(entries.map(([name], i) => [name, 'item' + i]));
  const items = entries
    .map(
      ([name, l]) =>
        `<item id="${ids.get(name)}" href="${xml(encodeURI(name))}" media-type="${xml(l.type ?? 'application/octet-stream')}"/>`,
    )
    .join('');
  const spine = manifest.readingOrder
    .map((l) => `<itemref idref="${ids.get(path(l.href).split('#')[0]!)}"/>`)
    .join('');
  const navigation = (links: Link[]): string =>
    '<ol>' +
    links
      .map(
        (l) =>
          `<li><a href="${xml(encodeURI(path(l.href).split('#')[0]!) + new URL(l.href, 'https://resource.invalid').hash)}">${xml(l.title ?? '')}</a>${l.children?.length ? navigation(l.children) : ''}</li>`,
      )
      .join('') +
    '</ol>';
  return {
    'META-INF/container.xml':
      '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="readest-remote.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
    'readest-remote.opf': `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="book-id">remote-publication</dc:identifier><dc:title>${xml(title)}</dc:title><dc:creator>${xml(author)}</dc:creator><dc:language>und</dc:language></metadata><manifest>${items}<item id="remote-nav" href="readest-navigation.xhtml" media-type="application/xhtml+xml" properties="nav"/></manifest><spine>${spine}</spine></package>`,
    'readest-navigation.xhtml': `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>${xml(title)}</title></head><body><nav epub:type="toc">${navigation(manifest.toc ?? [])}</nav></body></html>`,
  };
}
