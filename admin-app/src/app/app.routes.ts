import { Routes } from '@angular/router';
import { OrdersPage } from './pages/orders';
import { MessagesPage } from './pages/messages';
import { ProductsPage } from './pages/products';
import { UsersPage } from './pages/users';
import { DatabasePage } from './pages/database';

// One route per tab; the tab links in app.html point at these.
export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'orders' },
  { path: 'orders', component: OrdersPage, title: 'Equity Beans | Admin: Orders' },
  { path: 'messages', component: MessagesPage, title: 'Equity Beans | Admin: Messages' },
  { path: 'products', component: ProductsPage, title: 'Equity Beans | Admin: Products' },
  { path: 'users', component: UsersPage, title: 'Equity Beans | Admin: Users' },
  { path: 'database', component: DatabasePage, title: 'Equity Beans | Admin: Database' },
  { path: '**', redirectTo: 'orders' },
];
