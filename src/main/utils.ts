import { TRPCError } from '@trpc/server';
import { BrowserWindow } from 'electron';
import { shell } from 'electron';
import semver from 'semver';
import type { ZodSchema } from 'zod';

import type { ErrorWithMessage, WindowInfoRecord } from '../types';

export function encodeQuery(query: Record<string, string>) {
  return Object.entries(query)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
}

export function setLinkOpenHandlers(browserWindow: BrowserWindow): void {
  // links in happ windows should open in the system default application
  // instead of the webview
  browserWindow.webContents.on('will-navigate', (e) => {
    console.log('GOT WILL-NAVIGATE EVENT: ', e);
    if (e.url.startsWith('http://localhost:5173')) {
      // ignore vite routing in dev mode
      return;
    }
    if (
      e.url.startsWith('http://') ||
      e.url.startsWith('https://') ||
      e.url.startsWith('mailto://')
    ) {
      e.preventDefault();
      shell.openExternal(e.url);
    }
  });

  // Links with target=_blank should open in the system default browser and
  // happ windows are not allowed to spawn new electron windows
  browserWindow.webContents.setWindowOpenHandler((details) => {
    console.log('GOT NEW WINDOW EVENT: ', details);
    if (details.url.startsWith('http://') || details.url.startsWith('https://')) {
      shell.openExternal(details.url);
    }
    return { action: 'deny' };
  });
}

export function throwTRPCErrorError({
  message,
  cause,
}: {
  message: string;
  cause?: unknown;
}): never {
  throw new TRPCError({
    code: 'INTERNAL_SERVER_ERROR',
    message,
    cause,
  });
}

export const validateWithZod = <T>({
  schema,
  data,
  errorType,
}: {
  schema: ZodSchema<T>;
  data: unknown;
  errorType: string;
}): T => {
  const result = schema.safeParse(data);
  if (!result.success) {
    return throwTRPCErrorError({
      message: errorType,
      cause: result.error,
    });
  }
  return result.data;
};

export function isErrorWithMessage(error: unknown): error is ErrorWithMessage {
  return (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof (error as Record<string, unknown>).message === 'string'
  );
}

function toErrorWithMessage(maybeError: unknown): ErrorWithMessage {
  if (isErrorWithMessage(maybeError)) return maybeError;

  try {
    return new Error(JSON.stringify(maybeError));
  } catch {
    // fallback in case there's an error stringifying the maybeError
    // like with circular references for example.
    return new Error(String(maybeError));
  }
}

export function getErrorMessage(error: unknown) {
  return toErrorWithMessage(error).message;
}

export function isHappAlreadyOpened({
  installed_app_id,
  WINDOW_INFO_MAP,
}: {
  installed_app_id: string;
  WINDOW_INFO_MAP: WindowInfoRecord;
}) {
  const windowEntry = Object.entries(WINDOW_INFO_MAP).find(
    ([, value]) => value.installedAppId === installed_app_id,
  );
  if (!windowEntry) return false;

  const [windowId] = windowEntry;
  const window = BrowserWindow.fromId(parseInt(windowId));
  if (!window) return false;

  if (window.isMinimized()) window.restore();
  window.focus();

  return true;
}

export function breakingVersion(version: string) {
  if (!semver.valid(version)) {
    throw new Error('Version is not valid semver.');
  }

  if (semver.prerelease(version)) {
    return version;
  }

  const major = semver.major(version);
  const minor = semver.minor(version);
  const patch = semver.patch(version);

  return major === 0 ? (minor === 0 ? `0.0.${patch}` : `0.${minor}.x`) : `${major}.x.x`;
}
