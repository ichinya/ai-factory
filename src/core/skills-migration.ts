import path from 'node:path';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { AgentInstallation, AiFactoryConfig, ManagedSkillState } from './config.js';
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
