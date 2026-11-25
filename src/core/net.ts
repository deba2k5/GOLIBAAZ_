/**
 * Thin WebSocket client for the versus relay (server/relay.mjs).
 * The relay only pairs two players and forwards messages, so this is all the networking there is.
 */
export interface NetMsg {
  t: string;
  [k: string]: unknown;
}

type Handler = (m: NetMsg) => void;

/** Where the relay lives. Override with VITE_RELAY_URL when it is hosted separately. */
export function relayUrl(): string {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_RELAY_URL;
  if (env) return env;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws`;
}

export class Net {
  private ws: WebSocket | null = null;
  private handlers = new Set<Handler>();
  private closeHandlers = new Set<() => void>();
  open = false;
  private beat = 0;

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let ws: WebSocket;
      try {
        ws = new WebSocket(relayUrl());
      } catch (err) {
        reject(err);
        return;
      }
      this.ws = ws;
      ws.onopen = () => {
        this.open = true;
        settled = true;
        this.beat = window.setInterval(() => this.send({ t: 'ping' }), 15_000);
        resolve();
      };
      ws.onmessage = (ev) => {
        let m: NetMsg;
        try {
          m = JSON.parse(String(ev.data)) as NetMsg;
        } catch {
          return;
        }
        for (const h of this.handlers) h(m);
      };
      ws.onclose = () => {
        this.open = false;
        if (this.beat) window.clearInterval(this.beat);
        if (!settled) {
          settled = true;
          reject(new Error('Could not reach the game server.'));
        }
        for (const h of this.closeHandlers) h();
      };
      ws.onerror = () => {
        /* onclose follows and reports it */
      };
    });
  }

  send(m: NetMsg): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  on(h: Handler): () => void {
    this.handlers.add(h);
    return () => this.handlers.delete(h);
  }

  onClose(h: () => void): () => void {
    this.closeHandlers.add(h);
    return () => this.closeHandlers.delete(h);
  }

  close(): void {
    if (this.beat) window.clearInterval(this.beat);
    this.handlers.clear();
    this.closeHandlers.clear();
    this.ws?.close();
    this.ws = null;
    this.open = false;
  }
}
