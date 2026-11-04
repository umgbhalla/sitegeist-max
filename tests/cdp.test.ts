import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { cdp } from '../src/tools/repl/browser/cdp-helpers.ts';

const calls: Array<{ tabId: number; method: string }> = [];
let activeTabId = 10;
let detachOnce = false;
Object.assign(globalThis, {
  chrome: {
    tabs: { query: async () => [{ id: activeTabId, url: 'https://example.com' }] },
    runtime: {},
    debugger: {
      attach: (_target: { tabId: number }, _version: string, done: () => void) => done(),
      sendCommand: async (target: { tabId: number }, method: string) => {
        calls.push({ tabId: target.tabId, method });
        if (detachOnce) {
          detachOnce = false;
          activeTabId = 20;
          throw new Error('Detached');
        }
        return { ok: true };
      },
    },
  },
});
mock.timers.enable({ apis: ['setInterval'] });
try {
  // No DOM or dialog exists: both reads and mutations must complete directly.
  for (const [domain, method] of [['DOM', 'getDocument'], ['Runtime', 'evaluate'], ['Input', 'dispatchMouseEvent'], ['Storage', 'clearDataForOrigin']]) {
    assert.deepEqual(await cdp(domain, method), { ok: true });
  }
  assert.equal(calls.length, 4);
  detachOnce = true;
  await cdp('Runtime', 'evaluate');
  assert.deepEqual(calls.slice(-2), [
    { tabId: 10, method: 'Runtime.evaluate' },
    { tabId: 10, method: 'Runtime.evaluate' },
  ]);
  console.log('CDP calls need no dialog; detached retries preserve the target tab.');
} finally {
  mock.timers.reset();
}
