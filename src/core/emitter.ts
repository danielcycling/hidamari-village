type Handler<T> = (payload: T) => void;

export class Emitter<Events extends Record<string, unknown>> {
  private handlers: { [K in keyof Events]?: Handler<Events[K]>[] } = {};

  on<K extends keyof Events>(type: K, handler: Handler<Events[K]>): void {
    (this.handlers[type] ??= []).push(handler);
  }

  emit<K extends keyof Events>(type: K, payload: Events[K]): void {
    this.handlers[type]?.forEach((h) => h(payload));
  }
}
