import { Injectable, WritableSignal, computed, inject, signal } from '@angular/core';
import { Observable, tap } from 'rxjs';
import { AdminApi, AdminUser, DatabaseInfo, Message, Order, Product, ProductChanges, errorMessage } from './admin-api';

type Loadable = 'orders' | 'messages' | 'products' | 'users' | 'database';

// The data the tabs share, kept as signals. Each list is loaded once, the first time a tab needs
// it, and every change saved to the server updates it here, so the tab counts stay right.
@Injectable({ providedIn: 'root' })
export class AdminStore {
  private readonly api = inject(AdminApi);

  readonly orders = signal<Order[] | null>(null);
  readonly messages = signal<Message[] | null>(null);
  readonly products = signal<Product[] | null>(null);
  readonly users = signal<AdminUser[] | null>(null);
  readonly database = signal<DatabaseInfo | null>(null);
  // A message per list that failed to load.
  readonly loadErrors = signal<Partial<Record<Loadable, string>>>({});

  // The counts shown on the tabs.
  readonly awaitingPayment = computed(() => (this.orders() ?? []).filter((o) => o.status === 'pending_payment').length);
  readonly newMessages = computed(() => (this.messages() ?? []).filter((m) => m.status === 'new').length);
  readonly usersWithProblems = computed(() => (this.users() ?? []).filter((u) => u.problems.length).length);

  private load<T>(name: Loadable, request: Observable<T>, force: boolean) {
    const target = this[name] as WritableSignal<T | null>;
    if (target() !== null && !force) return;
    request.subscribe({
      next: (value) => {
        target.set(value);
        this.loadErrors.update((errors) => ({ ...errors, [name]: undefined }));
      },
      error: (err) => this.loadErrors.update((errors) => ({ ...errors, [name]: errorMessage(err) })),
    });
  }

  loadOrders(force = false) {
    this.load('orders', this.api.orders(), force);
  }

  loadMessages(force = false) {
    this.load('messages', this.api.messages(), force);
  }

  loadProducts(force = false) {
    this.load('products', this.api.products(), force);
  }

  loadUsers(force = false) {
    this.load('users', this.api.users(), force);
  }

  loadDatabase(force = false) {
    this.load('database', this.api.database(), force);
  }

  // ---------- Saving (each returns the request, so the page can show "Saved" or the error) ----------

  setOrderStatus(orderId: string, status: string) {
    return this.api.setOrderStatus(orderId, status).pipe(
      tap(() => this.orders.update((list) => list && list.map((o) => (o.orderId === orderId ? { ...o, status } : o)))),
    );
  }

  setMessageStatus(id: string, status: string) {
    return this.api.setMessageStatus(id, status).pipe(
      tap(() => this.messages.update((list) => list && list.map((m) => (m.id === id ? { ...m, status } : m)))),
    );
  }

  updateProduct(id: string, changes: ProductChanges) {
    return this.api.updateProduct(id, changes).pipe(
      tap((saved) => this.products.update((list) => list && list.map((p) => (p.id === id ? saved : p)))),
    );
  }

  // Replaces one account in the list with the server's view of it after a fix. `oldUsername`
  // matters after a rename.
  private replaceUser<T extends AdminUser = AdminUser>(oldUsername: string) {
    return tap((saved: T) =>
      this.users.update((list) => list && list.map((u) => (u.username === oldUsername ? { ...saved } : u))),
    );
  }

  unlock(username: string) {
    return this.api.unlock(username).pipe(this.replaceUser(username));
  }

  setRole(username: string, role: string) {
    return this.api.setRole(username, role).pipe(this.replaceUser(username));
  }

  rename(username: string, newUsername: string) {
    return this.api.rename(username, newUsername).pipe(
      this.replaceUser(username),
      // Orders and messages show the account name, so they're fetched again next time.
      tap(() => {
        this.orders.set(null);
        this.messages.set(null);
      }),
    );
  }

  setPassword(username: string, password: string) {
    return this.api.setPassword(username, password).pipe(this.replaceUser<AdminUser & { sessionsEnded: number }>(username));
  }

  clearQuestions(username: string) {
    return this.api.clearQuestions(username).pipe(this.replaceUser(username));
  }

  deleteUser(username: string) {
    return this.api.deleteUser(username).pipe(
      tap(() => {
        this.users.update((list) => list && list.filter((u) => u.username !== username));
        // The account's orders and messages are now guest records; the database counts changed.
        this.orders.set(null);
        this.messages.set(null);
        this.database.set(null);
      }),
    );
  }
}
