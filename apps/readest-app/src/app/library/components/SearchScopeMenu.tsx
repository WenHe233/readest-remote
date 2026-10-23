import { useTranslation } from '@/hooks/useTranslation';
import { selectSearchScope, type SearchScope } from '@/services/unifiedSearch';

export default function SearchScopeMenu({
  scopes,
  selected,
  onChange,
}: {
  scopes: SearchScope[];
  selected: string[];
  onChange: (value: string[]) => void;
}) {
  const _ = useTranslation();
  return (
    <div className='dropdown-content no-triangle bg-base-100 eink-bordered z-50 mt-2 max-h-[60dvh] w-72 max-w-[85vw] overflow-y-auto rounded-lg border border-base-200 p-2 shadow-lg'>
      <p className='px-2 py-1 text-sm font-semibold'>{_('Search scope')}</p>
      {scopes.map((scope) => (
        <label
          key={scope.id}
          className='hover:bg-base-200 flex cursor-pointer items-center gap-3 rounded px-2 py-2 text-sm'
        >
          <input
            type='checkbox'
            className='checkbox checkbox-sm'
            checked={selected.includes(scope.id)}
            onChange={() => onChange(selectSearchScope(selected, scope.id))}
          />
          <span className='min-w-0 break-words'>{scope.name}</span>
        </label>
      ))}
      <label className='border-base-200 mt-1 flex cursor-pointer items-center gap-3 border-t px-2 py-3 text-sm'>
        <input
          type='checkbox'
          className='checkbox checkbox-sm'
          checked={selected.includes('text')}
          onChange={() => onChange(selectSearchScope(selected, 'text'))}
        />
        <span>{_('Full Text Search')}</span>
      </label>
      <p className='text-base-content/60 px-2 pb-2 text-xs'>
        {_('Full text searches downloaded text on this device only')}
      </p>
    </div>
  );
}
