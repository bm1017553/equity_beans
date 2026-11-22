import { Component, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Observable, finalize } from 'rxjs';
import { AdminStore } from '../admin-store';
import { AdminUser, UserProblem, errorMessage } from '../admin-api';
import { ROLE_LABELS, options } from '../labels';
import { Notes } from '../notes';

type Panel = 'role' | 'rename' | 'password' | 'questions' | 'delete';
type Filter = 'all' | 'problems' | 'admins' | 'locked';

const MIN_PASSWORD_LENGTH = 8; // same rule as server.js
const USERNAME_PATTERN = /^[A-Za-z0-9_.-]{3,30}$/;

// The tool for fixing the users collection: every account, what's wrong with it, and a form
// for each fix. Every change goes through the server, which checks it and MongoDB's rules.
@Component({
  selector: 'eb-users',
  imports: [FormsModule, DatePipe],
  templateUrl: './users.html',
})
export class UsersPage {
  protected readonly store = inject(AdminStore);
  protected readonly roles = options(ROLE_LABELS);
  protected readonly roleLabels = ROLE_LABELS;
  protected readonly notes = new Notes();

  protected readonly filter = signal<Filter>('all');
  // Which account's form is open, and which form. Only one at a time.
  protected readonly open = signal<{ username: string; panel: Panel } | null>(null);
  protected readonly busy = signal<string | null>(null);
  // A message about the whole list, e.g. after a delete.
  protected readonly banner = signal('');

  // The open form's fields.
  protected roleChoice = '';
  protected newName = '';
  protected tempPassword = '';

  protected readonly filters: { value: Filter; label: string }[] = [
    { value: 'all', label: 'All accounts' },
    { value: 'problems', label: 'Needs fixing' },
    { value: 'admins', label: 'Admins' },
    { value: 'locked', label: 'Locked' },
  ];

  protected readonly shown = computed(() => {
    const users = this.store.users() ?? [];
    switch (this.filter()) {
      case 'problems':
        return users.filter((u) => u.problems.length);
      case 'admins':
        return users.filter((u) => u.role === 'admin');
      case 'locked':
        return users.filter((u) => u.loginLockedUntil || u.resetLockedUntil);
      default:
        return users;
    }
  });

  constructor() {
    this.store.loadUsers();
  }

  protected refresh() {
    this.banner.set('');
    this.store.loadUsers(true);
  }

  protected isOpen(u: AdminUser, panel: Panel) {
    const open = this.open();
    return open?.username === u.username && open.panel === panel;
  }

  protected openPanel(u: AdminUser, panel: Panel) {
    this.notes.clear(u.username);
    this.roleChoice = u.role ?? '';
    this.newName = u.username;
    this.tempPassword = '';
    this.open.set({ username: u.username, panel });
  }

  protected close() {
    this.open.set(null);
  }

  // The "Fix" button beside a problem opens the form that fixes it.
  protected fixPanel(problem: UserProblem): Panel | 'unlock' | null {
    switch (problem.code) {
      case 'role':
        return 'role';
      case 'password':
        return 'password';
      case 'loginLocked':
      case 'resetLocked':
        return 'unlock';
      default:
        return null;
    }
  }

  protected fix(u: AdminUser, problem: UserProblem) {
    const panel = this.fixPanel(problem);
    if (panel === 'unlock') this.unlock(u);
    else if (panel) this.openPanel(u, panel);
  }

  protected needsUnlock(u: AdminUser) {
    return Boolean(u.loginLockedUntil || u.loginFailures || u.resetLockedUntil || u.resetFailures);
  }

  // A random temporary password the admin can read out or copy. No look-alike characters.
  protected generatePassword() {
    const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
    const bytes = crypto.getRandomValues(new Uint32Array(12));
    this.tempPassword = Array.from(bytes, (b) => chars[b % chars.length]).join('');
  }

  protected renameError() {
    return USERNAME_PATTERN.test(this.newName.trim()) ? '' : 'Use 3–30 letters, numbers, dots, dashes or underscores.';
  }

  protected passwordError() {
    return this.tempPassword.length >= MIN_PASSWORD_LENGTH ? '' : `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  }

  // Runs one fix: shows progress, then "Saved" (or the server's error) beside that account.
  private run<T>(u: AdminUser, request: Observable<T>, done: (result: T) => string, noteKey = u.username) {
    this.busy.set(u.username);
    this.banner.set('');
    request.pipe(finalize(() => this.busy.set(null))).subscribe({
      next: (result) => {
        this.open.set(null);
        this.notes.show(noteKey, done(result), true);
      },
      error: (err) => this.notes.show(u.username, errorMessage(err), false),
    });
  }

  protected unlock(u: AdminUser) {
    this.run(u, this.store.unlock(u.username), () => 'Unlocked.');
  }

  protected saveRole(u: AdminUser) {
    if (!this.roleChoice) return;
    this.run(u, this.store.setRole(u.username, this.roleChoice), () => `Role saved: ${ROLE_LABELS[this.roleChoice]}.`);
  }

  protected saveRename(u: AdminUser) {
    if (this.renameError()) return;
    const newName = this.newName.trim();
    this.run(u, this.store.rename(u.username, newName), () => `Renamed. They’ll log in as ${newName} from now on.`, newName);
  }

  protected savePassword(u: AdminUser) {
    if (this.passwordError()) return;
    const password = this.tempPassword;
    this.run(u, this.store.setPassword(u.username, password), (r) => {
      const ended = r.sessionsEnded ? ` ${r.sessionsEnded} login${r.sessionsEnded === 1 ? '' : 's'} ended.` : '';
      return `Temporary password set: ${password}. Give it to the customer; they can change it on their account page.${ended}`;
    });
  }

  protected clearQuestions(u: AdminUser) {
    this.run(u, this.store.clearQuestions(u.username), () => 'Security questions cleared. They can add new ones on their account page.');
  }

  protected deleteUser(u: AdminUser) {
    this.busy.set(u.username);
    this.store
      .deleteUser(u.username)
      .pipe(finalize(() => this.busy.set(null)))
      .subscribe({
        next: (r) => {
          this.open.set(null);
          const k = r.kept;
          this.banner.set(
            `Deleted ${r.username}. Kept as guest records: ${k.orders} order(s), ${k.reviews} review(s), ${k.quizResults} quiz result(s), ${k.messages} message(s).`,
          );
        },
        error: (err) => this.notes.show(u.username, errorMessage(err), false),
      });
  }
}
