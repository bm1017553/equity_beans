import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';

// The admin app never connects to MongoDB itself: a browser can't safely hold database
// credentials. Every call goes to server.js, which checks the admin role in the database and then
// reads or writes MongoDB (see /api/admin/... in server.js and mongo/SCHEMA.md).

// ---------- Shapes the API sends (server.js) ----------

export interface SessionInfo {
  username: string | null;
  role: string | null;
}

export interface OrderLine {
  productId: string;
  name: string;
  option: string;
  unitPrice: number;
  qty: number;
}

export interface Order {
  orderId: string;
  username: string | null; // null for a guest order
  customer: { name: string; email: string; address: string; city: string; state: string; zip: string };
  items: OrderLine[];
  totals: { subtotal: number; shipping: number; total: number };
  status: string;
  createdAt: string;
}

export interface Message {
  id: string;
  name: string;
  email: string;
  topic: string;
  orderId: string | null;
  message: string;
  status: string;
  createdAt: string;
  username: string | null;
}

export interface ProductOption {
  name: string;
  price: number;
  salePrice: number | null;
  available: boolean;
}

export interface Product {
  id: string;
  name: string;
  country: string;
  roast: string;
  inStock: boolean;
  options: ProductOption[];
}

export interface ProductChanges {
  inStock: boolean;
  options: { name: string; available: boolean; salePrice: number | null }[];
}

export interface UserProblem {
  code: 'rules' | 'role' | 'password' | 'questions' | 'loginLocked' | 'resetLocked';
  text: string;
}

export interface AdminUser {
  username: string;
  role: string | null;
  isYou: boolean;
  createdAt: string | null;
  lastLoginAt: string | null;
  hasSecurityQuestions: boolean;
  loginFailures: number;
  loginLockedUntil: string | null;
  resetFailures: number;
  resetLockedUntil: string | null;
  orders: number;
  problems: UserProblem[];
}

export interface DeletedUser {
  username: string;
  deleted: true;
  kept: Record<'orders' | 'reviews' | 'quizResults' | 'messages', number>;
}

export interface CollectionInfo {
  name: string;
  documents: number;
  hasValidator: boolean;
  validationLevel: string | null;
  indexes: { name: string; keys: string[]; unique: boolean; caseInsensitive: boolean; expiresAfterSeconds: number | null }[];
}

export interface DatabaseInfo {
  database: string;
  collections: CollectionInfo[];
}

// ---------- Calls ----------

@Injectable({ providedIn: 'root' })
export class AdminApi {
  private readonly http = inject(HttpClient);

  session() {
    return this.http.get<SessionInfo>('/api/session');
  }

  logout() {
    return this.http.post<SessionInfo>('/api/logout', {});
  }

  orders() {
    return this.http.get<Order[]>('/api/admin/orders');
  }

  setOrderStatus(orderId: string, status: string) {
    return this.http.post<{ orderId: string; status: string }>(`/api/admin/orders/${encodeURIComponent(orderId)}/status`, { status });
  }

  messages() {
    return this.http.get<Message[]>('/api/admin/messages');
  }

  setMessageStatus(id: string, status: string) {
    return this.http.post<{ id: string; status: string }>(`/api/admin/messages/${encodeURIComponent(id)}/status`, { status });
  }

  products() {
    return this.http.get<Product[]>('/api/products');
  }

  updateProduct(id: string, changes: ProductChanges) {
    return this.http.post<Product>(`/api/admin/products/${encodeURIComponent(id)}`, changes);
  }

  users() {
    return this.http.get<AdminUser[]>('/api/admin/users');
  }

  // The user fixes all answer with the account as it is afterwards.
  private userAction<T = AdminUser>(username: string, action: string, body: object = {}) {
    return this.http.post<T>(`/api/admin/users/${encodeURIComponent(username)}/${action}`, body);
  }

  unlock(username: string) {
    return this.userAction(username, 'unlock');
  }

  setRole(username: string, role: string) {
    return this.userAction(username, 'role', { role });
  }

  rename(username: string, newUsername: string) {
    return this.userAction(username, 'rename', { newUsername });
  }

  setPassword(username: string, password: string) {
    return this.userAction<AdminUser & { sessionsEnded: number }>(username, 'password', { password });
  }

  clearQuestions(username: string) {
    return this.userAction(username, 'clear-questions');
  }

  deleteUser(username: string) {
    return this.userAction<DeletedUser>(username, 'delete');
  }

  database() {
    return this.http.get<DatabaseInfo>('/api/admin/database');
  }
}

// The server writes its error messages for people ("That username is already taken."), so they're
// shown as they are.
export function errorMessage(err: unknown): string {
  if (err instanceof HttpErrorResponse) {
    if (err.status === 0) return 'Can’t reach the Equity Beans server. Is it running (npm start)?';
    return err.error?.error ?? `Something went wrong (error ${err.status}). Please try again.`;
  }
  return 'Something went wrong. Please try again.';
}
