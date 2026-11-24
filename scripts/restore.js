'use strict';

const fs = require('node:fs');
const path = require('node:path');

const asarLib = require('./asar-lib');
const { DEFAULT_STATE_DIR, UTILS_START } = require('./install');

function restore(options = {}) {
  const stateDir = path.resolve(options.stateDir || DEFAULT_STATE_DIR);
  const manifestPath = path.join(stateDir, 'installation.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Installation manifest not found at ${manifestPath}`);
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const targetAsar = path.resolve(options.targetAsar || manifest.targetAsar || '');
  if (!targetAsar || !fs.existsSync(targetAsar)) {
    throw new Error(`Target app.asar not found: ${targetAsar}`);
  }
  if (manifest.targetAsar && path.resolve(manifest.targetAsar) !== targetAsar) {
    throw new Error(`Target mismatch (${targetAsar} !== ${manifest.targetAsar}); refusing cross-target restore.`);
  }

  const backupPath = manifest.backupPath;
  if (!backupPath || !fs.existsSync(backupPath)) {
    throw new Error(`Backup file missing: ${backupPath}`);
  }
  const backupSha = asarLib.sha256File(backupPath);
  if (!manifest.originalSha256 || backupSha !== manifest.originalSha256) {
    throw new Error(`Backup checksum mismatch (${backupSha} !== ${manifest.originalSha256}); refusing restore.`);
  }

  const currentSha = asarLib.sha256File(targetAsar);
  if (currentSha === manifest.originalSha256) {
    const { headerSha256 } = asarLib.readAsarHeader(targetAsar);
    return {
      ok: true,
      alreadyRestored: true,
      targetAsar,
      backupPath,
      sha256: currentSha,
      headerSha256
    };
  }

  if (!options.force && currentSha !== manifest.patchedSha256) {
    let hasMarker = false;
    try {
      const utils = asarLib.extractAsarFile(targetAsar, 'dist/utils.js').toString('utf8');
      hasMarker = utils.includes(UTILS_START) || utils.includes('installAgVario');
    } catch {}
    if (!hasMarker) {
      throw new Error(
        'Target app.asar checksum differs from patchedSha256 and has no ag-vario markers (host may have updated). Pass --force to override.'
      );
    }
  }

  if (options.dryRun) {
    return {
      ok: true,
      dryRun: true,
      targetAsar,
      backupPath,
      currentSha256: currentSha,
      expectedOriginalSha256: manifest.originalSha256
    };
  }

  const restoredSha = asarLib.atomicReplaceFile(backupPath, targetAsar, manifest.originalSha256);
  const { headerSha256 } = asarLib.readAsarHeader(targetAsar);

  if (restoredSha !== manifest.originalSha256) {
    throw new Error(`Post-restore checksum mismatch (${restoredSha} !== ${manifest.originalSha256})`);
  }
  if (manifest.originalHeaderSha256 && headerSha256 !== manifest.originalHeaderSha256) {
    throw new Error(`Post-restore header hash mismatch (${headerSha256} !== ${manifest.originalHeaderSha256})`);
  }

  return {
    ok: true,
    alreadyRestored: false,
    targetAsar,
    backupPath,
    sha256: restoredSha,
    headerSha256
  };
}

function parseCliArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--target' && argv[i + 1]) opts.targetAsar = argv[++i];
    else if (argv[i] === '--state-dir' && argv[i + 1]) opts.stateDir = argv[++i];
    else if (argv[i] === '--dry-run') opts.dryRun = true;
    else if (argv[i] === '--force') opts.force = true;
  }
  return opts;
}

if (require.main === module) {
  try {
    const res = restore(parseCliArgs(process.argv.slice(2)));
    console.log(JSON.stringify(res, null, 2));
  } catch (err) {
    console.error(`[ag-vario restore] ${err.message}`);
    process.exit(1);
  }
}

module.exports = {
  restore
};
