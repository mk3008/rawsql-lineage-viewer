import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Socket } from 'node:net';
import { Client } from 'pg';

export interface RuntimeMetadata {
  readonly containerId: string;
  readonly containerName: string;
  readonly dockerServerVersion: string;
  readonly image: 'postgres:16-alpine';
  readonly imageId: string;
  readonly loopbackOnly: true;
  readonly mappedPort: number;
  readonly postgresVersion: string;
  readonly syntheticCredentialFileRemoved: boolean;
  readonly targetDatabaseCreatedFresh: true;
}

export interface CleanupEvidence {
  readonly cleanupAttempted: boolean;
  readonly containerRemoveSucceeded: boolean;
  readonly exactPostRunQuery: string;
  readonly loopbackPortClosed: boolean;
  readonly remainingNamedContainers: readonly string[];
  readonly temporaryDirectoryRemoved: boolean;
}

export class DisposablePostgres {
  readonly source: Client;
  readonly target: Client;
  readonly metadata: RuntimeMetadata;
  private readonly tempRoot: string;

  private constructor(
    source: Client,
    target: Client,
    metadata: RuntimeMetadata,
    tempRoot: string,
  ) {
    this.source = source;
    this.target = target;
    this.metadata = metadata;
    this.tempRoot = tempRoot;
  }

  static async start(): Promise<DisposablePostgres> {
    const dockerServerVersion = execFileSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8' }).trim();
    const suffix = `${Date.now()}-${randomBytes(4).toString('hex')}`;
    const containerName = `fixture-extraction-poc-${suffix}`;
    const tempRoot = mkdtempSync(resolve(tmpdir(), 'fixture-extraction-poc-'));
    const envFile = resolve(tempRoot, 'postgres.env');
    const password = randomBytes(24).toString('base64url');
    writeFileSync(envFile, `POSTGRES_USER=fixture_harness\nPOSTGRES_PASSWORD=${password}\nPOSTGRES_DB=fixture_source\n`, { encoding: 'utf8', mode: 0o600 });

    let source: Client | undefined;
    let target: Client | undefined;
    let containerId = '';
    let mappedPort = 0;
    try {
      containerId = execFileSync('docker', [
        'run', '--rm', '-d', '--name', containerName,
        '--label', 'rawsql.fixture-extraction=attempt-1',
        '-p', '127.0.0.1::5432',
        '--tmpfs', '/var/lib/postgresql/data:rw,noexec,nosuid,size=256m',
        '--env-file', envFile,
        'postgres:16-alpine',
      ], { encoding: 'utf8' }).trim();
      rmSync(envFile, { force: true });
      const portOutput = execFileSync('docker', ['port', containerName, '5432/tcp'], { encoding: 'utf8' });
      mappedPort = Number(portOutput.match(/127\.0\.0\.1:(\d+)/)?.[1]);
      if (!Number.isInteger(mappedPort) || mappedPort <= 0) throw new Error('Docker did not expose a loopback PostgreSQL port.');

      source = await connectWithRetry({ database: 'fixture_source', password, port: mappedPort });
      await source.query('CREATE DATABASE fixture_target');
      target = await connectWithRetry({ database: 'fixture_target', password, port: mappedPort });
      await configure(source);
      await configure(target);
      const imageId = execFileSync('docker', ['inspect', '--format', '{{.Image}}', containerName], { encoding: 'utf8' }).trim();
      const version = await source.query<{ version: string }>('select version()');
      const postgresVersion = version.rows[0]?.version.split(' on ')[0] ?? 'unknown';

      return new DisposablePostgres(source, target, {
        containerId,
        containerName,
        dockerServerVersion,
        image: 'postgres:16-alpine',
        imageId,
        loopbackOnly: true,
        mappedPort,
        postgresVersion,
        syntheticCredentialFileRemoved: true,
        targetDatabaseCreatedFresh: true,
      }, tempRoot);
    } catch (error) {
      await target?.end().catch(() => undefined);
      await source?.end().catch(() => undefined);
      rmSync(envFile, { force: true });
      rmSync(tempRoot, { force: true, recursive: true });
      if (containerId) {
        try { execFileSync('docker', ['rm', '-f', containerName], { stdio: 'ignore' }); } catch { /* keep the original startup failure */ }
      }
      throw error;
    }
  }

  async resetSchemas(): Promise<void> {
    await this.source.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
    await this.target.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  }

  async cleanup(): Promise<CleanupEvidence> {
    let containerRemoveSucceeded = false;
    await this.target.end().catch(() => undefined);
    await this.source.end().catch(() => undefined);
    try {
      execFileSync('docker', ['rm', '-f', this.metadata.containerName], { stdio: 'ignore' });
      containerRemoveSucceeded = true;
    } catch { /* returned as cleanup evidence */ }
    rmSync(this.tempRoot, { force: true, recursive: true });
    const exactPostRunQuery = `docker ps -a --filter name=${this.metadata.containerName} --format {{.Names}}`;
    const names = execFileSync('docker', [
      'ps', '-a', '--filter', `name=${this.metadata.containerName}`, '--format', '{{.Names}}',
    ], { encoding: 'utf8' }).split(/\r?\n/).filter((name) => name === this.metadata.containerName);
    return {
      cleanupAttempted: true,
      containerRemoveSucceeded,
      exactPostRunQuery,
      loopbackPortClosed: await portClosed(this.metadata.mappedPort),
      remainingNamedContainers: names,
      temporaryDirectoryRemoved: true,
    };
  }
}

async function connectWithRetry(input: { database: string; password: string; port: number }): Promise<Client> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const client = new Client({
      host: '127.0.0.1',
      port: input.port,
      user: 'fixture_harness',
      password: input.password,
      database: input.database,
    });
    try {
      await client.connect();
      return client;
    } catch (error) {
      lastError = error;
      await client.end().catch(() => undefined);
      await new Promise((resolveWait) => setTimeout(resolveWait, 500));
    }
  }
  throw new Error(`PostgreSQL did not become ready after bounded retries (${errorName(lastError)}).`);
}

async function configure(client: Client): Promise<void> {
  await client.query("SET statement_timeout = '5000ms'");
  await client.query("SET lock_timeout = '1000ms'");
}

function portClosed(port: number): Promise<boolean> {
  return new Promise((resolveClosed) => {
    const socket = new Socket();
    socket.setTimeout(500);
    socket.once('connect', () => { socket.destroy(); resolveClosed(false); });
    socket.once('error', () => resolveClosed(true));
    socket.once('timeout', () => { socket.destroy(); resolveClosed(true); });
    socket.connect(port, '127.0.0.1');
  });
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
