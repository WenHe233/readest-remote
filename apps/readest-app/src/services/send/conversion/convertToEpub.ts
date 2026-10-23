import { Readability } from '@mozilla/readability';
import { findSiteRule } from './siteRules';
import { ConversionError } from './types';
import type { ConvertibleMime, ConvertedBook } from './types';
import {
  htmlToBook,
  extractHtmlTitle,
  parsePageDocument,
  composeArticleContent,
  buildArticleCover,
  convertPageToEpub,
} from './pageToEpub';
export {
  convertPageToEpub,
  stableIdentifier,
  stripTags,
  safeFileName,
  parsePageDocument,
} from './pageToEpub';

/** Discriminated input — the caller resolves the kind from the MIME type. */
export type ConvertInput =
  | { kind: 'docx'; bytes: ArrayBuffer; fileName?: string }
  | { kind: 'rtf'; bytes: ArrayBuffer; fileName?: string }
  | { kind: 'html'; bytes: ArrayBuffer; fileName?: string }
  | { kind: 'txt'; file: File }
  | { kind: 'article'; html: string; url: string }
  /** Self-contained page clip: like `article` but fetches every referenced
   *  image and embeds it in the EPUB. Only safe from a CORS-free context
   *  (Tauri webview, browser-extension content script). */
  | { kind: 'page'; html: string; url: string };

const MIME_TO_KIND: Record<ConvertibleMime, ConvertInput['kind']> = {
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/rtf': 'rtf',
  'text/rtf': 'rtf',
  'text/html': 'html',
  'application/xhtml+xml': 'html',
  'text/plain': 'txt',
  'text/uri-list': 'article',
};

/** Whether a MIME type needs conversion before the normal import pipeline. */
export function isConvertible(mime: string): mime is ConvertibleMime {
  return mime in MIME_TO_KIND;
}

export function mimeToKind(mime: ConvertibleMime): ConvertInput['kind'] {
  return MIME_TO_KIND[mime];
}

// Best-effort RTF → plain text: drop control words, unescape hex, strip groups.
function rtfToText(rtf: string): string {
  return rtf
    .replace(/\\'[0-9a-fA-F]{2}/g, ' ')
    .replace(/\\par[d]?/g, '\n')
    .replace(/\\[a-zA-Z]+-?\d* ?/g, '')
    .replace(/[{}]/g, '')
    .replace(/\r/g, '')
    .trim();
}

function baseName(fileName: string | undefined, fallback: string): string {
  if (!fileName) return fallback;
  return fileName.replace(/\.[^.]+$/, '').trim() || fallback;
}

/**
 * Convert a document Readest cannot open natively into an EPUB. Runs entirely
 * client-side (browser or Tauri webview) — meant to be called inside a Web
 * Worker so the heavy parsing never blocks the UI thread.
 */
export async function convertToEpub(input: ConvertInput): Promise<ConvertedBook> {
  switch (input.kind) {
    case 'txt': {
      const { TxtToEpubConverter } = await import('@/utils/txt');
      const result = await new TxtToEpubConverter().convert({ file: input.file });
      return { file: result.file, title: result.bookTitle, author: '' };
    }
    case 'docx': {
      if (input.bytes.byteLength === 0) {
        throw new ConversionError('Empty .docx file', 'empty_input');
      }
      let html: string;
      try {
        const mammoth = (await import('mammoth')).default;
        const result = await mammoth.convertToHtml({ arrayBuffer: input.bytes });
        html = result.value;
      } catch (err) {
        throw new ConversionError(`Could not parse .docx: ${String(err)}`, 'parse_failed');
      }
      // Local files have no URL — hash their content for the identifier.
      return htmlToBook(html, baseName(input.fileName, 'Document'), '', html);
    }
    case 'html': {
      const raw = new TextDecoder('utf-8').decode(input.bytes);
      const title = extractHtmlTitle(raw, baseName(input.fileName, 'Document'));
      return htmlToBook(raw, title, '', raw);
    }
    case 'rtf': {
      const rtf = new TextDecoder('utf-8').decode(input.bytes);
      const text = rtfToText(rtf);
      if (!text) {
        throw new ConversionError('Could not extract text from .rtf', 'parse_failed');
      }
      const html = text
        .split(/\n+/)
        .map((line) => `<p>${line.replace(/[<>&]/g, ' ').trim()}</p>`)
        .join('');
      return htmlToBook(html, baseName(input.fileName, 'Document'), '', html);
    }
    case 'article': {
      let parsed: { title?: string | null; content?: string | null; byline?: string | null } | null;
      try {
        parsed = new Readability(parsePageDocument(input.html, input.url)).parse();
      } catch (err) {
        throw new ConversionError(`Could not extract article: ${String(err)}`, 'parse_failed');
      }
      if (!parsed?.content) {
        throw new ConversionError('No readable article found at the URL', 'parse_failed');
      }
      const title = parsed.title?.trim() || extractHtmlTitle(input.html, input.url);
      const byline = parsed.byline?.trim() || '';
      const cover = await buildArticleCover(
        input.html,
        input.url,
        title,
        byline,
        findSiteRule(input.url),
      );
      return htmlToBook(
        composeArticleContent(title, byline, parsed.content),
        title,
        byline,
        input.url,
        [],
        cover,
      );
    }
    case 'page': {
      return convertPageToEpub(input.html, input.url);
    }
    default: {
      throw new ConversionError(
        `Unsupported conversion input: ${(input as { kind: string }).kind}`,
        'unsupported_type',
      );
    }
  }
}
