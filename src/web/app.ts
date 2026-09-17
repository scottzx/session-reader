import { apply } from '../dsh/client.js';

function start(): void {
  apply(undefined);
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
}
