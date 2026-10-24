// src/telegram/outbox.js — outbound message capture (mock mode, D-S15) shared by transports
export function makeOutbox() {
  const items = [];
  return {
    push(entry) { items.push({ ...entry, at: new Date().toISOString() }); if (items.length > 500) items.shift(); },
    all() { return [...items]; },
    last(n = 1) { return items.slice(-n); },
    clear() { items.length = 0; },
  };
}
