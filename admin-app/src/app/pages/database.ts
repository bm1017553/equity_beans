import { Component, computed, inject } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { AdminStore } from '../admin-store';

// A read-only look at the equity_beans database: each collection, how many documents it holds,
// whether MongoDB checks its documents (validation rules), and its indexes.
@Component({
  selector: 'eb-database',
  imports: [DecimalPipe],
  templateUrl: './database.html',
})
export class DatabasePage {
  protected readonly store = inject(AdminStore);

  protected readonly totalDocuments = computed(() =>
    (this.store.database()?.collections ?? []).reduce((sum, c) => sum + c.documents, 0),
  );

  constructor() {
    this.store.loadDatabase();
  }

  protected refresh() {
    this.store.loadDatabase(true);
  }
}
