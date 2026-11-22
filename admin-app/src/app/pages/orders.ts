import { Component, computed, inject, signal } from '@angular/core';
import { CurrencyPipe, DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { finalize } from 'rxjs';
import { AdminStore } from '../admin-store';
import { errorMessage } from '../admin-api';
import { ORDER_STATUS_LABELS, options } from '../labels';
import { Notes } from '../notes';

// Every order, guest or account, with a status menu that saves as soon as it changes.
@Component({
  selector: 'eb-orders',
  imports: [FormsModule, CurrencyPipe, DatePipe],
  templateUrl: './orders.html',
})
export class OrdersPage {
  protected readonly store = inject(AdminStore);
  protected readonly statuses = options(ORDER_STATUS_LABELS);
  protected readonly filter = signal('');
  protected readonly notes = new Notes();
  protected readonly saving = signal<string | null>(null);

  protected readonly shown = computed(() => (this.store.orders() ?? []).filter((o) => !this.filter() || o.status === this.filter()));

  constructor() {
    this.store.loadOrders();
  }

  protected setStatus(orderId: string, menu: HTMLSelectElement) {
    const saved = this.store.orders()?.find((o) => o.orderId === orderId)?.status ?? '';
    this.saving.set(orderId);
    this.store
      .setOrderStatus(orderId, menu.value)
      .pipe(finalize(() => this.saving.set(null)))
      .subscribe({
        next: () => this.notes.show(orderId, 'Saved', true),
        error: (err) => {
          this.notes.show(orderId, errorMessage(err), false);
          menu.value = saved; // back to what's really in the database
        },
      });
  }
}
