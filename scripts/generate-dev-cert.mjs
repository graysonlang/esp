#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';

const args = parseArgs({
  options: {
    'trust': { type: 'boolean', default: false },
    'skip-trust': { type: 'boolean', default: false },
    'verbose': { type: 'boolean', short: 'v', default: false },
  },
});

const projectRoot = process.cwd();
const packageJson = JSON.parse(readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
const safePackageName = packageJson.name.replace(/^@/, '').replace(/[^a-zA-Z0-9._-]+/g, '-');
const certDir = path.resolve(projectRoot, process.env.ESP_DEV_CERTS_DIR ?? '.esp_dev_certs');
const certName = process.env.ESP_DEV_CERT_NAME ?? `${safePackageName}-dev`;
const certPath = path.join(certDir, `${certName}.pem`);
const keyPath = path.join(certDir, `${certName}-key.pem`);
const port = Number(process.env.HTTPS_PORT ?? process.env.PORT ?? 8443);
const force = process.env.ESP_DEV_CERT_FORCE === '1' || process.env.ESP_DEV_CERT_FORCE === 'true';
const explicitTrust = args.values.trust;
const skipTrust = args.values['skip-trust'];
const verbose = args.values.verbose;

function localIpv4Addresses() {
  return Object.values(networkInterfaces())
    .flatMap(entries => entries ?? [])
    .filter(entry => entry.family === 'IPv4' && !entry.internal && !entry.address.startsWith('169.254.'))
    .map(entry => entry.address)
    .sort();
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: options.stdio ?? 'pipe',
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `${command} exited with ${result.status}`);
  }

  return (result.stdout ?? '').trim();
}

function hasCommand(command) {
  const result = spawnSync(command, ['-version'], { stdio: 'ignore' });
  return !result.error && result.status === 0;
}

function displayPath(filePath) {
  const relativePath = path.relative(projectRoot, filePath);
  return relativePath.startsWith('..') || path.isAbsolute(relativePath) ? filePath : relativePath;
}

function trustLocalCa() {
  const caRoot = run('mkcert', ['-CAROOT']);

  if (process.platform === 'darwin') {
    const caRootPem = path.join(caRoot, 'rootCA.pem');
    run('security', [
      'add-trusted-cert',
      '-r', 'trustRoot',
      '-p', 'ssl',
      '-k', path.join(process.env.HOME, 'Library/Keychains/login.keychain-db'),
      caRootPem,
    ], { stdio: 'inherit' });
    return;
  }

  run('mkcert', ['-install'], { stdio: 'inherit' });
}

if (!hasCommand('mkcert')) {
  console.error('mkcert is required for the HTTPS development certificate.');
  console.error('Install it with Homebrew, then run this script again.');
  process.exit(1);
}

mkdirSync(certDir, { recursive: true });

const extraHosts = (process.env.ESP_DEV_CERT_HOSTS ?? '')
  .split(',')
  .map(host => host.trim())
  .filter(Boolean);
const addresses = localIpv4Addresses();
const hosts = ['localhost', '127.0.0.1', '::1', ...addresses, ...extraHosts];
let generatedCertificate = false;

if (force || !existsSync(certPath) || !existsSync(keyPath)) {
  run('mkcert', [
    '-cert-file',
    certPath,
    '-key-file',
    keyPath,
    ...hosts,
  ], { stdio: verbose ? 'inherit' : 'pipe' });
  generatedCertificate = true;
} else if (verbose) {
  console.log(`Using existing certificate: ${path.relative(projectRoot, certPath)}`);
  console.log('Set ESP_DEV_CERT_FORCE=1 to regenerate it.');
}

if ((generatedCertificate || explicitTrust) && !skipTrust) {
  trustLocalCa();
} else if (verbose && skipTrust) {
  console.log('Skipping local CA trust because --skip-trust was passed.');
}

if (verbose) {
  const resolvedCaRoot = run('mkcert', ['-CAROOT']);
  console.log('');
  console.log('HTTPS dev certificate is ready.');
  console.log(`Certificate: ${displayPath(certPath)}`);
  console.log(`Key: ${displayPath(keyPath)}`);
  console.log(`mkcert CA root: ${displayPath(resolvedCaRoot)}`);
  console.log('Trust: automatic on generation unless --skip-trust is passed; use --trust to retrust an existing CA.');
  console.log('');
  console.log('LAN URLs:');
  for (const address of addresses) {
    console.log(`  https://${address}:${port}/`);
  }
}
