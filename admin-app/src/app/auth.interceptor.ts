import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { catchError, throwError } from 'rxjs';
import { Session } from './session';

// Every API call passes through here. If the login has ended (401) or the admin role was taken
// away (403) partway through, the whole app reacts once, instead of each page handling it.
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const session = inject(Session);
  return next(req).pipe(
    catchError((err: unknown) => {
      if (err instanceof HttpErrorResponse && req.url.startsWith('/api/admin/')) {
        if (err.status === 401) session.goToLogin();
        if (err.status === 403) session.state.set('denied');
      }
      return throwError(() => err);
    }),
  );
};
