import { describe, expect, it } from 'bun:test';
import { finalizeEvent, generateSecretKey } from 'nostr-tools';
import { NostrRelay } from './relay.js';

type FakeSocket = {
  data: unknown;
  sent: string[];
  closed: boolean;
  send: (message: string) => void;
  close: () => void;
};

type RelayHandler = ReturnType<NostrRelay['handler']>;
type HandlerSocket = Parameters<NonNullable<RelayHandler['open']>>[0];

function asHandlerSocket(socket: FakeSocket): HandlerSocket {
  return socket as unknown as HandlerSocket;
}

function createFakeSocket(): FakeSocket {
  return {
    data: null,
    sent: [],
    closed: false,
    send(message: string) {
      this.sent.push(message);
    },
    close() {
      this.closed = true;
    },
  };
}

function decodeSent(socket: FakeSocket): unknown[][] {
  return socket.sent.map((message) => JSON.parse(message) as unknown[]);
}

describe('NostrRelay REQ handling', () => {
  it('normalizes wrapped nostr-tools REQ filter arrays into subscriptions', () => {
    const relay = new NostrRelay({ info: false, debug: false });
    const socket = createFakeSocket();
    const ws = asHandlerSocket(socket);
    const handler = relay.handler();

    handler.open?.(ws);
    handler.message?.(ws, JSON.stringify(['REQ', 'sub-1', [{ kinds: [1] }]]));

    expect(relay.subs.size).toBe(1);
    const [sub] = Array.from(relay.subs.values());
    expect(sub?.sub_id).toBe('sub-1');
    expect(sub?.filters).toHaveLength(1);
    expect((sub?.filters[0] as { kinds?: number[] }).kinds).toEqual([1]);

    const messages = decodeSent(socket);
    expect(messages).toContainEqual(['EOSE', 'sub-1']);
  });

  it('rejects REQ with an empty wrapped filter array', () => {
    const relay = new NostrRelay({ info: false, debug: false });
    const socket = createFakeSocket();
    const ws = asHandlerSocket(socket);
    const handler = relay.handler();

    handler.open?.(ws);
    handler.message?.(ws, JSON.stringify(['REQ', 'sub-empty', []]));

    expect(relay.subs.size).toBe(0);
    const messages = decodeSent(socket);
    expect(messages).toContainEqual(['NOTICE', 'sub-empty', 'REQ requires at least one filter']);
  });

  it('rejects REQ with no filters', () => {
    const relay = new NostrRelay({ info: false, debug: false });
    const socket = createFakeSocket();
    const ws = asHandlerSocket(socket);
    const handler = relay.handler();

    handler.open?.(ws);
    handler.message?.(ws, JSON.stringify(['REQ', 'sub-empty-no-filters']));

    expect(relay.subs.size).toBe(0);
    const messages = decodeSent(socket);
    expect(messages).toContainEqual(['NOTICE', 'sub-empty-no-filters', 'REQ requires at least one filter']);
  });

  it('accepts canonical multi-filter REQ payloads and creates a subscription', () => {
    const relay = new NostrRelay({ info: false, debug: false });
    const socket = createFakeSocket();
    const ws = asHandlerSocket(socket);
    const handler = relay.handler();

    handler.open?.(ws);
    const authorHex = 'f'.repeat(64);
    handler.message?.(ws, JSON.stringify(['REQ', 'sub-multi', { kinds: [1] }, { authors: [authorHex] }]));

    expect(relay.subs.size).toBe(1);
    const [sub] = Array.from(relay.subs.values());
    expect(sub?.sub_id).toBe('sub-multi');
    expect(sub?.filters).toHaveLength(2);
    expect((sub?.filters[0] as { kinds?: number[] }).kinds).toEqual([1]);
    expect((sub?.filters[1] as { authors?: string[] }).authors).toEqual([authorHex]);

    const messages = decodeSent(socket);
    expect(messages).toContainEqual(['EOSE', 'sub-multi']);
  });

  it('removes composed-key subscriptions when CLOSE/unsubscribe is processed', () => {
    const relay = new NostrRelay({ info: false, debug: false });
    const socket = createFakeSocket();
    const ws = asHandlerSocket(socket);
    const handler = relay.handler();

    handler.open?.(ws);
    handler.message?.(ws, JSON.stringify(['REQ', 'sub-close', { kinds: [1] }]));
    expect(relay.subs.size).toBe(1);

    handler.message?.(ws, JSON.stringify(['CLOSE', 'sub-close']));
    expect(relay.subs.size).toBe(0);

    handler.message?.(ws, JSON.stringify(['REQ', 'sub-cleanup', { kinds: [1] }]));
    expect(relay.subs.size).toBe(1);

    const closeHandler = handler.close as unknown as ((socketArg: HandlerSocket, code: number) => void) | undefined;
    closeHandler?.(ws, 1000);
    expect(relay.subs.size).toBe(0);
    expect(socket.closed).toBe(true);
  });

  it('applies filter.limit to matched events only', () => {
    const relay = new NostrRelay({ info: false, debug: false });
    const socket = createFakeSocket();
    const ws = asHandlerSocket(socket);
    const handler = relay.handler();

    const unmatched = {
      id: 'u'.repeat(64),
      pubkey: 'a'.repeat(64),
      created_at: 1,
      kind: 9,
      tags: [],
      content: '',
      sig: 'b'.repeat(128),
    } as Parameters<NostrRelay['store']>[0];
    const matchedA = {
      id: 'c'.repeat(64),
      pubkey: 'a'.repeat(64),
      created_at: 2,
      kind: 1,
      tags: [],
      content: '',
      sig: 'd'.repeat(128),
    } as Parameters<NostrRelay['store']>[0];
    const matchedB = {
      id: 'e'.repeat(64),
      pubkey: 'a'.repeat(64),
      created_at: 3,
      kind: 1,
      tags: [],
      content: '',
      sig: 'f'.repeat(128),
    } as Parameters<NostrRelay['store']>[0];

    relay.store(unmatched);
    relay.store(matchedA);
    relay.store(matchedB);

    handler.open?.(ws);
    handler.message?.(ws, JSON.stringify(['REQ', 'sub-limit', { kinds: [1], limit: 1 }]));

    const messages = decodeSent(socket);
    const eventMessages = messages.filter((msg) => msg[0] === 'EVENT');
    expect(eventMessages).toHaveLength(1);
    expect(eventMessages[0]?.[1]).toBe('sub-limit');
    expect((eventMessages[0]?.[2] as { kind?: number }).kind).toBe(1);
    expect((eventMessages[0]?.[2] as { id?: string }).id).toBe(matchedB.id);
    expect(messages).toContainEqual(['EOSE', 'sub-limit']);
  });
});

describe('NostrRelay EVENT storage', () => {
  it('forwards ephemeral events but only stores regular ones (NIP-01)', () => {
    const relay = new NostrRelay({ info: false, debug: false });
    const handler = relay.handler();
    const listener = createFakeSocket();
    const publisher = createFakeSocket();
    handler.open?.(asHandlerSocket(listener));
    handler.open?.(asHandlerSocket(publisher));
    handler.message?.(asHandlerSocket(listener), JSON.stringify(['REQ', 'live', { kinds: [1, 20000] }]));

    const sk = generateSecretKey();
    const now = Math.floor(Date.now() / 1000);
    const ephemeral = finalizeEvent({ kind: 20000, created_at: now, tags: [], content: 'rpc' }, sk);
    const regular = finalizeEvent({ kind: 1, created_at: now, tags: [], content: 'note' }, sk);
    handler.message?.(asHandlerSocket(publisher), JSON.stringify(['EVENT', ephemeral]));
    handler.message?.(asHandlerSocket(publisher), JSON.stringify(['EVENT', regular]));

    const live = decodeSent(listener).filter((m) => m[0] === 'EVENT').map((m) => (m[2] as { id: string }).id);
    expect(live).toEqual([ephemeral.id, regular.id]);
    expect(relay.cache.map((e) => e.id)).toEqual([regular.id]);
  });
});
