import { Injectable, inject, signal } from '@angular/core';
import { AdminApi, SessionInfo, errorMessage } from './admin-api';

// Who is logged in, and whether they may use the admin app. The server checks the role again on
// every admin request; this only decides what the page shows.
@Injectable({ providedIn: 'root' })
export class Session {
  private readonly api = inject(AdminApi);

  readonly user = signal<SessionInfo | null>(null);
  readonly state = signal<'loading' | 'admin' | 'denied' | 'error'>('loading');
  readonly error = signal('');

  check() {
    this.api.session().subscribe({
      next: (info) => {
        this.user.set(info);
        if (!info.username) this.goToLogin();
        else this.state.set(info.role === 'admin' ? 'admin' : 'denied');
      },
      error: (err) => {
        this.error.set(errorMessage(err));
        this.state.set('error');
      },
    });
  }

  // The site's login page sends people back to admin.html, which forwards to /admin/.
  goToLogin() {
    window.location.href = '/login.html?next=admin.html';
  }

  logout() {
    const leave = () => {
      // The site's pages keep a copy of who's logged in; clear it too.
      try {
        localStorage.removeItem('aurora_session');
      } catch {}
      window.location.href = '/index.html';
    };
    this.api.logout().subscribe({ complete: leave, error: leave });
  }
}
