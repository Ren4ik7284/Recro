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

  if (window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1') {
    console.log = () => {};
    console.debug = () => {};
    console.info = () => {};
  }
}

bootstrapApplication(App, appConfig)
  .catch(() => {});
