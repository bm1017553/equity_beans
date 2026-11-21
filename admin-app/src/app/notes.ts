import { signal } from '@angular/core';

export interface Note {
  text: string;
  ok: boolean;
}

// A short message beside one control ("Saved", or the server's error), keyed by what it's about.
// Successes fade after a moment; errors stay until the next try.
export class Notes {
  private readonly notes = signal<Record<string, Note>>({});
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  get(key: string): Note | undefined {
    return this.notes()[key];
  }

  show(key: string, text: string, ok: boolean) {
    clearTimeout(this.timers.get(key));
    this.notes.update((all) => ({ ...all, [key]: { text, ok } }));
    if (ok) this.timers.set(key, setTimeout(() => this.clear(key), 2500));
  }

  clear(key: string) {
    this.notes.update(({ [key]: _, ...rest }) => rest);
  }
}
