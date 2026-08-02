// A QR code, written out by hand.
//
// kaprek has zero runtime dependencies, and this is the one place where that
// rule costs real code rather than a shrug. It is worth paying: the whole
// point of the QR is that the token never leaves this machine except onto a
// screen you are looking at, and a dependency in that path is a dependency
// that gets to see the token.
//
// Scope is deliberately narrow — byte mode, error correction level L or M,
// versions 1 to 10 (up to 271 bytes at L). A kaprek URL with a token is
// around 60 characters, so version 3 covers it with room to spare. Anything
// this cannot encode throws rather than truncating: a QR that scans to a
// broken URL is worse than no QR.
//
// Reference: ISO/IEC 18004. The tables below are the standard's, not
// derived — they are copied because deriving them at runtime would be more
// code and no more correct.

/** Data codeword capacity and ECC block layout per version, for level L and M. */
export const VERSIONS = [
  // [version, totalCodewords, {L: [eccPerBlock, group1Blocks, group1Words, group2Blocks, group2Words], M: [...]}]
  [1, 26, { L: [7, 1, 19, 0, 0], M: [10, 1, 16, 0, 0] }],
  [2, 44, { L: [10, 1, 34, 0, 0], M: [16, 1, 28, 0, 0] }],
  [3, 70, { L: [15, 1, 55, 0, 0], M: [26, 1, 44, 0, 0] }],
  [4, 100, { L: [20, 1, 80, 0, 0], M: [18, 2, 32, 0, 0] }],
  [5, 134, { L: [26, 1, 108, 0, 0], M: [24, 2, 43, 0, 0] }],
  [6, 172, { L: [18, 2, 68, 0, 0], M: [16, 4, 27, 0, 0] }],
  [7, 196, { L: [20, 2, 78, 0, 0], M: [18, 4, 31, 0, 0] }],
  [8, 242, { L: [24, 2, 97, 0, 0], M: [22, 2, 38, 2, 39] }],
  [9, 292, { L: [30, 2, 116, 0, 0], M: [22, 3, 36, 2, 37] }],
  [10, 346, { L: [18, 2, 68, 2, 69], M: [26, 4, 43, 1, 44] }],
];

/**
 * Every row must satisfy data + blocks*ecc === total, or the encoder accepts
 * more data than the matrix holds and placeData() silently cuts the stream
 * at the edge. Version 10 at level L claimed 4x68+2x69 data words with 6x18
 * ecc — 518 codewords in a 346-codeword matrix, so a 400-byte input was
 * accepted and truncated. (Codex' review; asserted in the tests.)
 */

/** Where the alignment pattern centres sit, per version (version 1 has none). */
const ALIGNMENT = [[], [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

/**
 * Version information, for versions 7 and up.
 *
 * Eighteen bits in two copies, beside the top-right and bottom-left finders.
 * Missing entirely until Grok's review pointed it out — every code from
 * version 7 on was structurally invalid, which is around 78 bytes at level M.
 * A kaprek URL is shorter than that, so it never showed up in use, and the
 * round-trip test could not see it because the reader did not read version
 * information either. Two blind spots lining up is how this kind of thing
 * survives a green suite.
 */
const VERSION_BITS = {
  7: 0x07c94,
  8: 0x085bc,
  9: 0x09a99,
  10: 0x0a4d3,
};

/** Pre-computed format information bits, [level][mask]. Level L = 01, M = 00. */
const FORMAT_BITS = {
  L: [0x77c4, 0x72f3, 0x7daa, 0x789d, 0x662f, 0x6318, 0x6c41, 0x6976],
  M: [0x5412, 0x5125, 0x5e7c, 0x5b4b, 0x45f9, 0x40ce, 0x4f97, 0x4aa0],
};

// GF(256) tables for Reed-Solomon, generated once at load.
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255];
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

/** The generator polynomial for `degree` error correction codewords. */
function generator(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i += 1) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j += 1) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

function eccFor(data, count) {
  const gen = generator(count);
  const remainder = new Array(count).fill(0);
  for (const byte of data) {
    const factor = byte ^ remainder[0];
    remainder.shift();
    remainder.push(0);
    for (let i = 0; i < count; i += 1) remainder[i] ^= gfMul(gen[i + 1], factor);
  }
  return remainder;
}

/** The smallest version that fits `byteLength` at this level. */
function pickVersion(byteLength, level) {
  for (const [version, total, ecc] of VERSIONS) {
    const [eccWords, g1Blocks, g1Words, g2Blocks, g2Words] = ecc[level];
    const dataWords = g1Blocks * g1Words + g2Blocks * g2Words;
    // 4 bits mode + 8 or 16 bits length, whichever this version uses.
    const headerBits = 4 + (version < 10 ? 8 : 16);
    if (dataWords * 8 >= headerBits + byteLength * 8) return { version, total, eccWords, g1Blocks, g1Words, g2Blocks, g2Words, dataWords };
  }
  throw new Error(`too much data for a QR code this size: ${byteLength} bytes`);
}

/** Mode indicator, length, payload, terminator, padding — as one byte array. */
function encodeData(text, spec) {
  const bytes = [...Buffer.from(text, 'utf8')];
  const bits = [];
  const push = (value, width) => {
    for (let i = width - 1; i >= 0; i -= 1) bits.push((value >> i) & 1);
  };
  push(0b0100, 4); // byte mode
  push(bytes.length, spec.version < 10 ? 8 : 16);
  for (const byte of bytes) push(byte, 8);

  const capacity = spec.dataWords * 8;
  for (let i = 0; i < 4 && bits.length < capacity; i += 1) bits.push(0); // terminator
  while (bits.length % 8 !== 0) bits.push(0);

  const words = [];
  for (let i = 0; i < bits.length; i += 8) words.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  // Pad alternately with 0xEC / 0x11, as the standard prescribes.
  for (let i = 0; words.length < spec.dataWords; i += 1) words.push(i % 2 === 0 ? 0xec : 0x11);
  return words;
}

/** Splits into blocks, computes ECC per block, and interleaves both. */
function interleave(words, spec) {
  const blocks = [];
  let offset = 0;
  for (let i = 0; i < spec.g1Blocks; i += 1) {
    blocks.push(words.slice(offset, offset + spec.g1Words));
    offset += spec.g1Words;
  }
  for (let i = 0; i < spec.g2Blocks; i += 1) {
    blocks.push(words.slice(offset, offset + spec.g2Words));
    offset += spec.g2Words;
  }
  const eccBlocks = blocks.map((block) => eccFor(block, spec.eccWords));

  const out = [];
  const maxData = Math.max(...blocks.map((block) => block.length));
  for (let i = 0; i < maxData; i += 1) for (const block of blocks) if (i < block.length) out.push(block[i]);
  for (let i = 0; i < spec.eccWords; i += 1) for (const block of eccBlocks) out.push(block[i]);
  return out;
}

/** An empty matrix plus a map of which cells are function patterns (and so untouchable). */
function baseMatrix(version) {
  const size = version * 4 + 17;
  const matrix = Array.from({ length: size }, () => new Array(size).fill(null));
  const reserved = Array.from({ length: size }, () => new Array(size).fill(false));

  const place = (row, col, value) => {
    matrix[row][col] = value;
    reserved[row][col] = true;
  };

  // Three finder patterns plus their separators.
  for (const [top, left] of [
    [0, 0],
    [0, size - 7],
    [size - 7, 0],
  ]) {
    for (let r = -1; r <= 7; r += 1) {
      for (let c = -1; c <= 7; c += 1) {
        const row = top + r;
        const col = left + c;
        if (row < 0 || col < 0 || row >= size || col >= size) continue;
        const onEdge = r === 0 || r === 6 || c === 0 || c === 6;
        const inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        place(row, col, r >= 0 && r <= 6 && c >= 0 && c <= 6 && (onEdge || inCore) ? 1 : 0);
      }
    }
  }

  // Timing patterns.
  for (let i = 8; i < size - 8; i += 1) {
    place(6, i, i % 2 === 0 ? 1 : 0);
    place(i, 6, i % 2 === 0 ? 1 : 0);
  }

  // Alignment patterns, skipping the ones that would sit on a finder.
  const centres = ALIGNMENT[version] ?? [];
  for (const row of centres) {
    for (const col of centres) {
      if ((row === 6 && col === 6) || (row === 6 && col === size - 7) || (row === size - 7 && col === 6)) continue;
      for (let r = -2; r <= 2; r += 1) {
        for (let c = -2; c <= 2; c += 1) {
          place(row + r, col + c, Math.max(Math.abs(r), Math.abs(c)) !== 1 ? 1 : 0);
        }
      }
    }
  }

  // Version information (7 and up): three by six modules beside the
  // top-right and bottom-left finders. Reserved BEFORE the data walk, or the
  // zigzag writes payload into them and placeVersion overwrites it later —
  // silently losing eight codewords.
  if (version >= 7) {
    for (let i = 0; i < 18; i += 1) {
      const row = Math.floor(i / 3);
      const col = i % 3;
      reserved[size - 11 + col][row] = true;
      reserved[row][size - 11 + col] = true;
    }
  }

  // The dark module, and the reserved format areas.
  place(size - 8, 8, 1);
  for (let i = 0; i < 9; i += 1) {
    if (matrix[8][i] === null) reserved[8][i] = true;
    if (matrix[i][8] === null) reserved[i][8] = true;
  }
  for (let i = 0; i < 8; i += 1) {
    reserved[8][size - 1 - i] = true;
    reserved[size - 1 - i][8] = true;
  }
  return { matrix, reserved, size };
}

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

/** Walks the zigzag and writes the codewords in, applying `mask` as it goes. */
function placeData(base, words, mask) {
  const { matrix, reserved, size } = base;
  const grid = matrix.map((row) => [...row]);
  const bits = [];
  for (const word of words) for (let i = 7; i >= 0; i -= 1) bits.push((word >> i) & 1);

  let index = 0;
  let upward = true;
  for (let right = size - 1; right > 0; right -= 2) {
    if (right === 6) right -= 1; // the vertical timing column is skipped entirely
    for (let step = 0; step < size; step += 1) {
      const row = upward ? size - 1 - step : step;
      for (const col of [right, right - 1]) {
        if (reserved[row][col]) continue;
        const bit = index < bits.length ? bits[index] : 0;
        index += 1;
        grid[row][col] = MASKS[mask](row, col) ? bit ^ 1 : bit;
      }
    }
    upward = !upward;
  }
  return grid;
}

/** The 18 version bits, bottom-left and top-right, for version >= 7. */
function placeVersion(grid, version) {
  const bits = VERSION_BITS[version];
  if (bits === undefined) return grid;
  const size = grid.length;
  for (let i = 0; i < 18; i += 1) {
    const bit = (bits >> i) & 1;
    const row = Math.floor(i / 3);
    const col = i % 3;
    grid[size - 11 + col][row] = bit;
    grid[row][size - 11 + col] = bit;
  }
  return grid;
}

function placeFormat(grid, level, mask) {
  const size = grid.length;
  const bits = FORMAT_BITS[level][mask];
  for (let i = 0; i < 15; i += 1) {
    // MSB first: position 0 carries bit 14. Written the other way round
    // until a real decoder was pointed at it — OpenCV recognised the code and
    // returned nothing, because a scanner that cannot read the format
    // information cannot know the mask. Checked against a reference matrix:
    // its bits, read MSB-first, land exactly on this table's L/mask-3 entry.
    const bit = (bits >> (14 - i)) & 1;
    // Copy one: around the top-left finder.
    if (i < 6) grid[8][i] = bit;
    else if (i === 6) grid[8][7] = bit;
    else if (i === 7) grid[8][8] = bit;
    else if (i === 8) grid[7][8] = bit;
    else grid[14 - i][8] = bit;
    // Copy two: bits 0-6 run UP the column beside the bottom-left finder,
    // bit 7 sits alone at [8][size-8], and 8-14 run along the row beside the
    // top-right one. Splitting it at 8 instead of 7 both leaves [8][size-8]
    // unwritten and overwrites the dark module at [size-8][8] — one
    // off-by-one, two symptoms, and the code still scanned often enough to
    // look fine.
    if (i < 7) grid[size - 1 - i][8] = bit;
    else if (i === 7) grid[8][size - 8] = bit;
    else grid[8][size - 15 + i] = bit;
  }
  return grid;
}

/** The standard's penalty score, used to pick the mask that reads most reliably. */
function penalty(grid) {
  const size = grid.length;
  let score = 0;

  const runPenalty = (line) => {
    let run = 1;
    for (let i = 1; i < line.length; i += 1) {
      if (line[i] === line[i - 1]) {
        run += 1;
        if (run === 5) score += 3;
        else if (run > 5) score += 1;
      } else run = 1;
    }
  };
  for (let i = 0; i < size; i += 1) {
    runPenalty(grid[i]);
    runPenalty(grid.map((row) => row[i]));
  }

  for (let r = 0; r < size - 1; r += 1) {
    for (let c = 0; c < size - 1; c += 1) {
      const value = grid[r][c];
      if (value === grid[r][c + 1] && value === grid[r + 1][c] && value === grid[r + 1][c + 1]) score += 3;
    }
  }

  let dark = 0;
  for (const row of grid) for (const cell of row) dark += cell;
  score += Math.floor(Math.abs((dark * 100) / (size * size) - 50) / 5) * 10;
  return score;
}

/**
 * Encodes `text` as a QR matrix of 0s and 1s.
 *
 * @param {string} text
 * @param {'L'|'M'} [level] - error correction. M is the default: a phone
 *   camera reading a terminal at an angle needs the margin more than the
 *   code needs to be small.
 * @returns {number[][]}
 * @throws when the text is too long for version 10
 */
export function encodeQr(text, level = 'M') {
  if (typeof text !== 'string' || text === '') throw new Error('a QR code needs text');
  if (!['L', 'M'].includes(level)) throw new Error(`unsupported error correction level: ${level}`);

  const bytes = Buffer.byteLength(text, 'utf8');
  const spec = pickVersion(bytes, level);
  const words = interleave(encodeData(text, spec), spec);
  const base = baseMatrix(spec.version);

  let best = null;
  for (let mask = 0; mask < 8; mask += 1) {
    const grid = placeVersion(placeFormat(placeData(base, words, mask), level, mask), spec.version);
    const score = penalty(grid);
    if (best === null || score < best.score) best = { grid, score };
  }
  return best.grid;
}

/**
 * The matrix as text for a terminal, two rows per line using half-blocks.
 *
 * A quiet zone of four modules is part of the standard and not decoration:
 * without it a scanner cannot find the edges against whatever else is on the
 * screen.
 */
export function qrToText(matrix, { quiet = 4 } = {}) {
  const size = matrix.length + quiet * 2;
  const at = (row, col) => {
    const r = row - quiet;
    const c = col - quiet;
    return r >= 0 && c >= 0 && r < matrix.length && c < matrix.length ? matrix[r][c] : 0;
  };

  const lines = [];
  for (let row = 0; row < size; row += 2) {
    let line = '';
    for (let col = 0; col < size; col += 1) {
      const top = at(row, col) === 1;
      const bottom = row + 1 < size && at(row + 1, col) === 1;
      // Dark modules are drawn light-on-dark: terminals are dark far more
      // often than not, and a scanner needs the contrast either way.
      line += top && bottom ? ' ' : top ? '▄' : bottom ? '▀' : '█';
    }
    lines.push(line);
  }
  return lines.join('\n');
}

/** The matrix as an SVG, for the browser. */
export function qrToSvg(matrix, { quiet = 4, size = 240 } = {}) {
  const modules = matrix.length + quiet * 2;
  const rects = [];
  for (let row = 0; row < matrix.length; row += 1) {
    for (let col = 0; col < matrix.length; col += 1) {
      if (matrix[row][col] === 1) rects.push(`<rect x="${col + quiet}" y="${row + quiet}" width="1" height="1"/>`);
    }
  }
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${modules} ${modules}" shape-rendering="crispEdges">`,
    `<rect width="${modules}" height="${modules}" fill="#fff"/>`,
    `<g fill="#000">${rects.join('')}</g>`,
    '</svg>',
  ].join('');
}
