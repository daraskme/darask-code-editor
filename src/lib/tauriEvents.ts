import { listen } from '@tauri-apps/api/event';
import { isTauri } from './fs';

/**
 * @tauri-apps/api/event の listen() を型安全にラップする(PHASE3A-SPEC.md 2.1)。
 * listen() は unlisten 関数を Promise で返すため、内部で解決してから保持する。
 * 呼び出し側は同期的に返る unlisten 関数だけを扱えばよい。
 */
export function subscribeEvent<T>(name: string, handler: (payload: T) => void): () => void {
  if (!isTauri()) return () => {};

  let unlisten: (() => void) | null = null;
  let cancelled = false;

  listen<T>(name, (event) => handler(event.payload))
    .then((fn) => {
      if (cancelled) {
        fn();
      } else {
        unlisten = fn;
      }
    })
    .catch((err) => {
      console.error(`subscribeEvent(${name}) failed`, err);
    });

  return () => {
    cancelled = true;
    if (unlisten) {
      unlisten();
      unlisten = null;
    }
  };
}
