import { Component, inject, signal } from '@angular/core';
import { CurrencyPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AdminStore } from '../admin-store';
import { Product, errorMessage } from '../admin-api';
import { Notes } from '../notes';

// The form's copy of one coffee, which ngModel edits until Save.
interface Draft {
  inStock: boolean;
  options: { name: string; price: number; available: boolean; salePrice: number | null }[];
}

function toDraft(p: Product): Draft {
  return { inStock: p.inStock, options: p.options.map((o) => ({ ...o })) };
}

// Stock, availability and sale prices per coffee. Regular prices and names stay in the database.
@Component({
  selector: 'eb-products',
  imports: [FormsModule, CurrencyPipe],
  templateUrl: './products.html',
})
export class ProductsPage {
  protected readonly store = inject(AdminStore);
  protected readonly notes = new Notes();
  private readonly drafts = new Map<string, Draft>();
  protected readonly saving = signal<string | null>(null);

  constructor() {
    this.store.loadProducts();
  }

  protected draftFor(p: Product): Draft {
    let draft = this.drafts.get(p.id);
    if (!draft) {
      draft = toDraft(p);
      this.drafts.set(p.id, draft);
    }
    return draft;
  }

  // Save only lights up when something differs from what's in the database.
  protected changed(p: Product): boolean {
    const d = this.draftFor(p);
    return (
      d.inStock !== p.inStock ||
      d.options.some((o, i) => o.available !== p.options[i].available || (o.salePrice ?? null) !== (p.options[i].salePrice ?? null))
    );
  }

  protected save(p: Product) {
    const d = this.draftFor(p);
    this.saving.set(p.id);
    this.store
      .updateProduct(p.id, {
        inStock: d.inStock,
        // An emptied number box gives null: no sale.
        options: d.options.map((o) => ({ name: o.name, available: o.available, salePrice: o.salePrice ?? null })),
      })
      .subscribe({
        next: (saved) => {
          this.drafts.set(p.id, toDraft(saved));
          this.notes.show(p.id, 'Saved', true);
        },
        error: (err) => {
          this.notes.show(p.id, errorMessage(err), false);
          this.saving.set(null);
        },
        complete: () => this.saving.set(null),
      });
  }

  protected undo(p: Product) {
    this.drafts.set(p.id, toDraft(p));
    this.notes.clear(p.id);
  }
}
