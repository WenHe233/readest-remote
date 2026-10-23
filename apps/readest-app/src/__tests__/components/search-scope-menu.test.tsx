import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import SearchScopeMenu from '@/app/library/components/SearchScopeMenu';
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => (value: string) => value }));
const scopes = [
  { id: 'local', kind: 'local' as const, name: 'Local imports' },
  { id: 'source:a', kind: 'source' as const, name: 'Example source' },
];
it('selects sources with checkboxes and makes full text exclusive', () => {
  const change = vi.fn();
  render(<SearchScopeMenu scopes={scopes} selected={['local']} onChange={change} />);
  fireEvent.click(screen.getByRole('checkbox', { name: 'Example source' }));
  expect(change).toHaveBeenLastCalledWith(['local', 'source:a']);
  fireEvent.click(screen.getByRole('checkbox', { name: 'Full Text Search' }));
  expect(change).toHaveBeenLastCalledWith(['text']);
});
