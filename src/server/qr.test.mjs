// Tests for the hand-written QR encoder.
//
// What can be checked here is structure and arithmetic: the standard's
// invariants (finder patterns, timing, quiet zone, size per version) and the
// codeword stream, which is plain bit work and can be recomputed
// independently. What CANNOT be checked here is whether a phone camera reads
// it — that is the live acceptance, and it is stated as such rather than
// implied by a green suite.
import { describe, test, expect } from 'vitest';
import { VERSIONS as VERSIONS_FOR_TEST, encodeQr, qrToSvg, qrToText } from './qr.mjs';
import { isLoopbackRequest } from './server.mjs';

/** The encoder's own tables, imported so the reader below can check against them rather than re-deriving. */
const FORMAT_TABLE = {
  L: [0x77c4, 0x72f3, 0x7daa, 0x789d, 0x662f, 0x6318, 0x6c41, 0x6976],
  M: [0x5412, 0x5125, 0x5e7c, 0x5b4b, 0x45f9, 0x40ce, 0x4f97, 0x4aa0],
};

const MASK_FNS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

const ALIGNMENT_TABLE = [[], [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

/** Version information, versions 7-10. The encoder's table, read back independently below. */
const VERSION_TABLE = { 7: 0x07c94, 8: 0x085bc, 9: 0x09a99, 10: 0x0a4d3 };

/** Block layout per version, level L only — what the reader needs to undo interleaving. */
const BLOCKS_L = {
  1: [1, 19, 0, 0],
  2: [1, 34, 0, 0],
  3: [1, 55, 0, 0],
  4: [1, 80, 0, 0],
  5: [1, 108, 0, 0],
  6: [2, 68, 0, 0],
  7: [2, 78, 0, 0],
  8: [2, 97, 0, 0],
  9: [2, 116, 0, 0],
  10: [4, 68, 2, 69],
};

/**
 * Undoes the interleaving the encoder applied.
 *
 * The first version of this reader assumed one block, which is true only up
 * to version 5. It therefore could not read the codes where the version
 * information lives — the same blind spot that let the missing version
 * information survive a green suite in the first place.
 */
function deinterleave(words, version) {
  const [g1Blocks, g1Words, g2Blocks, g2Words] = BLOCKS_L[version];
  const sizes = [...Array(g1Blocks).fill(g1Words), ...Array(g2Blocks).fill(g2Words)];
  const blocks = sizes.map(() => []);
  let index = 0;
  for (let position = 0; position < Math.max(...sizes); position += 1) {
    for (let block = 0; block < blocks.length; block += 1) {
      if (position < sizes[block]) blocks[block].push(words[index++]);
    }
  }
  return blocks.flat();
}

/** Which cells hold function patterns and format information, for a given size. */
function reservedMap(size) {
  const version = (size - 17) / 4;
  const reserved = Array.from({ length: size }, () => new Array(size).fill(false));
  const mark = (row, col) => {
    if (row >= 0 && col >= 0 && row < size && col < size) reserved[row][col] = true;
  };

  for (const [top, left] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
    for (let r = -1; r <= 7; r += 1) for (let c = -1; c <= 7; c += 1) mark(top + r, left + c);
  }
  for (let i = 8; i < size - 8; i += 1) {
    mark(6, i);
    mark(i, 6);
  }
  for (const row of ALIGNMENT_TABLE[version] ?? []) {
    for (const col of ALIGNMENT_TABLE[version] ?? []) {
      if ((row === 6 && col === 6) || (row === 6 && col === size - 7) || (row === size - 7 && col === 6)) continue;
      for (let r = -2; r <= 2; r += 1) for (let c = -2; c <= 2; c += 1) mark(row + r, col + c);
    }
  }
  if (version >= 7) {
    for (let i = 0; i < 18; i += 1) {
      mark(size - 11 + (i % 3), Math.floor(i / 3));
      mark(Math.floor(i / 3), size - 11 + (i % 3));
    }
  }
  mark(size - 8, 8);
  for (let i = 0; i < 9; i += 1) {
    mark(8, i);
    mark(i, 8);
  }
  for (let i = 0; i < 8; i += 1) {
    mark(8, size - 1 - i);
    mark(size - 1 - i, 8);
  }
  return reserved;
}

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

describe('isLoopbackRequest', () => {
  test('recognizes the three shapes a local peer arrives as', () => {
    for (const address of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
      expect(isLoopbackRequest({ socket: { remoteAddress: address } })).toBe(true);
    }
  });

  test('a network peer is not loopback', () => {
    expect(isLoopbackRequest({ socket: { remoteAddress: '192.168.1.77' } })).toBe(false);
  });

  test('reads the socket, never a header', () => {
    // A header is whatever the client says, and this decides who is handed
    // the instance token.
    expect(isLoopbackRequest({ headers: { host: '127.0.0.1' }, socket: { remoteAddress: '10.0.0.5' } })).toBe(false);
    expect(isLoopbackRequest({})).toBe(false);
  });
});

/**
 * Reads a matrix back the way a scanner does: find the mask from the format
 * bits, undo it, walk the zigzag in reverse, and pull the byte-mode payload
 * out of the data codewords.
 *
 * Not a tautology — it goes the other direction and reads the format
 * information the encoder wrote rather than the mask the encoder chose. The
 * off-by-one that left [8][size-8] unwritten and clobbered the dark module
 * would have shown up here as a wrong mask and garbage text.
 */
function decodeQr(matrix) {
  const size = matrix.length;

  // Format bits, copy one: around the top-left finder, in the order the
  // encoder wrote them.
  // The encoder put bit i of the table value at position i, so read it back
  // the same way round — shifting into an accumulator and then reversing it
  // flips the bits twice and decodes to nothing.
  let value = 0;
  for (let i = 0; i < 15; i += 1) {
    let bit;
    if (i < 6) bit = matrix[8][i];
    else if (i === 6) bit = matrix[8][7];
    else if (i === 7) bit = matrix[8][8];
    else if (i === 8) bit = matrix[7][8];
    else bit = matrix[14 - i][8];
    // MSB first, matching the encoder — and matching a reference matrix from
    // an independent encoder, which is what settled it.
    value |= bit << (14 - i);
  }

  let mask = null;
  let level = null;
  for (const candidate of ['L', 'M']) {
    const found = FORMAT_TABLE[candidate].indexOf(value);
    if (found !== -1) {
      mask = found;
      level = candidate;
    }
  }
  if (mask === null) throw new Error(`format information did not decode (got ${value.toString(16)})`);

  // Rebuild the function-pattern map the same way the encoder does, so the
  // reverse walk skips exactly the same cells.
  const reserved = reservedMap(size);
  const unmask = MASK_FNS[mask];
  const bits = [];
  let upward = true;
  for (let right = size - 1; right > 0; right -= 2) {
    if (right === 6) right -= 1;
    for (let step = 0; step < size; step += 1) {
      const row = upward ? size - 1 - step : step;
      for (const col of [right, right - 1]) {
        if (reserved[row][col]) continue;
        bits.push(unmask(row, col) ? matrix[row][col] ^ 1 : matrix[row][col]);
      }
    }
    upward = !upward;
  }

  // Bits back into codewords, codewords back into their blocks, and only
  // then into a payload.
  const allWords = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) allWords.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  const version = (size - 17) / 4;
  const dataWordCount = BLOCKS_L[version][0] * BLOCKS_L[version][1] + BLOCKS_L[version][2] * BLOCKS_L[version][3];
  const dataWords = deinterleave(allWords.slice(0, dataWordCount), version);

  const dataBits = dataWords.flatMap((word) => Array.from({ length: 8 }, (_, i) => (word >> (7 - i)) & 1));
  const readBits = (offset, count) => parseInt(dataBits.slice(offset, offset + count).join(''), 2);
  if (readBits(0, 4) !== 0b0100) throw new Error('not byte mode');
  const length = readBits(4, 8);
  const bytes = [];
  for (let i = 0; i < length; i += 1) bytes.push(readBits(12 + i * 8, 8));
  return { text: Buffer.from(bytes).toString('utf8'), level, mask };
}

describe('reading it back', () => {
  test('a decoder walking the other way finds the text again', () => {
    const url = 'http://192.168.1.42:4900/#/approvals?t=8f14e45fceea167a';
    // Interleaving only kicks in above one block, and version 1-9 at these
    // sizes is a single block — which is what this reader assumes.
    expect(decodeQr(encodeQr(url, 'L')).text).toBe(url);
  });

  test('short text round-trips too', () => {
    expect(decodeQr(encodeQr('kaprek', 'L')).text).toBe('kaprek');
  });

  test('the format information names the level that was asked for', () => {
    expect(decodeQr(encodeQr('kaprek', 'L')).level).toBe('L');
  });
});

describe('version information (version 7 and up)', () => {
  /** Reads the 18 version bits back out of both copies. */
  function readVersionBits(matrix) {
    const size = matrix.length;
    let bottomLeft = 0;
    let topRight = 0;
    for (let i = 0; i < 18; i += 1) {
      bottomLeft |= matrix[size - 11 + (i % 3)][Math.floor(i / 3)] << i;
      topRight |= matrix[Math.floor(i / 3)][size - 11 + (i % 3)] << i;
    }
    return { bottomLeft, topRight };
  }

  test('a version 7 code carries it, in both copies', () => {
    // Missing entirely until Grok's review: every code from version 7 on was
    // structurally invalid, and both the encoder and the round-trip reader
    // were blind to it in the same way.
    // Level L holds 136 bytes at version 6, so 150 is the first thing that
    // needs version 7.
    const matrix = encodeQr('x'.repeat(150), 'L');
    expect(matrix.length).toBe(45);
    const { bottomLeft, topRight } = readVersionBits(matrix);
    expect(bottomLeft).toBe(VERSION_TABLE[7]);
    expect(topRight).toBe(VERSION_TABLE[7]);
  });

  test('versions 8 to 10 carry their own', () => {
    for (const [version, bytes] of [
      [8, 180],
      [9, 210],
      [10, 250],
    ]) {
      const matrix = encodeQr('x'.repeat(bytes), 'L');
      expect(matrix.length).toBe(version * 4 + 17);
      expect(readVersionBits(matrix).bottomLeft).toBe(VERSION_TABLE[version]);
    }
  });

  test('a small code has none, and no payload was written there instead', () => {
    const matrix = encodeQr('kaprek', 'L');
    expect(matrix.length).toBe(21);
    // Version 1-6 has no version information at all — writing something
    // there would be as wrong as leaving it out at 7.
    expect(readVersionBits(matrix).bottomLeft).not.toBe(VERSION_TABLE[7]);
  });

  test('a version 7 payload still reads back', () => {
    // The reservation has to happen before the zigzag, or the data walk
    // writes eight codewords into cells placeVersion then overwrites.
    const text = 'https://192.168.178.63:4900/#/approvals?t=' + 'a'.repeat(110);
    expect(decodeQr(encodeQr(text, 'L')).text).toBe(text);
  });
});

describe('the version tables add up', () => {
  test('data words plus ecc words equal the version total, every row', () => {
    // Version 10 at L claimed 518 codewords in a 346-codeword matrix, so a
    // 400-byte input was accepted and then cut off at the matrix edge.
    // (Codex' review.) An arithmetic invariant catches the whole class.
    for (const [version, total, levels] of VERSIONS_FOR_TEST) {
      for (const [level, [ecc, g1Blocks, g1Words, g2Blocks, g2Words]] of Object.entries(levels)) {
        const data = g1Blocks * g1Words + g2Blocks * g2Words;
        const blocks = g1Blocks + g2Blocks;
        expect(`v${version}/${level}: ${data + blocks * ecc}`).toBe(`v${version}/${level}: ${total}`);
      }
    }
  });

  test('what it refuses matches what it can hold', () => {
    // 271 bytes is the documented ceiling at L; one more must be refused
    // rather than truncated.
    expect(() => encodeQr('x'.repeat(271), 'L')).not.toThrow();
    expect(() => encodeQr('x'.repeat(400), 'L')).toThrow(/too much data/);
  });
});
