// Clipboard reading for the `clipboard` trigger type (see registry.mjs) —
// isolated in its own module for two reasons: it is the ONLY place in the
// runtime that shells out for a trigger (the static guard in
// src/no-network.test.mjs lists this file as a sanctioned child_process
// exception, alongside bin/cli.mjs and src/harness/*), and it is the seam
// tests replace instead of touching the real clipboard.
//
// Zero dependencies, so no clipboardy: Windows already ships a clipboard
// reader (`Get-Clipboard`). Hardening on the spawn itself:
//   - execFile, never exec/shell: no shell is involved, so nothing in the
//     clipboard's own content can ever be interpreted as a command.
//   - -NoProfile: a user profile script must not run, and must not be able to
//     change what Get-Clipboard returns.
//   - timeout + maxBuffer: a hung or huge read fails the poll instead of
//     wedging the poller or ballooning memory. Text only; images/files come
//     back as nothing, which is exactly what we want.
import { execFile } from 'node:child_process';

const READ_TIMEOUT_MS = 3000;
const MAX_OUTPUT_BYTES = 64 * 1024;

/** Whether a clipboard trigger can run on this platform at all. Windows-only in v1 — see readWindowsClipboard(). */
export function isClipboardSupported(platform = process.platform) {
  return platform === 'win32';
}

/**
 * Reads the clipboard's TEXT content on Windows, resolving to a string (empty
 * if the clipboard holds no text) or rejecting if the read itself failed.
 * `Get-Clipboard` prints one line per clipboard line, so the trailing newline
 * PowerShell adds is stripped — a copied one-liner must compare equal to
 * itself on the next poll, not differ by an invisible '\r\n'.
 */
export function readWindowsClipboard() {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell',
      ['-NoProfile', '-Command', 'Get-Clipboard'],
      { timeout: READ_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true },
      (err, stdout) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(String(stdout).replace(/\r?\n$/, ''));
      },
    );
  });
}
