import { create } from 'zustand';
import type { PluginHostCall } from '@readest/plugin-sdk';

type FormRequest = Extract<
  PluginHostCall,
  { capability: 'source.interaction' }
>['payload']['request'];
export interface SourceInteraction {
  id: string;
  instanceId: string;
  request: FormRequest;
  answer: (values: Record<string, string | boolean | number> | null) => void;
}
export const useSourceInteractions = create<{ pending: SourceInteraction[] }>(() => ({
  pending: [],
}));

export function requestSourceInteraction(
  instanceId: string,
  request: FormRequest,
  signal: AbortSignal,
): Promise<Record<string, string | boolean | number> | null> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const finish = () => {
      signal.removeEventListener('abort', abort);
      useSourceInteractions.setState((state) => ({
        pending: state.pending.filter((item) => item.id !== id),
      }));
    };
    const abort = () => {
      finish();
      reject(new DOMException('Cancelled', 'AbortError'));
    };
    signal.addEventListener('abort', abort, { once: true });
    useSourceInteractions.setState((state) => ({
      pending: [
        ...state.pending,
        {
          id,
          instanceId,
          request,
          answer: (values) => {
            finish();
            resolve(values);
          },
        },
      ],
    }));
  });
}
