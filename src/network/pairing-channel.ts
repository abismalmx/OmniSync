/**
 * OmniSync - Canal de vinculación efímera
 *
 * Transporte mínimo para el intercambio de `pairing-session.ts`:
 *  - `nostr`: eventos efímeros kind 25000 en un relay público (sin montar nada).
 *  - `worker`: sala de vinculación del Worker propio (`/?pair=<sala>`, sin
 *    autenticación NIP-98 porque el dispositivo nuevo aún no está autorizado).
 * Ambos solo transportan mensajes ya autenticados por el token; el canal no
 * añade confianza.
 */

import { finalizeEvent, generateSecretKey, verifyEvent, type Event } from 'nostr-tools';
import { validateSecureWebSocketUrl } from '../security/network-security';
import { buildAuthenticatedSignalingUrl } from '../security/worker-auth';
import { isPlainObject } from '../security/vault-security';
import {
  PAIRING_TOKEN_TTL_MS,
  PairingGuestSession,
  PairingHostSession,
  PairingInvite,
  PairingTransportKind,
  PairingWireMessage,
  derivePairingRoom,
  generatePairingToken,
  validateWireMessage,
} from '../security/pairing-session';

const MAX_FRAME_LENGTH = 16 * 1024;
const NOSTR_EVENT_MAX_AGE_SECONDS = 10 * 60;
const GUEST_TIMEOUT_MS = 30_000;
/** Margen para que llegue el `done` de un intercambio ya iniciado al caducar el código. */
const EXCHANGE_GRACE_MS = 15_000;

/** Relay Nostr por defecto cuando el servidor configurado no es uno. */
export const DEFAULT_PAIRING_RELAY = 'wss://nos.lol';

class PairingTransport {
  private ws: WebSocket | null = null;
  private closed = false;
  private readonly nostrKey = generateSecretKey();
  public onMessage?: (msg: PairingWireMessage) => void;
  public onClose?: () => void;

  constructor(
    private readonly kind: PairingTransportKind,
    private readonly server: string,
    private readonly room: string,
    /** Solo el anfitrión del canal Worker: clave derivada que abre la sala con NIP-98. */
    private readonly workerAuthKey?: Uint8Array
  ) {}

  public open(): Promise<void> {
    return new Promise((resolve, reject) => {
      let url: string;
      try {
        url = validateSecureWebSocketUrl(this.server);
        if (this.kind === 'worker') {
          if (this.workerAuthKey) {
            url = buildAuthenticatedSignalingUrl(url, this.room, this.workerAuthKey, Date.now(), 'pair');
          } else {
            const u = new URL(url);
            u.searchParams.set('pair', this.room);
            url = u.toString();
          }
        }
      } catch (err) {
        reject(err);
        return;
      }
      const ws = new WebSocket(url);
      this.ws = ws;
      const timer = setTimeout(() => {
        reject(new Error('Tiempo de espera agotado al conectar con el canal de vinculación.'));
        this.close();
      }, 10_000);
      ws.onopen = () => {
        clearTimeout(timer);
        if (this.kind === 'nostr') {
          ws.send(JSON.stringify(['REQ', `pair-${this.room.slice(0, 8)}`, { kinds: [25000], '#t': [this.room] }]));
        }
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error('No se pudo conectar con el canal de vinculación.'));
      };
      ws.onclose = () => {
        clearTimeout(timer);
        if (!this.closed) this.onClose?.();
      };
      ws.onmessage = (event) => this.handleFrame(event.data);
    });
  }

  private handleFrame(data: unknown): void {
    if (typeof data !== 'string' || data.length > MAX_FRAME_LENGTH) return;
    let raw: unknown;
    try {
      raw = JSON.parse(data);
    } catch {
      return;
    }
    let candidate: unknown = raw;
    if (this.kind === 'nostr') {
      if (!Array.isArray(raw) || raw[0] !== 'EVENT' || !isPlainObject(raw[2])) return;
      const event = raw[2] as unknown as Event;
      if (event.kind !== 25000 || typeof event.content !== 'string') return;
      const now = Math.floor(Date.now() / 1000);
      if (!Number.isSafeInteger(event.created_at) || event.created_at < now - NOSTR_EVENT_MAX_AGE_SECONDS) return;
      const tags = Array.isArray(event.tags) ? event.tags.filter((t) => t[0] === 't') : [];
      if (tags.length !== 1 || tags[0][1] !== this.room) return;
      try {
        if (!verifyEvent(event)) return;
        candidate = JSON.parse(event.content);
      } catch {
        return;
      }
    }
    const msg = validateWireMessage(candidate, this.room);
    if (msg) this.onMessage?.(msg);
  }

  public send(msg: PairingWireMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (this.kind === 'nostr') {
      const event = finalizeEvent(
        {
          kind: 25000,
          created_at: Math.floor(Date.now() / 1000),
          tags: [['t', this.room]],
          content: JSON.stringify(msg),
        },
        this.nostrKey
      );
      this.ws.send(JSON.stringify(['EVENT', event]));
    } else {
      this.ws.send(JSON.stringify(msg));
    }
  }

  public close(): void {
    this.closed = true;
    try {
      this.ws?.close();
    } catch {
      // Ya cerrado.
    }
    this.ws = null;
  }
}

// ---------------------------------------------------------------------------
// Anfitrión
// ---------------------------------------------------------------------------

export interface PairingHostOptions {
  transport: PairingTransportKind;
  server: string;
  /** Canal `worker`: clave de acceso del anfitrión (obligatoria para abrir la sala). */
  workerAuthKey?: Uint8Array;
  /** Payload (v1) con la clave maestra; se evalúa solo cuando llega un hello válido. */
  getPayload: () => Promise<unknown>;
  /** Identidad del invitado una vez completado el intercambio. */
  onPaired: (guest: unknown) => void;
  /** El código caducó o el canal se cayó sin completarse. */
  onEnded?: (reason: 'expired' | 'closed') => void;
}

export interface PairingHostHandle {
  invite: PairingInvite;
  expiresAt: number;
  cancel(): void;
}

export async function startPairingHost(options: PairingHostOptions): Promise<PairingHostHandle> {
  const token = generatePairingToken();
  const room = await derivePairingRoom(token);
  const transport = new PairingTransport(options.transport, options.server, room, options.workerAuthKey);
  let session: PairingHostSession | null = null;
  let ended = false;
  let expiryTimer: ReturnType<typeof setTimeout> | null = null;

  const finish = (reason?: 'expired' | 'closed') => {
    if (ended) return;
    ended = true;
    if (expiryTimer) clearTimeout(expiryTimer);
    transport.close();
    if (reason) options.onEnded?.(reason);
  };

  transport.onMessage = (msg) => {
    void (async () => {
      if (ended || !session) return;
      if (msg.type === 'hello') {
        const offer = await session.handleHello(msg, await options.getPayload());
        if (offer) transport.send(offer);
      } else if (msg.type === 'done') {
        const guest = await session.handleDone<unknown>(msg);
        if (guest !== null) {
          options.onPaired(guest);
          finish();
        }
      }
    })().catch(() => {});
  };
  transport.onClose = () => finish('closed');

  await transport.open();
  // La vigencia empieza ahora, cuando el canal está listo y el QR puede mostrarse.
  session = new PairingHostSession(token);
  const hostSession = session;
  expiryTimer = setTimeout(() => {
    // Un código sin usar muere a los 2 min; si ya hay un intercambio en curso se espera su `done`.
    if (hostSession.isConsumed && !ended) {
      expiryTimer = setTimeout(() => finish('expired'), EXCHANGE_GRACE_MS);
      return;
    }
    finish('expired');
  }, PAIRING_TOKEN_TTL_MS);
  const expiresAt = session.expiresAt;

  return {
    invite: { v: 2, token, transport: options.transport, server: options.server },
    expiresAt,
    cancel: () => finish(),
  };
}

// ---------------------------------------------------------------------------
// Invitado
// ---------------------------------------------------------------------------

export interface PairingGuestResult<T> {
  payload: T;
  /** Confirma al anfitrión (cifrado) y cierra el canal. */
  complete(identity: unknown): Promise<void>;
  abort(): void;
}

export async function runPairingGuest<T>(invite: PairingInvite): Promise<PairingGuestResult<T>> {
  const session = new PairingGuestSession(invite.token);
  const room = await derivePairingRoom(invite.token);
  const transport = new PairingTransport(invite.transport, invite.server, room);

  const payload = await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      transport.close();
      reject(new Error('El otro dispositivo no respondió. Genera un código nuevo e inténtalo de nuevo.'));
    }, GUEST_TIMEOUT_MS);
    transport.onMessage = (msg) => {
      if (msg.type !== 'offer') return;
      void session.handleOffer<T>(msg).then((value) => {
        if (value === null) return;
        clearTimeout(timer);
        resolve(value);
      });
    };
    // Si el canal se cae antes de recibir la clave, falla enseguida en vez de esperar al tiempo límite.
    transport.onClose = () => {
      clearTimeout(timer);
      reject(new Error('El canal de vinculación se cerró antes de completar el intercambio.'));
    };
    transport
      .open()
      .then(async () => transport.send(await session.buildHello()))
      .catch((err) => {
        clearTimeout(timer);
        transport.close();
        reject(err);
      });
  });

  return {
    payload,
    complete: async (identity) => {
      transport.send(await session.buildDone(identity));
      // Margen para que el frame salga antes de cerrar.
      setTimeout(() => transport.close(), 500);
    },
    abort: () => transport.close(),
  };
}
