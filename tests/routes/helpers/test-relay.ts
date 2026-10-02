/**
 * Minimal in-memory Nostr relay for tests (NIP-01 EVENT / REQ / CLOSE) on
 * Bun.serve, with hooks for misbehaving relays. Mirrors the TestRelay in
 * hasky00/cinderella (src/test/relay.ts). No signature checks.
 */

import type { Server, ServerWebSocket } from 'bun';

type Event = { id: string; pubkey: string; kind: number; created_at: number; tags: string[][] };
type Filter = { ids?: string[]; authors?: string[]; kinds?: number[]; since?: number; until?: number; limit?: number; [k: string]: unknown };

function matches(ev: Event, f: Filter): boolean {
  if (f.ids && !f.ids.includes(ev.id)) return false;
  if (f.authors && !f.authors.includes(ev.pubkey)) return false;
  if (f.kinds && !f.kinds.includes(ev.kind)) return false;
  if (f.since !== undefined && ev.created_at < f.since) return false;
  if (f.until !== undefined && ev.created_at > f.until) return false;
  for (const [k, v] of Object.entries(f)) {
    if (!k.startsWith('#') || !Array.isArray(v)) continue;
    if (!ev.tags.some(t => t[0] === k.slice(1) && v.includes(t[1]))) return false;
  }
  return true;
}

export class TestRelay {
  private server: Server | null = null;
  private port = 0;
  private events: Event[] = [];
  private subs = new Map<ServerWebSocket<unknown>, Map<string, Filter[]>>();

  /** Keep connections open but never answer anything (a stalled relay). */
  frozen = false;
  /** Answer every REQ with CLOSED. */
  closeEveryReq = false;
  /** Hang up right after each connection opens. */
  dropOnConnect = false;
  /** REQs (excluding heartbeat probes) and connections seen. */
  reqCount = 0;
  connCount = 0;

  /** Stays the same while the relay is stopped (for restarts on the same port). */
  get url(): string { return `ws://127.0.0.1:${this.port}`; }
  /** Connections open right now. */
  get openCount(): number { return this.subs.size; }

  start(port = this.port): void {
    this.server = Bun.serve({
      port,
      hostname: '127.0.0.1',
      fetch: (req, srv) => (srv.upgrade(req, { data: undefined }) ? undefined : new Response('relay')),
      websocket: {
        open: ws => {
          this.connCount += 1;
          if (this.dropOnConnect) { ws.close(); return; }
          this.subs.set(ws, new Map());
        },
        close: ws => { this.subs.delete(ws); },
        message: (ws, raw) => this.handle(ws, String(raw)),
      },
    });
    this.port = this.server.port;
  }

  stop(): void {
    this.server?.stop(true);
    this.server = null;
    this.subs.clear();
  }

  /** Send a raw EVENT frame to every open subscription, e.g. a malformed event. */
  sendRaw(payload: unknown): void {
    for (const [ws, subs] of this.subs) for (const sid of subs.keys()) ws.send(JSON.stringify(['EVENT', sid, payload]));
  }

  private handle(ws: ServerWebSocket<unknown>, raw: string): void {
    if (this.frozen) return;
    let msg: any[];
    try { msg = JSON.parse(raw); } catch { return; }
    const send = (m: unknown[]) => { try { ws.send(JSON.stringify(m)); } catch {} };
    if (msg[0] === 'EVENT') {
      const ev = msg[1] as Event;
      this.events.push(ev);
      send(['OK', ev.id, true, '']);
      for (const [client, subs] of this.subs) {
        for (const [sid, filters] of subs) if (filters.some(f => matches(ev, f))) client.send(JSON.stringify(['EVENT', sid, ev]));
      }
    } else if (msg[0] === 'REQ') {
      const [, sid, ...filters] = msg as [string, string, ...Filter[]];
      if (!String(sid).startsWith('hb-')) this.reqCount += 1;
      if (this.closeEveryReq) { send(['CLOSED', sid, 'error: closed for testing']); return; }
      this.subs.get(ws)?.set(sid, filters);
      for (const ev of this.events) if (filters.some(f => matches(ev, f))) send(['EVENT', sid, ev]);
      send(['EOSE', sid]);
    } else if (msg[0] === 'CLOSE') {
      this.subs.get(ws)?.delete(msg[1]);
    }
  }
}
