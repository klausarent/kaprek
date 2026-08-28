#!/usr/bin/env node
// CLI around src/memory/import.mjs: reads a manifest directory (scope-map.json,
// manifest-*.jsonl fact files, an optional missions.jsonl) and imports it into
// kaprek's memory and mission stores. See
// C:\Users\karent\Documents\Software\tools\ccview-docs\plans\2026-08-28-kaprek-befuellen.md
//
// Usage: node scripts/import-knowledge.mjs --dir <manifest-dir> [--data-dir <path>] [--dry-run]
import fs from 'node:fs';
import path from 'node:path';
import { ensureAppDir } from '../src/lib/appdir.mjs';
import { importManifest, parseJsonl } from '../src/memory/import.mjs';

function parseArgs(argv) {
  const result = { dir: null, dataDir: null, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dir') {
      result.dir = argv[i + 1] ?? null;
      i += 1;
    } else if (arg === '--data-dir') {
      result.dataDir = argv[i + 1] ?? null;
      i += 1;
    } else if (arg === '--dry-run') {
      result.dryRun = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!result.dir) throw new Error('--dir <manifest-dir> is required');
  return result;
}

/** Resolves --data-dir the same way appdir.mjs resolves the default: create it, then return its canonical path. */
function resolveDataDir(dataDirArg) {
  if (!dataDirArg) return ensureAppDir();
  const dir = path.resolve(dataDirArg);
  fs.mkdirSync(dir, { recursive: true });
  return fs.realpathSync.native(dir);
}

function readJsonlFile(file) {
  return parseJsonl(fs.readFileSync(file, 'utf8'));
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
    return;
  }

  const dir = path.resolve(args.dir);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    console.error(`Manifest directory not found: ${dir}`);
    process.exit(1);
    return;
  }

  const scopeMapPath = path.join(dir, 'scope-map.json');
  if (!fs.existsSync(scopeMapPath)) {
    console.error(`scope-map.json not found in ${dir}`);
    process.exit(1);
    return;
  }
  const scopeMap = JSON.parse(fs.readFileSync(scopeMapPath, 'utf8'));

  // Ungültige Zeilen werden nur gemeldet (siehe Tabelle unten), nicht als
  // Fehler behandelt — Exit 1 ist ausschließlich für eine fehlende
  // scope-map.json oder ein fehlendes Manifest-Verzeichnis reserviert.
  const fileReport = [];
  const facts = [];
  const factFiles = fs
    .readdirSync(dir)
    .filter((name) => /^manifest-.*\.jsonl$/.test(name))
    .sort();
  for (const name of factFiles) {
    const { rows, invalid } = readJsonlFile(path.join(dir, name));
    facts.push(...rows);
    fileReport.push({ file: name, rows: rows.length, invalid });
  }

  let missions = [];
  const missionsPath = path.join(dir, 'missions.jsonl');
  if (fs.existsSync(missionsPath)) {
    const { rows, invalid } = readJsonlFile(missionsPath);
    missions = rows;
    fileReport.push({ file: 'missions.jsonl', rows: rows.length, invalid });
  }

  const dataDir = resolveDataDir(args.dataDir);
  const result = importManifest({ dataDir, scopeMap, facts, missions, dryRun: args.dryRun });

  console.log(`kaprek import — ${args.dryRun ? 'dry run (nichts wird geschrieben)' : 'echter Lauf'}`);
  console.log(`manifest dir: ${dir}`);
  console.log(`data dir:     ${dataDir}`);
  console.log('');
  console.log('Dateien:');
  const totalInvalid = fileReport.reduce((sum, entry) => sum + entry.invalid, 0);
  if (fileReport.length === 0) {
    console.log('  (keine manifest-*.jsonl / missions.jsonl gefunden)');
  }
  for (const entry of fileReport) {
    console.log(`  ${entry.file.padEnd(30)} Zeilen=${String(entry.rows).padEnd(6)} ungueltig=${entry.invalid}`);
  }
  console.log('');
  console.log('Ergebnis:');
  console.log(`  scopesCreated:   ${result.scopesCreated}`);
  console.log(`  factsNew:        ${result.factsNew}`);
  console.log(`  factsConfirmed:  ${result.factsConfirmed}`);
  console.log(`  missionsNew:     ${result.missionsNew}`);
  console.log(`  missionsUpdated: ${result.missionsUpdated}`);
  console.log(`  redacted:        ${result.redacted}`);
  console.log(`  skipped:         ${result.skipped}`);
  console.log(`  backup:          ${result.backup.length ? result.backup.join(', ') : '(keiner)'}`);
  if (totalInvalid > 0) {
    console.log('');
    console.log(`Hinweis: ${totalInvalid} ungueltige JSONL-Zeile(n) uebersprungen (siehe Tabelle oben).`);
  }

  process.exit(0);
}

main();
