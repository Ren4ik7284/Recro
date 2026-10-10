import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';

if (typeof window !== 'undefined') {
  const sanitize = (args: any[]) => {
    return args.map((arg) => {
      if (typeof arg === 'string') {
        return arg
          .replace(/password[:=]\s*\S+/gi, 'password=[REDACTED]')
          .replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/g, 'Bearer [REDACTED]');
      }
      return arg;
    });
  };
  const origError = console.error;
  const origWarn = console.warn;
  console.error = (...args: any[]) => origError.apply(console, sanitize(args));
  console.warn = (...args: any[]) => origWarn.apply(console, sanitize(args));

}
 
bootstrapApplication(App, appConfig)
  .catch((err) => {
    console.error('[Bootstrap Error]', err);
    if (typeof document !== 'undefined') {
      const el = document.getElementById('recro-status');
      if (el) {
        el.style.color = '#ef4444';
        el.textContent = 'Ошибка: ' + (err?.message || err);
      }
    }
  });
