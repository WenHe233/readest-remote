'use client';

import { useTranslation } from '@/hooks/useTranslation';

export default function DisabledReadestCloud() {
  const _ = useTranslation();
  return (
    <main className='bg-base-100 text-base-content flex min-h-dvh flex-col items-center justify-center gap-6 p-6'>
      <p>{_('Readest Cloud is disabled in this build.')}</p>
      <a className='btn btn-contrast' href='/library'>
        {_('Back to Library')}
      </a>
    </main>
  );
}
