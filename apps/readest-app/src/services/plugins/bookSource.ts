import type { Book } from '@/types/book';
import { externalBookSourceSchema, type ExternalBookSource } from './types';
const validated = new WeakMap<object, ExternalBookSource | undefined>();
export const getExternalSource = (book: Book): ExternalBookSource | undefined => {
  const value = book.externalSource ?? book.metadata?.externalSource;
  if (!value) return undefined;
  if (validated.has(value)) return validated.get(value);
  const parsed = externalBookSourceSchema.safeParse(value);
  const source = parsed.success ? parsed.data : undefined;
  validated.set(value, source);
  return source;
};
