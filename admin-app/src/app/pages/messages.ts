import { Component, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { finalize } from 'rxjs';
import { AdminStore } from '../admin-store';
import { Message, errorMessage } from '../admin-api';
import { MESSAGE_STATUS_LABELS, TOPIC_LABELS, options } from '../labels';
import { Notes } from '../notes';

// Every message from the Contact page, newest first, with a status menu and a reply link.
@Component({
  selector: 'eb-messages',
  imports: [FormsModule, DatePipe],
  templateUrl: './messages.html',
})
export class MessagesPage {
  protected readonly store = inject(AdminStore);
  protected readonly statuses = options(MESSAGE_STATUS_LABELS);
  protected readonly topics = TOPIC_LABELS;
  protected readonly filter = signal('');
  protected readonly notes = new Notes();
  protected readonly saving = signal<string | null>(null);

  protected readonly shown = computed(() => (this.store.messages() ?? []).filter((m) => !this.filter() || m.status === this.filter()));

  constructor() {
    this.store.loadMessages();
  }

  protected replyLink(m: Message) {
    const subject = `Re: your Equity Beans ${(TOPIC_LABELS[m.topic] ?? 'message').toLowerCase()}`;
    return `mailto:${m.email}?subject=${encodeURIComponent(subject)}`;
  }

  protected setStatus(id: string, menu: HTMLSelectElement) {
    const saved = this.store.messages()?.find((m) => m.id === id)?.status ?? '';
    this.saving.set(id);
    this.store
      .setMessageStatus(id, menu.value)
      .pipe(finalize(() => this.saving.set(null)))
      .subscribe({
        next: () => this.notes.show(id, 'Saved', true),
        error: (err) => {
          this.notes.show(id, errorMessage(err), false);
          menu.value = saved;
        },
      });
  }
}
