import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installSkills, installExtensionSkills, buildManagedSkillsState, updateSkills } from '../dist/core/installer.js';
import { saveConfig, loadConfig } from '../dist/core/config.js';
import { resolveSkillTargets } from '../dist/core/skill-targets.js';
import { preflightSkillMigration, collectSkillOwners } from '../dist/core/skills-migration.js';

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

let failures = 0;
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
