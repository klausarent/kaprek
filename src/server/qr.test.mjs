// Tests for the hand-written QR encoder.
//
// What can be checked here is structure and arithmetic: the standard's
// invariants (finder patterns, timing, quiet zone, size per version) and the
// codeword stream, which is plain bit work and can be recomputed
// independently. What CANNOT be checked here is whether a phone camera reads
// it — that is the live acceptance, and it is stated as such rather than
// implied by a green suite.
import { describe, test, expect } from 'vitest';
import { encodeQr, qrToSvg, qrToText } from './qr.mjs';

/** The three finder patterns, as every QR code must have them. */
function hasFinder(matrix, top, left) {
  for (let r = 0; r < 7; r += 1) {
    for (let c = 0; c < 7; c += 1) {
      const onEdge = r === 0 || r === 6 || c === 0 || c === 6;
      const inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
      if (matrix[top + r][left + c] !== (onEdge || inCore ? 1 : 0)) return false;
    }
  }
  return true;
}

describe('encodeQr', () => {
  test('picks the smallest version that fits', () => {
    // 21 modules is version 1; 25 is version 2, and so on in steps of four.
    expect(encodeQr('hi').length).toBe(21);
    expect(encodeQr('x'.repeat(40)).length).toBe(29);
    expect(encodeQr('x'.repeat(100)).length).toBe(41);
  });

  test('a kaprek url with a token fits comfortably', () => {
    const url = 'http://192.168.1.42:4955/#/approvals?t=8f14e45fceea167a5a36dedd4bea2543';
    const matrix = encodeQr(url);
    // Version 5 or smaller: small enough to read off a terminal.
    expect(matrix.length).toBeLessThanOrEqual(37);
  });

  test('has all three finder patterns', () => {
    const matrix = encodeQr('https://example.com');
    const size = matrix.length;
    expect(hasFinder(matrix, 0, 0)).toBe(true);
    expect(hasFinder(matrix, 0, size - 7)).toBe(true);
    expect(hasFinder(matrix, size - 7, 0)).toBe(true);
  });

  test('has the timing patterns, alternating from the finders', () => {
    const matrix = encodeQr('https://example.com');
    for (let i = 8; i < matrix.length - 8; i += 1) {
      expect(matrix[6][i]).toBe(i % 2 === 0 ? 1 : 0);
      expect(matrix[i][6]).toBe(i % 2 === 0 ? 1 : 0);
    }
  });

  test('sets the dark module the standard requires', () => {
    const matrix = encodeQr('https://example.com');
    expect(matrix[matrix.length - 8][8]).toBe(1);
  });

  test('leaves no cell unwritten', () => {
    // A null here means the zigzag missed a cell — the kind of bug that
    // still scans on a good day and fails at an angle.
    for (const row of encodeQr('https://example.com/some/longer/path?with=query')) {
      for (const cell of row) expect(cell === 0 || cell === 1).toBe(true);
    }
  });

  test('is deterministic', () => {
    expect(encodeQr('kaprek').join()).toBe(encodeQr('kaprek').join());
  });

  test('level L makes room for more data than M', () => {
    // At 120 bytes M needs a bigger version than L; at 80 they happen to
    // land on the same one, which says nothing either way.
    const text = 'x'.repeat(120);
    expect(encodeQr(text, 'L').length).toBeLessThan(encodeQr(text, 'M').length);
  });

  test('refuses what it cannot encode instead of truncating', () => {
    // A QR that scans to half a URL is worse than no QR at all.
    expect(() => encodeQr('x'.repeat(400))).toThrow(/too much data/);
    expect(() => encodeQr('')).toThrow(/needs text/);
    expect(() => encodeQr('hi', 'H')).toThrow(/unsupported/);
  });

  test('encodes utf-8 by bytes, not by characters', () => {
    // Two characters, six bytes: a version chosen from the character count
    // would be too small and the encode would silently overflow.
    expect(() => encodeQr('äöü'.repeat(30))).not.toThrow();
  });
});

describe('qrToText', () => {
  test('carries the quiet zone the scanner needs to find the edges', () => {
    const lines = qrToText(encodeQr('hi')).split('\n');
    // Four modules of quiet on every side, and half-blocks mean two module
    // rows per text line.
    expect(lines).toHaveLength(Math.ceil((21 + 8) / 2));
    expect(lines[0]).toMatch(/^█+$/);
    expect(lines.at(-1)).toMatch(/^█+$/);
  });

  test('draws something other than quiet in the middle', () => {
    const text = qrToText(encodeQr('hi'));
    expect(text).toMatch(/[ ▄▀]/);
  });
});

describe('qrToSvg', () => {
  test('is a self-contained svg with a white field behind it', () => {
    const svg = qrToSvg(encodeQr('hi'));
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('fill="#fff"');
    expect(svg).toContain('<rect');
    // No external anything: this ends up inline in a page served locally.
    // (The xmlns is a namespace name, not a fetch — everything else must be
    // absent.)
    expect(svg.replace('http://www.w3.org/2000/svg', '')).not.toMatch(/https?:\/\//);
  });

  test('has one rect per dark module', () => {
    const matrix = encodeQr('hi');
    const dark = matrix.flat().filter((cell) => cell === 1).length;
    // The +1 is the white background rect.
    expect(qrToSvg(matrix).match(/<rect/g)).toHaveLength(dark + 1);
  });
});
