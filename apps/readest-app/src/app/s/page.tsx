import type { Metadata } from 'next';
import { Suspense } from 'react';
import { READEST_WEB_BASE_URL, SHARE_BASE_URL } from '@/services/constants';
import { resolveActiveShare } from '@/libs/shareServer';
import ShareLanding from './ShareLanding';

// Server-rendered metadata for chat unfurls. Lives on the page (not the
// layout) because Next only passes `searchParams` to page-level
// `generateMetadata` — layout metadata is shared across child pages and
// can't see the query string.
//
// Tauri and downloadable Web exports cannot generate request-specific metadata.
// The client landing page still reads the token from the query string.

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export async function generateMetadata({ searchParams }: PageProps): Promise<Metadata> {
  // Reuse V1's static export guard while retaining hosted Web unfurl metadata.
  if (
    process.env['NEXT_PUBLIC_APP_PLATFORM'] !== 'web' ||
    process.env['BUILD_STATIC_WEB'] === 'true'
  ) {
    return {
      title: 'Open in Readest',
      description: 'Open-source ebook reader for everyone, on every device.',
    };
  }

  const params = (await searchParams) ?? {};
  const tokenParam = params['token'];
  const token = Array.isArray(tokenParam) ? tokenParam[0] : tokenParam;

  if (!token) {
    return {
      title: 'Open in Readest',
      description: 'Open-source ebook reader for everyone, on every device.',
    };
  }

  const result = await resolveActiveShare(token);
  if (!result.ok) {
    return {
      title: 'Share link unavailable · Readest',
      description: 'This share link is no longer available.',
    };
  }
  const { share } = result;
  const shareUrl = `${SHARE_BASE_URL}/${token}`;
  const ogImage = `${READEST_WEB_BASE_URL}/api/share/${token}/og.png`;

  return {
    title: `${share.bookTitle} · Shared via Readest`,
    description: share.bookAuthor
      ? `${share.bookAuthor} · Shared via Readest`
      : 'Shared via Readest',
    openGraph: {
      type: 'book',
      url: shareUrl,
      title: share.bookTitle,
      description: share.bookAuthor
        ? `${share.bookAuthor} · Shared via Readest`
        : 'Shared via Readest',
      images: [{ url: ogImage, width: 1200, height: 630 }],
    },
    twitter: {
      card: 'summary_large_image',
      title: share.bookTitle,
      description: share.bookAuthor
        ? `${share.bookAuthor} · Shared via Readest`
        : 'Shared via Readest',
      images: [ogImage],
    },
  };
}

export default function Page() {
  // Client child uses useSearchParams, which Next 16 requires to be wrapped
  // in Suspense. Mirrors src/app/o/page.tsx.
  return (
    <Suspense fallback={null}>
      <ShareLanding />
    </Suspense>
  );
}
