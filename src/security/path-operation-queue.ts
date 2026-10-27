/**
 * OmniSync - Per-path Operation Queue
 *
 * Serializa operaciones que afecten a la misma ruta. Las rutas diferentes
 * pueden procesarse en paralelo, pero una escritura remota nunca compite con
 * otra sobre el mismo archivo (por ejemplo, push realtime y barrido inicial).
 */

export class PathOperationQueue {
  private readonly tails = new Map<string, Promise<void>>();

  /**
   * Ejecuta `operation` después de todas las operaciones anteriores de `key`.
   * El error de una operación no bloquea las siguientes de la misma ruta.
   */
  public async run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    this.tails.set(key, tail);

    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.tails.get(key) === tail) {
        this.tails.delete(key);
      }
    }
  }

  /** Elimina cualquier estado pendiente. Las operaciones en curso terminan. */
  public clear(): void {
    this.tails.clear();
  }
}
