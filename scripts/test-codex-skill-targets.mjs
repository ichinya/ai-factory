import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installSkills, installExtensionSkills, buildManagedSkillsState, updateSkills, removeOwnedSkills } from '../dist/core/installer.js';
import { saveConfig, loadConfig } from '../dist/core/config.js';
import { resolveSkillTargets, hasSurvivingConfigConsumer } from '../dist/core/skill-targets.js';
import { preflightSkillMigration, collectSkillOwners, applySkillMigration, recoverSkillMigration, withSkillProjectLock } from '../dist/core/skills-migration.js';
import { commitResolvedExtension, composeInstalledExtensionSkills, installExtensionAssetsForAllAgents, stripInjectionsForAllAgents } from '../dist/core/extension-ops.js';
import { getExtensionsDir } from '../dist/core/extensions.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const groups = new Set((process.argv.find(arg => arg.startsWith('--group='))?.slice(8) ?? 'control,targets,core,cli').split(','));
const cases = [];
const test = (group, name, run) => cases.push({ group, name, run });
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

// Raw custody evidence deliberately includes empty directories and links.
async function snapshot(directory) {
  const entries = {};
  async function visit(current, relative) {
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) entries[relative] = ['link', await fs.readlink(current)];
    else if (stat.isDirectory()) {
      entries[relative] = ['directory'];
      for (const name of (await fs.readdir(current)).sort()) await visit(path.join(current, name), `${relative}/${name}`);
    } else entries[relative] = ['file', digest(await fs.readFile(current))];
  }
  await visit(directory, '.');
  return entries;
}

const installation = (id, skillsDir, installedSkills = ['aif']) => ({
  id, skillsDir, installedSkills,
  mcp: { github: false, filesystem: false, postgres: false, chromeDevtools: false, playwright: false },
});

async function legacyProject(project) {
  const agent = installation('codex', '.codex/skills');
  await installSkills({ projectDir: project, agentId: agent.id, skillsDir: agent.skillsDir, skills: agent.installedSkills });
  agent.managedSkills = await buildManagedSkillsState(project, agent, agent.installedSkills);
  const config = { version: '2.19.0', agents: [agent] };
  await saveConfig(project, config, { hydrateAgentFileSources: false });
  await fs.mkdir(path.join(project, '.agents'), { recursive: true });
  return config;
}

function runInit(project, agents = 'codex') {
  const url = pathToFileURL(path.join(root, 'dist/cli/commands/init.js')).href;
  const code = `const { initCommand } = await import(${JSON.stringify(url)}); await initCommand({agents:${JSON.stringify(agents)},skills:'aif'});`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: project, encoding: 'utf8', timeout: 60000 });
  assert.equal(result.status, 0, `init ${agents} failed: ${result.error?.message ?? result.stderr}`);
}

function runUpdate(project, force = false) {
  const url = pathToFileURL(path.join(root, 'dist/cli/commands/update.js')).href;
  const code = `globalThis.fetch = async () => ({ok:true,status:200,headers:{get:()=>null},json:async()=>({version:'2.19.0'})}); const { updateCommand } = await import(${JSON.stringify(url)}); await updateCommand({force:${force}});`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: project, encoding: 'utf8', timeout: 60000 });
  assert.equal(result.status, 0, `update failed: ${result.error?.message ?? result.stderr}\n${result.stdout}`);
  return result.stdout;
}

test('control', 'raw snapshots detect empty directories and byte edits', async project => {
  await fs.writeFile(path.join(project, 'sample'), 'one');
  const before = await snapshot(project);
  await fs.mkdir(path.join(project, 'empty'));
  assert.notDeepEqual(await snapshot(project), before);
  await fs.writeFile(path.join(project, 'sample'), 'two');
  assert.notEqual((await snapshot(project))['./sample'][1], before['./sample'][1]);
});

test('control', 'empty project keeps the Codex legacy default', async project => {
  runInit(project);
  const config = JSON.parse(await fs.readFile(path.join(project, '.ai-factory.json'), 'utf8'));
  assert.equal(config.agents[0].skillsDir, '.codex/skills');
});

test('core', 'direct installer renders the actual override in helper paths', async project => {
  assert.deepEqual(await installSkills({ projectDir: project, agentId: 'codex', skillsDir: '.agents/skills', skills: ['aif'] }), ['aif']);
  const content = await fs.readFile(path.join(project, '.agents/skills/aif/SKILL.md'), 'utf8');
  assert.ok(content.includes('.agents/skills/'), 'effective skill paths missing');
  assert.ok(!content.includes('.codex/skills/'), 'legacy helper path remains');
  assert.ok(content.includes('$aif-'), 'Codex invocation syntax lost');
});

test('core', 'extension references receive the same effective context', async project => {
  const source = path.join(project, 'extension/demo');
  await fs.mkdir(path.join(source, 'references'), { recursive: true });
  await fs.writeFile(path.join(source, 'SKILL.md'), '---\nname: demo\ndescription: demo\n---\n{{skills_dir}} /aif-plan\n');
  await fs.writeFile(path.join(source, 'references/helper.md'), '{{skills_dir}}/demo/script.mjs');
  assert.deepEqual(await installExtensionSkills(project, installation('codex', '.agents/skills'), path.dirname(source), ['demo']), ['demo']);
  assert.equal(await fs.readFile(path.join(project, '.agents/skills/demo/references/helper.md'), 'utf8'), '.agents/skills/demo/script.mjs');
});

test('core', 'custom project overrides keep runtime home paths and singleton metadata', async project => {
  const source = path.join(project, 'extension/demo');
  await fs.mkdir(source, { recursive: true });
  await fs.writeFile(path.join(source, 'SKILL.md'), '---\nname: demo\n---\n{{skills_dir}} ~/{{skills_dir}} {{home_skills_dir}} {{config_dir}} {{skills_cli_agent_flag}} {{agent_name}}');
  await installExtensionSkills(project, installation('codex-app', '.team/skills'), path.dirname(source), ['demo']);
  const content = await fs.readFile(path.join(project, '.team/skills/demo/SKILL.md'), 'utf8');
  assert.ok(content.includes('.team/skills ~/.agents/skills ~/.agents/skills .agents  Codex app'));
});

test('core', 'shared CLI/App renders identically and receipts track profile changes', async project => {
  const agents = [installation('codex', '.agents/skills'), installation('codex-app', '.agents/skills')];
  const [group] = await resolveSkillTargets(project, agents, { select: false });
  await installSkills({ projectDir: project, agentId: 'codex', skillsDir: group.skillsDir, skills: ['aif'], renderContext: group.context });
  const before = await snapshot(path.join(project, group.skillsDir));
  await installSkills({ projectDir: project, agentId: 'codex-app', skillsDir: group.skillsDir, skills: ['aif'], renderContext: group.context });
  assert.deepEqual(await snapshot(path.join(project, group.skillsDir)), before);
  const agent = agents[0];
  agent.managedSkills = await buildManagedSkillsState(project, agent, ['aif'], group.context);
  agent.managedAgentFiles = { 'demo.toml': { sourceHash: 'source', installedHash: 'installed', renderContextHash: group.context.hash } };
  await saveConfig(project, { version: '2.19.0', agents: [agent] }, { hydrateAgentFileSources: false });
  const loaded = await loadConfig(project);
  assert.equal(loaded.agents[0].managedSkills.aif.renderContextHash, group.context.hash);
  assert.equal(loaded.agents[0].managedAgentFiles['demo.toml'].renderContextHash, undefined);
  const stable = await updateSkills(agent, project, { renderContext: group.context });
  assert.equal(stable.entries.find(entry => entry.skill === 'aif').status, 'unchanged');
  const singleton = await updateSkills(agent, project);
  assert.equal(singleton.entries.find(entry => entry.skill === 'aif').reason, 'render-context-changed');
});

for (const legacy of [false, true]) {
  test('cli', `init prefers an existing empty .agents (legacy directory: ${legacy})`, async project => {
    await fs.mkdir(path.join(project, '.agents'));
    if (legacy) await fs.mkdir(path.join(project, '.codex'));
    runInit(project);
    const config = JSON.parse(await fs.readFile(path.join(project, '.ai-factory.json'), 'utf8'));
    assert.equal(config.agents[0].skillsDir, '.agents/skills');
    await fs.access(path.join(project, '.agents/skills/aif/SKILL.md'));
    await fs.access(path.join(project, '.codex/config.toml'));
    await fs.access(path.join(project, '.codex/agents'));
  });
}

test('cli', 'empty CLI/App init migrates on update and stays stable on repeated update', async project => {
  runInit(project, 'codex-app,codex');
  const first = await loadConfig(project);
  assert.equal(first.agents.find(agent => agent.id === 'codex').skillsDir, '.codex/skills');
  const nativeConfig = await fs.readFile(path.join(project, '.codex/config.toml'));
  runUpdate(project);
  const migrated = await loadConfig(project);
  assert.ok(migrated.agents.every(agent => agent.skillsDir === '.agents/skills'));
  await assert.rejects(fs.access(path.join(project, '.codex/skills/aif/SKILL.md')));
  const before = await snapshot(path.join(project, '.agents/skills'));
  const output = runUpdate(project);
  assert.ok(!output.includes('local drift'));
  assert.deepEqual(await snapshot(path.join(project, '.agents/skills')), before);
  runUpdate(project, true);
  assert.deepEqual(await fs.readFile(path.join(project, '.codex/config.toml')), nativeConfig);
  await assert.rejects(fs.access(path.join(project, '.codex/skills/aif/SKILL.md')));
});

for (const survivor of ['codex', 'codex-app']) {
  test('cli', `re-init retains shared skills/config when only ${survivor} remains`, async project => {
    await fs.mkdir(path.join(project, '.agents'));
    runInit(project, 'codex,codex-app');
    const native = await fs.readFile(path.join(project, '.codex/config.toml'));
    await fs.mkdir(path.join(project, '.agents/skills/user'));
    await fs.writeFile(path.join(project, '.agents/skills/user/SKILL.md'), 'private skill');
    runInit(project, survivor);
    const config = await loadConfig(project);
    assert.deepEqual(config.agents.map(agent => agent.id), [survivor]);
    assert.equal(config.agents[0].skillsDir, '.agents/skills');
    await fs.access(path.join(project, '.agents/skills/aif/SKILL.md'));
    assert.equal(await fs.readFile(path.join(project, '.agents/skills/user/SKILL.md'), 'utf8'), 'private skill');
    assert.deepEqual(await fs.readFile(path.join(project, '.codex/config.toml')), native);
  });
}

let failures = 0;
test('ownership', 'removing either runtime preserves surviving skills and shared native config', async project => {
  const agents = [installation('codex', '.agents/skills'), installation('codex-app', '.agents/skills')];
  const [group] = await resolveSkillTargets(project, agents, { select: false });
  await installSkills({ projectDir: project, agentId: 'codex', skillsDir: group.skillsDir, skills: ['aif'], renderContext: group.context });
  for (const agent of agents) agent.managedSkills = await buildManagedSkillsState(project, agent, ['aif'], group.context);
  const before = await snapshot(path.join(project, '.agents/skills'));
  for (const [removed, survivor] of [agents, [...agents].reverse()]) {
    assert.deepEqual(await removeOwnedSkills(project, removed, [survivor]), []);
    assert.deepEqual(await snapshot(path.join(project, '.agents/skills')), before);
    assert.equal(await hasSurvivingConfigConsumer(project, '.codex/config.toml', [survivor]), true);
  }
  await fs.mkdir(path.join(project, '.agents/skills/user'));
  await fs.writeFile(path.join(project, '.agents/skills/user/SKILL.md'), 'user skill');
  await fs.writeFile(path.join(project, '.agents/skills/aif/user-notes'), 'local notes');
  assert.deepEqual(await removeOwnedSkills(project, agents[0], []), []);
  await fs.access(path.join(project, '.agents/skills/aif/user-notes'));
  await fs.unlink(path.join(project, '.agents/skills/aif/user-notes'));
  assert.deepEqual(await removeOwnedSkills(project, agents[0], []), ['aif']);
  assert.equal(await fs.readFile(path.join(project, '.agents/skills/user/SKILL.md'), 'utf8'), 'user skill');
});

test('extensions', 'shared replacements project outcomes and apply one injection', async project => {
  const agents = [installation('codex', '.agents/skills'), installation('codex-app', '.agents/skills')];
  const [group] = await resolveSkillTargets(project, agents, { select: false });
  await installSkills({ projectDir: project, agentId: 'codex', skillsDir: group.skillsDir, skills: ['aif'], renderContext: group.context });
  for (const agent of agents) agent.managedSkills = await buildManagedSkillsState(project, agent, ['aif'], group.context);
  const config = { version: '2.19.0', agents, extensions: [] };
  await saveConfig(project, config, { hydrateAgentFileSources: false });
  const source = path.join(project, 'extension-source');
  await fs.mkdir(path.join(source, 'replacement'), { recursive: true });
  await fs.mkdir(path.join(source, 'demo'));
  await fs.writeFile(path.join(source, 'replacement/SKILL.md'), '---\nname: replacement\ndescription: replacement\n---\nReplacement {{skills_dir}} /aif-plan\n');
  await fs.writeFile(path.join(source, 'demo/SKILL.md'), '---\nname: demo\ndescription: demo\n---\nCustom\n');
  await fs.writeFile(path.join(source, 'injection.md'), 'Injected once');
  const manifest = { name: 'aif-ext-target-fixture', version: '1.0.0', skills: ['replacement', 'demo'], replaces: { replacement: 'aif' }, injections: [{ target: 'aif', position: 'append', file: 'injection.md' }] };
  await fs.writeFile(path.join(source, 'extension.json'), JSON.stringify(manifest));
  const result = await commitResolvedExtension(project, { config, source, resolved: { sourceDir: source, manifest, cleanup: async () => {} } });
  await saveConfig(project, config, { hydrateAgentFileSources: false });
  assert.deepEqual(result.record.replacedSkills, ['aif']);
  const outcomes = await installExtensionAssetsForAllAgents(project, config.agents, result.extensionDir, manifest);
  assert.equal(outcomes.replacementOutcomes[0].successCount, 2);
  assert.equal(outcomes.replacementOutcomes[0].agentCount, 2);
  assert.equal(outcomes.injectionCount, 1);
  assert.equal(await composeInstalledExtensionSkills(project, config), 1);
  const content = await fs.readFile(path.join(project, '.agents/skills/aif/SKILL.md'), 'utf8');
  assert.ok(content.includes('Replacement .agents/skills $aif-plan'));
  assert.equal(content.split('Injected once').length - 1, 1);
  await fs.access(path.join(project, '.agents/skills/demo/SKILL.md'));
  const skillsBeforeFailure = await snapshot(path.join(project, '.agents/skills'));
  const invalid = { ...manifest, version: '2.0.0', mcpServers: [{ key: 'broken', template: {} }] };
  await fs.writeFile(path.join(source, 'extension.json'), JSON.stringify(invalid));
  await fs.writeFile(path.join(source, 'replacement/SKILL.md'), '---\nname: replacement\n---\nChanged version');
  await assert.rejects(commitResolvedExtension(project, { config, source, resolved: { sourceDir: source, manifest: invalid, cleanup: async () => {} } }));
  assert.deepEqual(await snapshot(path.join(project, '.agents/skills')), skillsBeforeFailure);
  await fs.unlink(path.join(getExtensionsDir(project), manifest.name, 'extension.json'));
  await stripInjectionsForAllAgents(project, config.agents, manifest.name);
  assert.ok(!(await fs.readFile(path.join(project, '.agents/skills/aif/SKILL.md'), 'utf8')).includes('Injected once'));
  await fs.writeFile(path.join(getExtensionsDir(project), manifest.name, 'extension.json'), JSON.stringify(manifest));
  const commandUrl = pathToFileURL(path.join(root, 'dist/cli/commands/extension.js')).href;
  const removed = spawnSync(process.execPath, ['--input-type=module', '-e', `const m=await import(${JSON.stringify(commandUrl)}); await m.extensionRemoveCommand(${JSON.stringify(manifest.name)});`], { cwd: project, encoding: 'utf8', timeout: 60000 });
  assert.equal(removed.status, 0, removed.stderr + removed.stdout);
  assert.deepEqual((await loadConfig(project)).extensions, []);
  await assert.rejects(fs.access(path.join(project, '.agents/skills/demo/SKILL.md')));
  assert.ok(!(await fs.readFile(path.join(project, '.agents/skills/aif/SKILL.md'), 'utf8')).includes('Replacement'));
});

test('migration', 'migration preserves native bytes and metadata and is repeatable', async project => {
  const config = await legacyProject(project);
  await fs.mkdir(path.join(project, '.codex/agents'), { recursive: true });
  await fs.writeFile(path.join(project, '.codex/agents/user.toml'), 'native bytes');
  await fs.writeFile(path.join(project, '.codex/config.toml'), 'native config');
  config.agents[0].managedAgentFiles = { 'user.toml': { sourceHash: 'source', installedHash: 'receipt', custom: true } };
  await fs.writeFile(path.join(project, '.ai-factory.json'), JSON.stringify(config));
  const native = await snapshot(path.join(project, '.codex/agents'));
  const plan = await preflightSkillMigration(project, config);
  await applySkillMigration(project, plan);
  const saved = JSON.parse(await fs.readFile(path.join(project, '.ai-factory.json'), 'utf8'));
  assert.equal(saved.agents[0].skillsDir, '.agents/skills');
  assert.deepEqual(saved.agents[0].managedAgentFiles, config.agents[0].managedAgentFiles);
  assert.deepEqual(await snapshot(path.join(project, '.codex/agents')), native);
  assert.equal(await fs.readFile(path.join(project, '.codex/config.toml'), 'utf8'), 'native config');
  await assert.rejects(fs.access(path.join(project, '.codex/skills/aif/SKILL.md')));
  await recoverSkillMigration(project);
  assert.equal((await preflightSkillMigration(project, await loadConfig(project))).files.length, 0);
});

for (const phase of ['prepared', 'destination']) {
  test('migration', `failure at ${phase} restores original file/config bytes`, async project => {
    const config = await legacyProject(project);
    const before = await snapshot(path.join(project, '.codex'));
    const configBytes = await fs.readFile(path.join(project, '.ai-factory.json'));
    await assert.rejects(applySkillMigration(project, await preflightSkillMigration(project, config), {
      onPhase: async current => { if (current === phase) throw new Error('injected failure'); },
    }), /rolled back/);
    assert.deepEqual(await snapshot(path.join(project, '.codex')), before);
    assert.deepEqual(await fs.readFile(path.join(project, '.ai-factory.json')), configBytes);
    await assert.rejects(fs.access(path.join(project, '.agents/skills/aif/SKILL.md')));
  });
}

test('migration', 'concurrent config edits survive commit and rollback attempts', async project => {
  const config = await legacyProject(project);
  const changed = Buffer.from(JSON.stringify({ ...config, userField: 'concurrent edit' }));
  await assert.rejects(applySkillMigration(project, await preflightSkillMigration(project, config), {
    onPhase: async phase => { if (phase === 'destination') await fs.writeFile(path.join(project, '.ai-factory.json'), changed); },
  }), /config revision|Config revision/);
  assert.deepEqual(await fs.readFile(path.join(project, '.ai-factory.json')), changed);
  await assert.rejects(recoverSkillMigration(project), /Config revision/);
  assert.deepEqual(await fs.readFile(path.join(project, '.ai-factory.json')), changed);
  await fs.access(path.join(project, '.codex/skills/aif/SKILL.md'));
  await fs.access(path.join(project, '.ai-factory/skill-migrations/active.json'));
});

for (const phase of ['destination', 'committed', 'cleanup']) {
  test('migration', `process interruption at ${phase} recovers idempotently`, async project => {
    await legacyProject(project);
    const migrationUrl = pathToFileURL(path.join(root, 'dist/core/skills-migration.js')).href;
    const configUrl = pathToFileURL(path.join(root, 'dist/core/config.js')).href;
    const code = `const m = await import(${JSON.stringify(migrationUrl)}); const c = await import(${JSON.stringify(configUrl)}); const p = process.cwd(); await m.applySkillMigration(p, await m.preflightSkillMigration(p, await c.loadConfig(p)), {onPhase: async phase => {if (phase === ${JSON.stringify(phase)}) process.exit(86);}});`;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: project, encoding: 'utf8', timeout: 60000 });
    assert.equal(child.status, 86, child.stderr);
    await recoverSkillMigration(project);
    await recoverSkillMigration(project);
    const config = await loadConfig(project);
    assert.equal(config.agents[0].skillsDir, phase === 'destination' ? '.codex/skills' : '.agents/skills');
    await fs.access(path.join(project, config.agents[0].skillsDir, 'aif/SKILL.md'));
    await assert.rejects(fs.access(path.join(project, '.ai-factory/skill-migrations/active.json')));
  });
}

test('migration', 'project lock rejects concurrent independent operations', async project => {
  await fs.mkdir(path.join(project, '.ai-factory/skill-migrations'), { recursive: true });
  await fs.writeFile(path.join(project, '.ai-factory/skill-migrations/lock.json'), JSON.stringify({pid: process.pid, token: 'another-operation'}));
  await assert.rejects(withSkillProjectLock(project, async () => assert.fail('must not execute')), /Another AI Factory operation/);
});

test('preflight', 'preflight plans a proven move without writing bytes', async project => {
  const config = await legacyProject(project);
  await fs.mkdir(path.join(project, '.codex/skills/user-skill'));
  await fs.writeFile(path.join(project, '.codex/skills/user-skill/notes'), 'preserve');
  const before = await snapshot(project);
  const plan = await preflightSkillMigration(project, config);
  assert.equal(plan.config.agents[0].skillsDir, '.agents/skills');
  assert.ok(plan.files.some(file => file.path.startsWith('.agents/skills/aif/') && file.after));
  assert.ok(plan.files.some(file => file.path.startsWith('.codex/skills/aif/') && !file.after));
  assert.ok(!plan.files.some(file => file.path.includes('user-skill')));
  assert.deepEqual(await snapshot(project), before);
});

for (const mode of ['missing-state', 'local-edit', 'unknown-file', 'injection-edit', 'destination-conflict']) {
  test('preflight', `preflight preserves all bytes on ${mode}`, async project => {
    const config = await legacyProject(project);
    const skill = path.join(project, '.codex/skills/aif');
    if (mode === 'missing-state') config.agents[0].managedSkills = {};
    if (mode === 'local-edit') await fs.appendFile(path.join(skill, 'SKILL.md'), '\nlocal change');
    if (mode === 'unknown-file') await fs.writeFile(path.join(skill, 'local-note'), 'private notes');
    if (mode === 'injection-edit') await fs.appendFile(path.join(skill, 'SKILL.md'), '\n<!-- aif-ext:demo:aif:append:start -->\nchanged\n<!-- aif-ext:demo:aif:append:end -->\n');
    if (mode === 'destination-conflict') {
      await fs.mkdir(path.join(project, '.agents/skills/aif'), { recursive: true });
      await fs.writeFile(path.join(project, '.agents/skills/aif/SKILL.md'), 'user destination');
    }
    const before = await snapshot(project);
    await assert.rejects(preflightSkillMigration(project, config), /baseline|conflict|source/i);
    assert.deepEqual(await snapshot(project), before);
  });
}

test('preflight', 'source owner collisions require explicit replacement', async () => {
  const extension = (name, skills, replaces) => ({ dir: name, manifest: { name, version: '1', skills, replaces } });
  await assert.rejects(collectSkillOwners([extension('one', ['skills/demo']), extension('two', ['other/demo'])]), /Conflicting skill owners/);
  await assert.rejects(collectSkillOwners([extension('one', ['skills/aif'])]), /Conflicting skill owners/);
  const owners = await collectSkillOwners([extension('one', ['skills/demo'], { 'skills/demo': 'aif' })]);
  assert.equal(owners.get('aif').extension, true);
});

test('targets', 'resolver uses one snapshot and preserves persisted/custom targets', async project => {
  const inputs = [installation('codex', '.codex/skills'), installation('codex-app', '.agents/skills')];
  for (const order of [inputs, [...inputs].reverse()]) {
    const resolved = await resolveSkillTargets(project, order);
    assert.deepEqual(resolved.flatMap(group => group.targets).map(target => target.skillsDir).sort(), ['.agents/skills', '.codex/skills']);
  }
  await fs.mkdir(path.join(project, '.agents'));
  const shared = await resolveSkillTargets(project, inputs);
  assert.equal(shared.length, 1);
  assert.equal(shared[0].skillsDir, '.agents/skills');
  assert.equal(shared[0].context.agent.displayName, 'Codex');
  assert.equal((await resolveSkillTargets(project, [installation('codex', '.team/skills')]))[0].skillsDir, '.team/skills');
  await fs.rmdir(path.join(project, '.agents'));
  assert.equal((await resolveSkillTargets(project, [installation('codex', '.agents/skills')]))[0].skillsDir, '.agents/skills');
  await fs.writeFile(path.join(project, '.agents'), 'ordinary file');
  assert.equal((await resolveSkillTargets(project, [inputs[0]]))[0].skillsDir, '.codex/skills');
});

test('targets', 'resolver rejects escaping, nested, native and incompatible targets', async project => {
  for (const unsafe of ['../escape', 'C:/external/skills', '/absolute/skills', '.codex', '.codex/agents', '.ai-factory/skill-migrations/work']) {
    await assert.rejects(resolveSkillTargets(project, [installation('codex', unsafe)]));
  }
  await assert.rejects(resolveSkillTargets(project, [installation('codex', '.agents/skills'), installation('codex-app', '.agents/skills/child')]));
  await assert.rejects(resolveSkillTargets(project, [installation('codex', '.agents/skills'), installation('universal', '.agents/skills')]), /Incompatible/);
});

test('targets', 'physical aliases share a target without a separate cleanup source', async project => {
  await fs.mkdir(path.join(project, '.agents/skills'), { recursive: true });
  await fs.mkdir(path.join(project, '.codex'));
  try {
    await fs.symlink(path.join(project, '.agents/skills'), path.join(project, '.codex/skills'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (!['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) throw error;
    console.log(`CAPABILITY native links unavailable (${error.code}); deterministic overlap/escape cases remain mandatory`);
    return;
  }
  assert.ok((await fs.lstat(path.join(project, '.codex/skills'))).isSymbolicLink());
  const [group] = await resolveSkillTargets(project, [installation('codex', '.codex/skills')]);
  assert.equal(group.targets[0].sourcePhysicalPath, group.targets[0].physicalPath);
  await assert.rejects(resolveSkillTargets(project, [installation('codex', '.codex/skills'), installation('codex-app', '.agents/skills/missing')]));
});

for (const { group, name, run } of cases) {
  if (!groups.has(group)) continue;
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'aif-codex-target-'));
  try {
    await run(project);
    console.log(`PASS [${group}] ${name}`);
  } catch (error) {
    failures++;
    console.error(`FAIL [${group}] ${name}: ${error.message}`);
  } finally {
    await fs.rm(project, { recursive: true, force: true, maxRetries: 3 });
  }
}
process.exitCode = failures ? 1 : 0;
