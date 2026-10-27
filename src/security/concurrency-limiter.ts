/**
 * OmniSync - Concurrency Limiter
 *
 * Limita el número de operaciones pesadas simultáneas. Se usa para acotar el
 * pico de memoria cuando varios blobs Blossom (25/50 MB) se transfieren a la
 * vez: sin este límite, varias descargas simultáneas multiplicarían el
 * consumo de RAM del plugin.
 *
 * La cola es FIFO y el error de una operación no bloquea a las siguientes.
 */

export class ConcurrencyLimiter {
  private readonly limit: number;
  private readonly maxQueueLength: number;
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(limit: number = 1, maxQueueLength: number = 64) {
    this.limit = Number.isSafeInteger(limit) && limit > 0 ? limit : 1;
    this.maxQueueLength =
      Number.isSafeInteger(maxQueueLength) && maxQueueLength >= 0 ? maxQueueLength : 64;
  }

  /** Operaciones en curso en este momento. */
  public get activeCount(): number {
    return this.active;
  }

  /** Operaciones que esperan su turno. */
  public get pendingCount(): number {
    return this.waiters.length;
  }

  /** Límite de operaciones simultáneas configurado. */
  public get maxConcurrency(): number {
    return this.limit;
  }

  /**
   * Ejecuta `operation` cuando hay hueco disponible. El invariante es que
   * nunca hay más de `limit` operaciones en curso a la vez.
   */
  public async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      // Una cola ilimitada permite acumular operaciones pesadas sin límite.
      // Se rechaza el exceso con un error explícito en lugar de retener datos.
      if (this.waiters.length >= this.maxQueueLength) {
        throw new Error('Demasiadas operaciones pendientes; inténtalo de nuevo más tarde.');
      }
      // El slot se traspasa directamente al despertar: `active` no cambia.
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
      });
    } else {
      this.active++;
    }
    try {
      return await operation();
    } finally {
      const next = this.waiters.shift();
      if (next) next();
      else this.active--;
    }
  }
}