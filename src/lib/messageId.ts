let sequence = 0;

// Chat message identifiers are local UI keys, never authentication tokens.
// randomUUID is unavailable on ordinary HTTP LAN origins in some browsers.
export function createMessageId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  sequence += 1;
  return `message-${Date.now().toString(36)}-${sequence.toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}
