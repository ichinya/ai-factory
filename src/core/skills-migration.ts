import path from 'node:path';
import fs from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { AgentInstallation, AiFactoryConfig, ManagedSkillState } from './config.js';
import { loadConfig } from './config.js';
import { loadAllExtensions, type InstalledExtensionManifest } from './extensions.js';
import { getAvailableSkills, buildManagedSkillsState, renderSkillFiles } from './installer.js';
import { getSkillsDir } from '../utils/fs.js';
import { applyInjection } from './injections.js';
import { logSkillTarget, physicalProjectPath, resolveSkillTargets, type SkillRenderContext, type SkillTargetGroup } from './skill-targets.js';

interface SkillOwner {
  name: string;
  sourceDir: string;
  key: string;
  extension: boolean;
}

interface TreeInventory {
  files: Map<string, Buffer>;
  directories: string[];
}

interface MigrationFile {
  path: string;
  before: Buffer | null;
  after: Buffer | null;
}

export interface SkillMigrationPlan {
  config: AiFactoryConfig;
  configBefore: Buffer | null;
  groups: readonly SkillTargetGroup[];
  files: MigrationFile[];
  cleanupDirectories: string[];
  warnings: string[];
}

async function readOptional(file: string): Promise<Buffer | null> {
  try { return await fs.readFile(file); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function equalBytes(left: Buffer | null, right: Buffer | null): boolean {
  return left === null ? right === null : right !== null && left.equals(right);
}

async function inventory(directory: string): Promise<TreeInventory | null> {
  try {
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe managed skill directory: ${directory}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const result: TreeInventory = { files: new Map(), directories: [''] };
  async function visit(current: string, prefix: string): Promise<void> {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const file = path.join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Preserving linked entry; migration requires manual resolution: ${file}`);
      if (entry.isDirectory()) {
        result.directories.push(relative);
        await visit(file, relative);
      } else if (entry.isFile()) result.files.set(relative, await fs.readFile(file));
      else throw new Error(`Unsupported managed skill entry: ${file}`);
    }
  }
  await visit(directory, '');
  return result;
}

function equalFiles(left: Map<string, Buffer>, right: Map<string, Buffer>): boolean {
  return left.size === right.size && [...left].every(([name, bytes]) => equalBytes(bytes, right.get(name) ?? null));
}

function managedHash(files: Map<string, Buffer>): string {
  const hash = createHash('sha256');
  for (const [name, bytes] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    hash.update(`path:${name}\n`);
    hash.update(name.endsWith('.md') ? bytes.toString('utf8').replace(/\r\n/g, '\n')
      .replace(/\n?<!-- aif-ext:[^:]+:[^:]+:[^:]+:start -->\n[\s\S]*?\n<!-- aif-ext:[^:]+:[^:]+:[^:]+:end -->\n?/g, '').trimEnd() : bytes);
    hash.update('\n');
  }
  return hash.digest('hex');
}

// Validate source identity before any target deduplication, including custom basenames.
export async function collectSkillOwners(
  installedExtensions: readonly InstalledExtensionManifest[],
): Promise<Map<string, SkillOwner>> {
  const owners = new Map<string, SkillOwner>();
  for (const name of await getAvailableSkills()) {
    owners.set(name, { name, sourceDir: path.join(getSkillsDir(), name), key: `bundled:${name}`, extension: false });
  }
  for (const { dir, manifest } of installedExtensions) {
    const paths = new Set([...(manifest.skills ?? []), ...Object.keys(manifest.replaces ?? {})]);
    for (const relative of paths) {
      const replaces = manifest.replaces?.[relative];
      const name = replaces ?? path.posix.basename(relative.replaceAll('\\', '/'));
      if (!name || name === '.' || name === '..' || /[/\\]/.test(name)) throw new Error(`Unsafe skill name: ${name}`);
      const normalized = path.posix.normalize(relative.replaceAll('\\', '/'));
      if (path.posix.isAbsolute(normalized) || /^[a-z]:/i.test(normalized) || normalized === '..' || normalized.startsWith('../')) {
        throw new Error(`Unsafe extension skill source: ${relative}`);
      }
      const key = `${manifest.name}:${normalized}:${manifest.version}`;
      const existing = owners.get(name);
      if (existing && existing.key !== key && !(replaces && !existing.extension)) {
        throw new Error(`Conflicting skill owners for "${name}": ${existing.key} and ${key}. Use explicit replaces for a bundled skill.`);
      }
      owners.set(name, { name, sourceDir: path.join(dir, normalized), key, extension: true });
    }
  }
  return owners;
}

async function renderComposition(
  owner: SkillOwner, runtime: string, context: SkillRenderContext,
  extensions: readonly InstalledExtensionManifest[],
): Promise<Map<string, Buffer>> {
  const files = await renderSkillFiles(owner.sourceDir, owner.name, runtime, context);
  let content = files.get('SKILL.md')!.toString('utf8');
  for (const { dir, manifest } of extensions) {
    for (const injection of manifest.injections ?? []) {
      if (injection.target !== owner.name) continue;
      const bytes = await readOptional(path.join(dir, injection.file));
      if (!bytes) throw new Error(`Missing injection source for ${manifest.name}:${owner.name}`);
      content = applyInjection(content, bytes.toString('utf8'), injection.position, manifest.name, owner.name);
    }
  }
  files.set('SKILL.md', Buffer.from(content));
  return files;
}

export async function preflightSkillMigration(
  projectDir: string,
  config: AiFactoryConfig,
  groups?: readonly SkillTargetGroup[],
): Promise<SkillMigrationPlan> {
  const resolved = groups ?? await resolveSkillTargets(projectDir, config.agents);
  const previousGroups = await resolveSkillTargets(projectDir, config.agents, { select: false });
  const extensions = await loadAllExtensions(projectDir, (config.extensions ?? []).map(extension => extension.name));
  if (extensions.length !== (config.extensions ?? []).length) throw new Error('Missing installed extension manifest; resolve it before skill migration.');
  const owners = await collectSkillOwners(extensions);
  const next = structuredClone(config);
  const files = new Map<string, MigrationFile>();
  const cleanupDirectories = new Set<string>();
  const warnings: string[] = [];
  function addFile(relative: string, before: Buffer | null, after: Buffer | null): void {
    const previous = files.get(relative);
    if (previous && (!equalBytes(previous.before, before) || !equalBytes(previous.after, after))) {
      throw new Error(`Conflicting migration writes: ${relative}`);
    }
    if (!equalBytes(before, after)) files.set(relative, { path: relative, before, after });
  }
  for (const group of resolved) {
    const participants = group.targets.map(target => config.agents.find(agent => agent.id === target.id)).filter((agent): agent is AgentInstallation => !!agent);
    const needsMigration = group.targets.some(target => target.previousSkillsDir !== target.skillsDir)
      || participants.some(agent => Object.values(agent.managedSkills ?? {}).some(state => state.renderContextHash && state.renderContextHash !== group.context.hash));
    if (!needsMigration) continue;
    const names = new Set(participants.flatMap(agent => agent.installedSkills.map(name => path.posix.basename(name.replaceAll('\\', '/')))));
    for (const owner of owners.values()) if (owner.extension) names.add(owner.name);
    logSkillTarget('preflight:start', { target: group.skillsDir, skills: [...names] });
    for (const name of names) {
      if (!name || name === '.' || name === '..' || /[/\\]/.test(name)) throw new Error(`Unsafe installed skill name: ${name}`);
      const owner = owners.get(name);
      if (!owner) throw new Error(`Unknown source for "${name}"; preserve the existing copy and resolve its ownership before migration.`);
      const finalFiles = await renderComposition(owner, group.targets[0].id, group.context, extensions);
      const proofs: { directory: string; physical: string; tree: TreeInventory; files: Map<string, Buffer> }[] = [];
      for (const agent of participants) {
        const directory = `${agent.skillsDir}/${name}`;
        const physical = await physicalProjectPath(projectDir, directory);
        if (proofs.some(proof => proof.physical === physical)) continue;
        const tree = await inventory(physical);
        if (!tree) continue;
        const oldContext = previousGroups.find(previous => previous.targets.some(target => target.id === agent.id))!.context;
        const expected = await renderComposition(owner, agent.id, oldContext, extensions);
        if (!equalFiles(tree.files, expected)) throw new Error(`Skill migration conflict: "${directory}" differs from its known source (including injections or unknown files). Preserve both copies and resolve local changes.`);
        if (!owner.extension) {
          const state = (await buildManagedSkillsState(projectDir, agent, [name], oldContext))[name];
          const saved = agent.managedSkills?.[name];
          if (!saved || !state || saved.sourceHash !== state.sourceHash || saved.installedHash !== state.installedHash) {
            throw new Error(`Missing or changed managed baseline for "${directory}". Migration will not overwrite an unproven copy.`);
          }
        } else {
          const record = config.extensions?.find(extension => owner.key.startsWith(`${extension.name}:`));
          const manifest = extensions.find(extension => extension.manifest.name === record?.name)?.manifest;
          if (!record || record.version !== manifest?.version) throw new Error(`Unproven extension revision for "${directory}".`);
        }
        proofs.push({ directory, physical, tree, files: expected });
      }
      if (proofs.length === 0) throw new Error(`No installed baseline for "${name}"; restore the source before migrating to ${group.skillsDir}.`);
      const destination = `${group.skillsDir}/${name}`;
      const destinationPath = await physicalProjectPath(projectDir, destination);
      const destinationTree = await inventory(destinationPath);
      if (destinationTree && !equalFiles(destinationTree.files, finalFiles)
        && !proofs.some(proof => equalFiles(destinationTree.files, proof.files))) {
        throw new Error(`Skill migration conflict: "${destination}" and "${proofs[0].directory}" differ. No files were changed.`);
      }
      for (const [relative, bytes] of finalFiles) addFile(`${destination}/${relative}`, destinationTree?.files.get(relative) ?? null, bytes);
      for (const proof of proofs) {
        if (proof.physical === destinationPath) continue;
        for (const [relative, bytes] of proof.tree.files) addFile(`${proof.directory}/${relative}`, bytes, null);
        // Only directories required by known files are eligible for empty-directory cleanup.
        const knownDirectories = new Set(['']);
        for (const relative of proof.files.keys()) {
          let parent = path.posix.dirname(relative);
          while (parent !== '.') { knownDirectories.add(parent); parent = path.posix.dirname(parent); }
        }
        for (const relative of proof.tree.directories) {
          if (knownDirectories.has(relative)) cleanupDirectories.add(relative ? `${proof.directory}/${relative}` : proof.directory);
          else warnings.push(`Preserving unknown directory: ${proof.directory}/${relative}`);
        }
      }
      const sourceState = !owner.extension ? (await buildManagedSkillsState(projectDir, participants.find(agent => agent.managedSkills?.[name])!, [name]))[name] : null;
      for (const agent of next.agents.filter(agent => participants.some(participant => participant.id === agent.id))) {
        agent.managedSkills ??= {};
        if (sourceState && agent.installedSkills.includes(name)) {
          const state: ManagedSkillState = { sourceHash: sourceState.sourceHash, installedHash: managedHash(finalFiles), renderContextHash: group.context.hash };
          agent.managedSkills[name] = state;
        }
      }
    }
    for (const agent of next.agents) {
      if (participants.some(participant => participant.id === agent.id)) agent.skillsDir = group.skillsDir;
    }
  }
  return { config: next, configBefore: await readOptional(path.join(projectDir, '.ai-factory.json')), groups: resolved,
    files: [...files.values()], cleanupDirectories: [...cleanupDirectories], warnings };
}

const MIGRATION_ROOT = '.ai-factory/skill-migrations';
const lockContext = new AsyncLocalStorage<ReadonlySet<string>>();
const bytesDigest = (bytes: Buffer | null): string | null => bytes === null ? null : createHash('sha256').update(bytes).digest('hex');

interface JournalFile {
  path: string;
  physical: string;
  before: string | null;
  after: string | null;
}

interface MigrationJournal {
  version: 1;
  id: string;
  phase: 'prepared' | 'writing' | 'committed';
  configBefore: string | null;
  configAfter: string;
  files: JournalFile[];
  cleanupDirectories: string[];
}

async function atomicWrite(file: string, bytes: Buffer): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await fs.open(temporary, 'wx');
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    await fs.rename(temporary, file);
  } finally {
    await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

async function checkedRuntimeRoot(projectDir: string): Promise<string> {
  const root = await physicalProjectPath(projectDir, MIGRATION_ROOT);
  await fs.mkdir(root, { recursive: true });
  if ((await fs.lstat(root)).isSymbolicLink()) throw new Error('Migration state directory must not be a link.');
  return root;
}

export async function withSkillProjectLock<T>(projectDir: string, action: () => Promise<T>): Promise<T> {
  const project = await fs.realpath(projectDir);
  const held = lockContext.getStore();
  if (held?.has(project)) return action();
  const root = await checkedRuntimeRoot(project);
  const lockPath = path.join(root, 'lock.json');
  const token = randomUUID();
  const lockBytes = Buffer.from(JSON.stringify({ pid: process.pid, token }));
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.writeFile(lockPath, lockBytes, { flag: 'wx' });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || attempt > 0) throw error;
      const oldBytes = await readOptional(lockPath);
      let old: { pid: number; token: string };
      try { old = JSON.parse(oldBytes!.toString('utf8')); } catch { throw new Error(`Invalid migration lock: ${lockPath}`); }
      if (!Number.isSafeInteger(old.pid) || old.pid <= 0 || typeof old.token !== 'string') throw new Error(`Invalid migration lock: ${lockPath}`);
      let alive = true;
      try { process.kill(old.pid, 0); } catch (probeError) {
        if ((probeError as NodeJS.ErrnoException).code === 'ESRCH') alive = false;
      }
      if (alive) throw new Error(`Another AI Factory operation holds the project migration lock (pid ${old.pid}). Retry after it finishes.`);
      if (!equalBytes(await readOptional(lockPath), oldBytes)) throw new Error('Migration lock changed concurrently. Retry.');
      await fs.unlink(lockPath);
    }
  }
  logSkillTarget('lock:acquired', { project });
  try {
    return await lockContext.run(new Set([...(held ?? []), project]), action);
  } finally {
    if (equalBytes(await readOptional(lockPath), lockBytes)) await fs.unlink(lockPath);
    logSkillTarget('lock:released', { project });
  }
}

async function readJournalBlob(directory: string, filename: string, digest: string | null): Promise<Buffer | null> {
  if (digest === null) return null;
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('Invalid recovery digest.');
  const file = path.join(directory, filename);
  if (!(await fs.lstat(file)).isFile() || (await fs.lstat(file)).isSymbolicLink()) throw new Error(`Unsafe recovery blob: ${file}`);
  const bytes = await fs.readFile(file);
  if (bytesDigest(bytes) !== digest) throw new Error(`Recovery blob digest mismatch: ${file}`);
  return bytes;
}

async function verifyJournal(
  projectDir: string, root: string, raw: unknown,
): Promise<{ journal: MigrationJournal; directory: string; before: Buffer | null; after: Buffer }> {
  const journal = raw as MigrationJournal;
  if (!journal || journal.version !== 1 || !/^[a-f0-9-]{36}$/.test(journal.id)
    || !['prepared', 'writing', 'committed'].includes(journal.phase)
    || !Array.isArray(journal.files) || !Array.isArray(journal.cleanupDirectories)) throw new Error('Invalid skill migration journal. Preserve recovery material.');
  const directory = path.join(root, journal.id);
  if (!(await fs.lstat(directory)).isDirectory() || (await fs.lstat(directory)).isSymbolicLink()) throw new Error('Unsafe recovery directory.');
  const before = await readJournalBlob(directory, 'config.before', journal.configBefore);
  const after = await readJournalBlob(directory, 'config.after', journal.configAfter);
  if (!after) throw new Error('Missing committed config snapshot.');
  const snapshots: AiFactoryConfig[] = [JSON.parse(after.toString('utf8'))];
  if (before) snapshots.push(JSON.parse(before.toString('utf8')));
  const allowedRoots = new Set<string>();
  for (const config of snapshots) {
    if (!Array.isArray(config.agents)) throw new Error('Invalid recovery config.');
    const groups = await resolveSkillTargets(projectDir, config.agents, { select: false });
    for (const group of groups) allowedRoots.add(group.physicalPath);
  }
  const seen = new Set<string>();
  for (const [index, file] of journal.files.entries()) {
    if (!file || typeof file.path !== 'string' || typeof file.physical !== 'string') throw new Error('Invalid recovery file entry.');
    const actual = await physicalProjectPath(projectDir, file.path);
    if (actual !== file.physical || seen.has(actual) || ![...allowedRoots].some(allowed => actual.startsWith(`${allowed}${path.sep}`))) {
      throw new Error(`Recovery path changed or escaped its skill root: ${file.path}`);
    }
    seen.add(actual);
    await readJournalBlob(directory, `${index}.before`, file.before);
    await readJournalBlob(directory, `${index}.after`, file.after);
  }
  for (const relative of journal.cleanupDirectories) {
    if (typeof relative !== 'string') throw new Error('Invalid cleanup directory.');
    const actual = await physicalProjectPath(projectDir, relative);
    if (![...allowedRoots].some(allowed => actual.startsWith(`${allowed}${path.sep}`))) throw new Error(`Unsafe cleanup directory: ${relative}`);
  }
  return { journal, directory, before, after };
}

async function finishJournal(projectDir: string, root: string, journal: MigrationJournal, committed: boolean): Promise<void> {
  const { directory, before, after } = await verifyJournal(projectDir, root, journal);
  const configPath = path.join(projectDir, '.ai-factory.json');
  if (!equalBytes(await readOptional(configPath), committed ? after : before)) {
    throw new Error(`Config revision changed during migration recovery. Preserve ${root}; restore the expected config revision or reconcile it manually.`);
  }
  // Validate every affected file before any recovery mutation.
  for (const file of journal.files) {
    const current = bytesDigest(await readOptional(await physicalProjectPath(projectDir, file.path)));
    if (current !== file.before && current !== file.after) throw new Error(`Concurrent file change during recovery: ${file.path}. Recovery material retained at ${root}.`);
  }
  for (const [index, file] of journal.files.entries()) {
    const target = await physicalProjectPath(projectDir, file.path);
    if (target !== file.physical) throw new Error(`Recovery target changed: ${file.path}`);
    const current = bytesDigest(await readOptional(target));
    if (current !== file.before && current !== file.after) throw new Error(`Concurrent file change: ${file.path}`);
    const desired = committed ? file.after : file.before;
    if (current === desired) continue;
    const bytes = await readJournalBlob(directory, `${index}.${committed ? 'after' : 'before'}`, desired);
    if (bytes === null) await fs.unlink(target);
    else await atomicWrite(target, bytes);
  }
  if (!equalBytes(await readOptional(configPath), committed ? after : before)) throw new Error(`Config revision changed; recovery material retained at ${root}.`);
  if (committed) {
    for (const relative of [...journal.cleanupDirectories].sort((a, b) => b.length - a.length)) {
      const target = await physicalProjectPath(projectDir, relative);
      await fs.rmdir(target).catch(error => {
        if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
      });
    }
  }
  // Keep raw backups for inspection; a completed receipt is never replayed.
  await fs.rename(path.join(root, 'active.json'), path.join(directory, committed ? 'committed.json' : 'rolled-back.json'));
  logSkillTarget('recovery:complete', { operation: journal.id, committed });
}

export async function recoverSkillMigration(projectDir: string): Promise<void> {
  await withSkillProjectLock(projectDir, async () => {
    const root = await checkedRuntimeRoot(projectDir);
    const bytes = await readOptional(path.join(root, 'active.json'));
    if (!bytes) return;
    const { journal, before, after } = await verifyJournal(projectDir, root, JSON.parse(bytes.toString('utf8')));
    const current = await readOptional(path.join(projectDir, '.ai-factory.json'));
    if (!equalBytes(current, before) && !equalBytes(current, after)) throw new Error(`Config revision conflicts with pending migration. Recovery material retained at ${root}.`);
    const committed = equalBytes(current, after);
    console.log(`[skill-migration] Recovering ${journal.id} (${committed ? 'finish cleanup' : 'rollback destination'}).`);
    await finishJournal(projectDir, root, journal, committed);
  });
}

export async function applySkillMigration(
  projectDir: string, plan: SkillMigrationPlan,
  options: { onPhase?: (phase: 'prepared' | 'destination' | 'committed' | 'cleanup') => Promise<void> } = {},
): Promise<AiFactoryConfig> {
  return withSkillProjectLock(projectDir, async () => {
    const root = await checkedRuntimeRoot(projectDir);
    if (await readOptional(path.join(root, 'active.json'))) throw new Error('Pending skill migration must be recovered before applying another plan.');
    const configPath = path.join(projectDir, '.ai-factory.json');
    if (!equalBytes(await readOptional(configPath), plan.configBefore)) throw new Error('Config revision changed after migration preflight. No installed files were changed.');
    // Preserve raw native ownership and unknown config fields; only skill fields belong to this transaction.
    const rawConfig = plan.configBefore ? JSON.parse(plan.configBefore.toString('utf8')) as AiFactoryConfig : structuredClone(plan.config);
    if (!Array.isArray(rawConfig.agents)) throw new Error('Upgrade the legacy config schema before migrating managed skills.');
    for (const agent of rawConfig.agents) {
      const next = plan.config.agents.find(candidate => candidate.id === agent.id);
      if (!next) continue;
      agent.skillsDir = next.skillsDir;
      if (next.managedSkills) agent.managedSkills = next.managedSkills;
    }
    const after = Buffer.from(`${JSON.stringify(rawConfig, null, 2)}\n`);
    if (!plan.files.length && equalBytes(after, plan.configBefore)) return plan.config;
    const id = randomUUID();
    const directory = path.join(root, id);
    await fs.mkdir(directory);
    const journal: MigrationJournal = { version: 1, id, phase: 'prepared', configBefore: bytesDigest(plan.configBefore),
      configAfter: bytesDigest(after)!, files: [], cleanupDirectories: plan.cleanupDirectories };
    if (plan.configBefore) await fs.writeFile(path.join(directory, 'config.before'), plan.configBefore, { flag: 'wx' });
    await fs.writeFile(path.join(directory, 'config.after'), after, { flag: 'wx' });
    for (const [index, file] of plan.files.entries()) {
      const physical = await physicalProjectPath(projectDir, file.path);
      if (!equalBytes(await readOptional(physical), file.before)) throw new Error(`File changed after preflight: ${file.path}`);
      journal.files.push({ path: file.path, physical, before: bytesDigest(file.before), after: bytesDigest(file.after) });
      if (file.before) await fs.writeFile(path.join(directory, `${index}.before`), file.before, { flag: 'wx' });
      if (file.after) await fs.writeFile(path.join(directory, `${index}.after`), file.after, { flag: 'wx' });
    }
    const writeJournal = () => atomicWrite(path.join(root, 'active.json'), Buffer.from(JSON.stringify(journal)));
    await verifyJournal(projectDir, root, journal);
    await writeJournal();
    console.log(`[skill-migration] Migrating skills (${plan.files.length} file operations).`);
    try {
      await options.onPhase?.('prepared');
      journal.phase = 'writing';
      await writeJournal();
      for (const [index, file] of plan.files.entries()) {
        if (!file.after) continue; // Sources survive until the config commit is durable.
        const physical = await physicalProjectPath(projectDir, file.path);
        if (physical !== journal.files[index].physical || !equalBytes(await readOptional(physical), file.before)) throw new Error(`Concurrent destination change: ${file.path}`);
        await atomicWrite(physical, file.after);
      }
      await options.onPhase?.('destination');
      for (const [index, file] of plan.files.entries()) {
        const physical = await physicalProjectPath(projectDir, file.path);
        if (physical !== journal.files[index].physical || !equalBytes(await readOptional(physical), file.after ?? file.before)) throw new Error(`Concurrent migration file change: ${file.path}`);
      }
      if (!equalBytes(await readOptional(configPath), plan.configBefore)) throw new Error('Concurrent config revision change before migration commit.');
      await atomicWrite(configPath, after);
      journal.phase = 'committed';
      await writeJournal();
      await options.onPhase?.('committed');
      await options.onPhase?.('cleanup');
      await finishJournal(projectDir, root, journal, true);
      for (const warning of plan.warnings) console.warn(`[skill-migration] ${warning}`);
      console.log('[skill-migration] Migration committed; native configuration and agent files preserved.');
      return plan.config;
    } catch (error) {
      if (journal.phase !== 'committed') {
        try { await finishJournal(projectDir, root, journal, false); } catch (rollbackError) {
          throw new Error(`Skill migration failed: ${(error as Error).message}. Recovery stopped: ${(rollbackError as Error).message}. Backups: ${directory}`);
        }
      }
      throw new Error(`Skill migration ${journal.phase === 'committed' ? 'committed with pending cleanup' : 'rolled back'}: ${(error as Error).message}. Recovery material: ${directory}`);
    }
  });
}

export async function prepareSkillTargets(
  projectDir: string, config: AiFactoryConfig, groups?: readonly SkillTargetGroup[],
): Promise<readonly SkillTargetGroup[]> {
  return withSkillProjectLock(projectDir, async () => {
    const pending = await readOptional(path.join(projectDir, MIGRATION_ROOT, 'active.json'));
    await recoverSkillMigration(projectDir);
    if (pending) {
      const recovered = await loadConfig(projectDir);
      if (recovered) Object.assign(config, recovered);
    }
    const resolved = groups ?? await resolveSkillTargets(projectDir, config.agents);
    const extensions = await loadAllExtensions(projectDir, (config.extensions ?? []).map(extension => extension.name));
    await collectSkillOwners(extensions);
    const needsMigration = resolved.some(group => group.targets.some(target => target.previousSkillsDir !== target.skillsDir)
      || config.agents.filter(agent => group.targets.some(target => target.id === agent.id))
        .some(agent => Object.values(agent.managedSkills ?? {}).some(state => state.renderContextHash && state.renderContextHash !== group.context.hash)));
    if (needsMigration) {
      const plan = await preflightSkillMigration(projectDir, config, resolved);
      await applySkillMigration(projectDir, plan);
      Object.assign(config, await loadConfig(projectDir));
    }
    return resolved;
  });
}

export async function captureSharedSkillRollback(
  projectDir: string, agents: AgentInstallation[], names: readonly string[],
): Promise<() => Promise<void>> {
  const snapshots: { relative: string; physical: string; tree: TreeInventory | null }[] = [];
  for (const group of await resolveSkillTargets(projectDir, agents, { select: false })) {
    if (group.targets.length < 2 || !group.targets.every(target => ['codex', 'codex-app'].includes(target.id))) continue;
    for (const name of new Set(names.map(name => path.posix.basename(name.replaceAll('\\', '/'))))) {
      if (!name || name === '.' || name === '..') throw new Error('Unsafe shared rollback skill name.');
      const relative = `${group.skillsDir}/${name}`;
      const physical = await physicalProjectPath(projectDir, relative);
      snapshots.push({ relative, physical, tree: await inventory(physical) });
    }
  }
  return async () => {
    for (const snapshot of snapshots) {
      if (await physicalProjectPath(projectDir, snapshot.relative) !== snapshot.physical) throw new Error(`Shared rollback target changed: ${snapshot.relative}`);
      const current = await inventory(snapshot.physical);
      for (const [relative, bytes] of snapshot.tree?.files ?? []) await atomicWrite(path.join(snapshot.physical, relative), bytes);
      for (const relative of current?.files.keys() ?? []) {
        if (!snapshot.tree?.files.has(relative)) await fs.unlink(path.join(snapshot.physical, relative));
      }
      for (const relative of snapshot.tree?.directories ?? []) await fs.mkdir(path.join(snapshot.physical, relative), { recursive: true });
      for (const relative of [...(current?.directories ?? [])].sort((a, b) => b.length - a.length)) {
        if (!snapshot.tree?.directories.includes(relative)) await fs.rmdir(path.join(snapshot.physical, relative)).catch(error => {
          if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
        });
      }
    }
  };
}
