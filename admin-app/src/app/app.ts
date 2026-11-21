import { Component, OnInit, inject } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { AdminStore } from './admin-store';
import { Session } from './session';

// The page around the tabs: the site's header, the tab bar with its counts, and the check that
// whoever opened the page is an admin.
@Component({
  selector: 'eb-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App implements OnInit {
  protected readonly session = inject(Session);
  protected readonly store = inject(AdminStore);

  protected readonly tabs = [
    { path: '/orders', label: 'Orders', count: () => this.store.awaitingPayment(), countLabel: 'awaiting payment' },
    { path: '/messages', label: 'Messages', count: () => this.store.newMessages(), countLabel: 'new' },
    { path: '/products', label: 'Products', count: () => 0, countLabel: '' },
    { path: '/users', label: 'Users', count: () => this.store.usersWithProblems(), countLabel: 'to fix' },
    { path: '/database', label: 'Database', count: () => 0, countLabel: '' },
  ];

  ngOnInit() {
    this.session.check();
    // The tab counts need these three lists, whichever tab opens first.
    this.store.loadOrders();
    this.store.loadMessages();
    this.store.loadUsers();
  }
}
