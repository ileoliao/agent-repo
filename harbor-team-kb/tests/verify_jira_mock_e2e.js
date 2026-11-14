#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { JiraEditorMock } = require('./fixtures/jira-editor-mock');

const engine = path.resolve(__dirname, '..');

function run({ reportFile } = {}) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-jira-e2e-'));
  const homeA = path.join(sandbox, 'member-a');
  const homeB = path.join(sandbox, 'member-b');
  const workspaceA = path.join(sandbox, 'workspace-a');
  const workspaceB = path.join(sandbox, 'workspace-b');
  const dataA = path.join(sandbox, 'data-a');
  const dataB = path.join(sandbox, 'data-b');
  const remote = path.join(sandbox, 'private-data.git');
  const service = path.join(workspaceA, 'repos', 'demo-service');
  const infra = path.join(workspaceA, 'repos', 'demo-infra');
  const actors = { pm: { name: 'pm', role: 'pm' }, qa: { name: 'qa-reviewer', role: 'qa' }, dev: { name: 'developer', role: 'dev' } };
  const report = { jira: 'mock', git: 'real local repositories and bare origin', checks: [], limitations: ['No real Jira Editor/API or Jira server configuration is exercised.', 'No live Copilot/model session or GitHub branch protection/PR API is exercised.', 'QA semantic judgment and human review actions are represented by fixture actors.'] };
  const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
  const environment = home => ({ ...process.env, HOME: home, HARBOR_KB_ROOT: '', HARBOR_KB_CACHE_DIR: path.join(home, '.cache', 'harbor-kb'), HARBOR_KB_NO_AUTO_SYNC: '', GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: 'file' });
  const git = (cwd, ...args) => {
    const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: environment(homeA), timeout: 15000 });
    assert.strictEqual(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const cli = (script, args, { home = homeA, cwd = workspaceA, status = 0 } = {}) => {
    const result = spawnSync(process.execPath, [script, ...args], { cwd, env: environment(home), encoding: 'utf8', timeout: 30000 });
    assert.strictEqual(result.status, status, `${path.basename(script)} ${args.join(' ')}\n${result.stderr}\n${result.stdout}`);
    return result.stdout;
  };
  const check = (name, action) => { action(); report.checks.push({ name, passed: true }); console.log(`  ✓ Jira mock E2E: ${name}`); };
  const identity = repo => { git(repo, 'config', 'user.name', 'E2E Reviewer'); git(repo, 'config', 'user.email', 'e2e@example.com'); };
  const commit = (repo, message) => { git(repo, 'add', '.'); git(repo, 'commit', '-m', message); };
  const installed = (home, skill, file) => path.join(home, '.copilot', 'skills', skill, 'scripts', file);
  const kbA = installed(homeA, 'team-kb', 'kb.js');
  const storyA = installed(homeA, 'story-guard', 'story.js');
  const publishA = installed(homeA, 'team-kb-publish', 'publish.js');
  const kbB = installed(homeB, 'team-kb', 'kb.js');
  const storyB = installed(homeB, 'story-guard', 'story.js');
  const specId = 'billing/spec/atomic-seat-grants';
  const mapId = 'billing/map/service-and-infra';
  const storyFile = path.join(homeA, '.harbor', 'drafts', 'stories', 'BILL-1.md');
  const commentsFile = path.join(homeA, '.harbor', 'drafts', 'stories', 'BILL-1-comments.txt');
  const jira = new JiraEditorMock(path.join(sandbox, 'jira-store.json'));
  const code = limit => `'use strict';\nfunction grantSeats(account, count) {\n  if (count < 0 || count > ${limit}) return { accepted: false, seats: account.seats };\n  account.seats += count;\n  return { accepted: true, seats: account.seats };\n}\nmodule.exports = { grantSeats };\n`;
  const businessTests = limit => `const assert = require('assert');\nconst { grantSeats } = require('./grant');\nfor (const [count, accepted] of [[2,true],[${limit},true],[${limit + 1},false],[-1,false]]) {\n  const account = { seats: 100 };\n  const result = grantSeats(account, count);\n  assert.strictEqual(result.accepted, accepted);\n  assert.strictEqual(account.seats, accepted ? 100 + count : 100);\n}\n`;
  const card = (title, summary, triggers, sources, body) => `---\ntitle: ${JSON.stringify(title)}\nsummary: ${JSON.stringify(summary)}\ntriggers: ${JSON.stringify(triggers)}\nsources: ${JSON.stringify(sources)}\n---\n\n${body}\n`;
  let issueKey, firstAudit, finalAudit, published, mergedCommit, sourceCommit;

  try {
    for (const directory of [homeA, homeB, workspaceA, workspaceB, service, infra]) fs.mkdirSync(directory, { recursive: true });
    write(path.join(workspaceA, '.loop', '.gitkeep'), '');
    write(path.join(service, 'grant.js'), code(10));
    write(path.join(service, 'grant.test.js'), businessTests(10));
    write(path.join(infra, 'helm', 'values.yaml'), 'service: demo-service\n');
    for (const repository of [service, infra]) { git(repository, 'init', '-b', 'main'); identity(repository); commit(repository, 'Initial source'); }

    check('initialize private data origin and install copied skills for two members', () => {
      cli(path.join(engine, 'plug.js'), ['init-data-repo', dataA]);
      write(path.join(dataA, 'CODEOWNERS'), '* @demo/kb-owners\n/standards/ @demo/qa-reviewers\n');
      const index = require(path.join(engine, 'skills', 'team-kb', 'scripts', 'kb_index.js'));
      const anchors = ['demo-service:grant.js#grantSeats', 'demo-service:grant.test.js'];
      const pinned = anchors.map(source => `${source}@${index.anchorInfo(workspaceA, source).fingerprint}`);
      write(path.join(dataA, 'kb', `${specId}.md`), card('Rejected seat grants preserve state', 'Rejected seat grants must leave persisted account state unchanged.', ['rejected seat grants', 'seat allocation invariant'], [...pinned, 'JIRA:BILL-0'], 'The service owns acceptance decisions; rejected requests must not mutate account state. Implementation and boundary values live in source and tests.'));
      write(path.join(dataA, 'kb', `${mapId}.md`), card('Seat service and infrastructure ownership', 'Find seat allocation implementation and Helm configuration across repositories.', ['seat service topology', 'helm ownership'], ['demo-service:grant.js#grantSeats', 'demo-infra:helm/'], `demo-service owns allocation decisions. demo-infra owns deployment configuration. Related invariant: ${specId}.`));
      identity(dataA); git(dataA, 'branch', '-M', 'main'); commit(dataA, 'Initial private knowledge and standard');
      git(sandbox, 'init', '--bare', remote); git(remote, 'symbolic-ref', 'HEAD', 'refs/heads/main');
      git(dataA, 'remote', 'add', 'origin', remote); git(dataA, 'push', '-u', 'origin', 'main');
      git(sandbox, 'clone', remote, dataB); identity(dataB);
      cli(path.join(engine, 'plug.js'), ['install', '-w', workspaceA, '--copilot', '--mode', 'copy', '--agents', 'none', '--no-gardener', '--data-repo', dataA]);
      cli(path.join(engine, 'plug.js'), ['install', '--mode', 'copy', '--data-repo', dataB], { home: homeB, cwd: workspaceB });
      git(workspaceB, 'clone', service, path.join(workspaceB, 'repos', 'demo-service'));
      git(workspaceB, 'clone', infra, path.join(workspaceB, 'repos', 'demo-infra'));
    });

    check('read the same standard through Copilot and Mate paths and find the cross-repository map', () => {
      const copilotStandard = JSON.parse(cli(storyA, ['standard']));
      const mateStory = path.join(workspaceA, '.github', 'skills', 'story-guard', 'scripts', 'story.js');
      assert.strictEqual(JSON.parse(cli(mateStory, ['standard'])).raw, copilotStandard.raw);
      const maps = JSON.parse(cli(kbA, ['map', '--domain', 'billing', '--json']));
      assert.deepStrictEqual(maps.domains[0].repos, ['demo-infra', 'demo-service']);
    });

    const summary = 'Increase seat grant capacity while preserving rejection atomicity';
    const rawDescription = [
      'h2. Story Statement', 'As an administrator I can grant up to twenty seats per request.', 'Rejected seat grants must preserve persisted account state.',
      'h2. Scope & Architecture Mapping', '*Domain*: billing', 'Affected Repos: demo-service demo-infra', mapId,
      'h2. Spec Delta', specId, 'Clarify service ownership of rejection decisions.',
      'h2. Acceptance Criteria & Concrete Examples', '|| Case || Input || Output ||',
      '| Normal: grant | balance=100, count=2 | accepted=true, balance=102 |',
      '| Boundary: maximum | balance=100, count=20 | accepted=true, balance=120 |',
      '| Rejection: excessive | balance=100, count=21 | accepted=false, balance=100 |',
      'h2. Out of Scope', 'Pricing and invoice calculation.\t原始 Jira Wiki 正文保持不变。',
    ].join('\r\n');

    check('route a real draft and create a mock Jira issue; NONE cannot bypass a matching invariant', () => {
      write(storyFile, `Title: ${summary}\n\n${rawDescription}`);
      const checked = JSON.parse(cli(storyA, ['check', storyFile, '--json']));
      assert(checked.passed); assert.strictEqual(checked.qa_route, 'REQUIRED');
      issueKey = jira.create(actors.pm, { summary, description: rawDescription, qaRoute: checked.qa_route });
      const bypass = path.join(sandbox, 'bypass.md');
      write(bypass, `Title: ${summary}\n\n${rawDescription.replace(`${specId}\r\nClarify service ownership of rejection decisions.`, 'NONE')}`);
      const bypassCheck = JSON.parse(cli(storyA, ['check', bypass]));
      assert.strictEqual(bypassCheck.qa_route, 'REQUIRED');
      assert(bypassCheck.matched_existing_entries.includes(specId));
      assert.strictEqual(jira.get(issueKey).status, 'Pending Story QA');
    });

    check('a low-risk NONE story follows the standard route and still requires closing impact fields', () => {
      const lowRiskFile = path.join(sandbox, 'low-risk.md');
      const description = [
        'h2. Story Statement', 'As an administrator I can read clearer help labels.',
        'h2. Scope & Architecture Mapping', '*Domain*: billing', 'Affected Repos: demo-service', mapId,
        'h2. Spec Delta', 'NONE',
        'h2. Acceptance Criteria & Concrete Examples', '|| Case || Input || Output ||',
        '| Normal: help | topic=allocation | label=Allocation help |',
        '| Boundary: unknown | topic=unknown | message=Topic not found |',
        'h2. Out of Scope', 'Changing billing behavior.',
      ].join('\r\n');
      write(lowRiskFile, `Title: Update administrator help text\n\n${description}`);
      const result = JSON.parse(cli(storyA, ['check', lowRiskFile]));
      assert(result.passed); assert.strictEqual(result.qa_route, 'STANDARD');
      const key = jira.create(actors.pm, { summary: 'Update help text', description, qaRoute: result.qa_route });
      assert.strictEqual(jira.get(key).status, 'Ready'); jira.transition(actors.dev, key, 'In Progress');
      assert.throws(() => jira.transition(actors.dev, key, 'Closed'), /SPEC_IMPACT_REQUIRED/);
      jira.update(actors.dev, key, { fields: { 'KB Spec Impact': 'No Impact' } }); jira.transition(actors.dev, key, 'Closed');
    });

    check('Jira Editor mock exports original Wiki bytes directly and audit uses the remote standard', () => {
      const reopenedEditor = new JiraEditorMock(path.join(sandbox, 'jira-store.json'));
      reopenedEditor.exportIssue(issueKey, storyFile);
      const bytes = fs.readFileSync(storyFile);
      assert(bytes.subarray(bytes.indexOf(Buffer.from('\n\n')) + 2).equals(Buffer.from(rawDescription)));
      firstAudit = JSON.parse(cli(storyA, ['audit', storyFile, '--issue', issueKey, '--strict-online']));
      assert(firstAudit.check.passed); assert.strictEqual(firstAudit.sync_mode, 'ONLINE_FRESH');
      assert(firstAudit.knowledge.some(entry => entry.id === specId));
      assert(firstAudit.knowledge.some(entry => entry.id === mapId));
    });

    check('clarification invalidates the earlier approval hash and QA must export and audit again', () => {
      const clarified = `${rawDescription}\r\nRejected seat grants preserve account state across API retries.`;
      jira.update(actors.pm, issueKey, { description: clarified });
      jira.exportIssue(issueKey, storyFile);
      cli(storyA, ['verify', storyFile, '--expect', firstAudit.story_sha256], { status: 1 });
      finalAudit = JSON.parse(cli(storyA, ['audit', storyFile, '--issue', issueKey]));
      assert(finalAudit.check.passed); assert.notStrictEqual(finalAudit.story_sha256, firstAudit.story_sha256);
    });

    check('mock Jira blocks unauthorized approval, workflow bypass and edits while approved', () => {
      assert.throws(() => jira.transition(actors.dev, issueKey, 'Story Approved'), /APPROVAL_FORBIDDEN/);
      assert.throws(() => jira.comment(actors.pm, issueKey, finalAudit.approval_line), /APPROVAL_FORBIDDEN/);
      assert.throws(() => jira.transition(actors.dev, issueKey, 'In Progress'), /INVALID_TRANSITION/);
      jira.comment(actors.qa, issueKey, finalAudit.approval_line);
      jira.transition(actors.qa, issueKey, 'Story Approved');
      for (const changes of [{ summary: 'changed' }, { description: 'changed' }, { fields: { Sprint: 'next' } }]) assert.throws(() => jira.update(actors.dev, issueKey, changes), /ISSUE_EDIT_LOCKED/);
      jira.comment(actors.dev, issueKey, 'Ready for development.');
      jira.exportIssue(issueKey, storyFile); jira.exportComments(issueKey, commentsFile);
      cli(storyA, ['verify', storyFile, '--from-comment', commentsFile]);
    });

    check('status and planning-field edits preserve approval, while title and description edits fail verification', () => {
      jira.transition(actors.dev, issueKey, 'In Progress');
      jira.update(actors.dev, issueKey, { fields: { Sprint: 'trial', 'Story Points': 3 } });
      jira.exportIssue(issueKey, storyFile); cli(storyA, ['verify', storyFile, '--from-comment', commentsFile]);
      const issue = jira.get(issueKey), originalTitle = issue.summary, originalBody = issue.description;
      jira.update(actors.dev, issueKey, { summary: `${originalTitle}!` }); jira.exportIssue(issueKey, storyFile);
      cli(storyA, ['verify', storyFile, '--from-comment', commentsFile], { status: 1 });
      jira.update(actors.dev, issueKey, { summary: originalTitle, description: `${originalBody}\r\nRetry idempotency must be tested.` }); jira.exportIssue(issueKey, storyFile);
      cli(storyA, ['verify', storyFile, '--from-comment', commentsFile], { status: 1 });
      jira.transition(actors.dev, issueKey, 'Pending Story QA');
      finalAudit = JSON.parse(cli(storyA, ['audit', storyFile, '--issue', issueKey])); assert(finalAudit.check.passed);
      jira.comment(actors.qa, issueKey, finalAudit.approval_line); jira.transition(actors.qa, issueKey, 'Story Approved');
      jira.exportComments(issueKey, commentsFile); jira.exportIssue(issueKey, storyFile);
      cli(storyA, ['verify', storyFile, '--from-comment', commentsFile]);
      jira.transition(actors.dev, issueKey, 'In Progress');
    });

    check('real code and tests change; dirty re-verification fails and a clean commit refreshes both fingerprints', () => {
      const oldCard = fs.readFileSync(path.join(dataA, 'kb', `${specId}.md`), 'utf8');
      const revisedCard = oldCard.replace('seat allocation invariant', 'atomic-seat-request-safety').replace('Implementation and boundary values live in source and tests.', `API and worker callers must share rejection decisions. Implementation and boundary values live in source and tests. Evidence: JIRA:${issueKey}.`);
      const draft = path.join(workspaceA, '.loop', 'outbox', 'kb', `${specId}.md`); write(draft, revisedCard);
      write(path.join(service, 'grant.js'), code(20)); write(path.join(service, 'grant.test.js'), businessTests(20));
      cli(path.join(service, 'grant.test.js'), [], { cwd: service });
      const before = JSON.parse(cli(kbA, ['get', specId, '--json', '--workspace-root', workspaceA]));
      assert.strictEqual(before.anchor_checks.filter(anchor => anchor.status === 'content_changed').length, 2);
      cli(kbA, ['propose', draft, '--reverify', '--workspace-root', workspaceA, '--json'], { status: 2 });
      assert.strictEqual(fs.readFileSync(draft, 'utf8'), revisedCard);
      commit(service, `Implement ${issueKey}`); sourceCommit = git(service, 'rev-parse', 'HEAD');
      const proposal = JSON.parse(cli(kbA, ['propose', draft, '--reverify', '--workspace-root', workspaceA, '--json']));
      assert.strictEqual(proposal.fingerprint_changes.length, 2);
      assert(fs.readFileSync(draft, 'utf8').includes('verified_at:'));
    });

    check('publish reviewed bytes to the private local origin without modifying active data or source checkouts', () => {
      const draft = path.join(workspaceA, '.loop', 'outbox', 'kb', `${specId}.md`);
      const reviewedSha = crypto.createHash('sha256').update(fs.readFileSync(draft)).digest('hex');
      published = JSON.parse(cli(publishA, [draft, '--no-pr', '--json']));
      assert(published.pushed); assert.strictEqual(published.draft_sha256, reviewedSha);
      assert.strictEqual(published.fingerprint_changes.length, 2);
      assert.strictEqual(git(dataA, 'status', '--porcelain'), ''); assert.strictEqual(git(dataA, 'branch', '--show-current'), 'main');
      assert.strictEqual(git(service, 'status', '--porcelain'), '');
      git(dataA, 'fetch', 'origin');
      assert(git(dataA, 'show', `origin/${published.branch}:kb/${specId}.md`).includes('atomic-seat-request-safety'));
      assert(!fs.readFileSync(path.join(dataB, 'kb', `${specId}.md`), 'utf8').includes('atomic-seat-request-safety'));
    });

    check('review and validate the actual topic branch, merge it, then close the Jira issue with the merged reference', () => {
      const reviewTree = path.join(sandbox, 'owner-review');
      git(dataA, 'worktree', 'add', '--detach', reviewTree, `origin/${published.branch}`);
      try { assert(JSON.parse(cli(path.join(reviewTree, 'scripts', 'validate-data.js'), ['--strict-owners'], { cwd: reviewTree })).passed); }
      finally { git(dataA, 'worktree', 'remove', reviewTree); }
      jira.update(actors.dev, issueKey, { fields: { 'KB Spec Impact': 'Spec Updated' } });
      assert.throws(() => jira.transition(actors.dev, issueKey, 'Closed'), /SPEC_PR_REQUIRED/);
      git(dataA, 'merge', '--no-ff', `origin/${published.branch}`, '-m', `Owner review: ${issueKey} Spec Delta`);
      git(dataA, 'push', 'origin', 'main'); mergedCommit = git(dataA, 'rev-parse', 'HEAD');
      jira.update(actors.dev, issueKey, { fields: { 'KB Spec PR': `LOCAL-REVIEW:${mergedCommit}` } });
      jira.transition(actors.dev, issueKey, 'Closed');
      assert.strictEqual(jira.get(issueKey).status, 'Closed');
    });

    check('a second member syncs the merged spec and source, finds the new knowledge and verifies all file anchors', () => {
      assert.notStrictEqual(git(dataB, 'rev-parse', 'HEAD'), mergedCommit);
      cli(kbB, ['search', 'atomic-seat-request-safety', '--no-sync', '--json'], { home: homeB, cwd: workspaceB });
      assert(!fs.readFileSync(path.join(dataB, 'kb', `${specId}.md`), 'utf8').includes('atomic-seat-request-safety'));
      const hits = JSON.parse(cli(kbB, ['search', 'atomic-seat-request-safety', '--sync', '--json'], { home: homeB, cwd: workspaceB }));
      assert(hits.results.some(entry => entry.id === specId));
      assert.strictEqual(git(dataB, 'rev-parse', 'HEAD'), mergedCommit);
      git(path.join(workspaceB, 'repos', 'demo-service'), 'pull', '--ff-only');
      const entry = JSON.parse(cli(kbB, ['get', specId, '--json', '--workspace-root', workspaceB], { home: homeB, cwd: workspaceB }));
      assert(entry.anchor_checks.filter(anchor => !['external_ref'].includes(anchor.status)).every(anchor => anchor.status === 'verified'));
      const bStory = path.join(homeB, '.harbor', 'drafts', 'stories', `${issueKey}.md`);
      const bComments = path.join(homeB, '.harbor', 'drafts', 'stories', `${issueKey}-comments.txt`);
      jira.exportIssue(issueKey, bStory); jira.exportComments(issueKey, bComments);
      cli(storyB, ['verify', bStory, '--from-comment', bComments], { home: homeB, cwd: workspaceB });
    });

    check('cache deletion preserves drafts and private binding; a missing configured data repository fails closed', () => {
      const originalDraft = path.join(workspaceA, '.loop', 'outbox', 'kb', `${specId}.md`);
      fs.rmSync(path.join(homeA, '.cache'), { recursive: true, force: true }); assert(fs.existsSync(originalDraft));
      assert.strictEqual(JSON.parse(cli(storyA, ['standard'])).kb_source, 'WORKSPACE_PTR');
      cli(publishA, ['--kb-root', engine, originalDraft], { status: 2 });
      cli(storyA, ['--kb-root', engine, 'audit', storyFile], { status: 2 });
      const moved = `${dataA}-moved`; fs.renameSync(dataA, moved);
      try {
        cli(kbA, ['map', '--json'], { status: 2 });
        cli(storyA, ['verify', storyFile, '--from-comment', commentsFile], { status: 2 });
        cli(publishA, [originalDraft], { status: 2 });
      } finally { fs.renameSync(moved, dataA); }
    });

    report.passed = true;
    report.issue = { key: issueKey, status: jira.get(issueKey).status, story_sha256: finalAudit.story_sha256, standards_sha: finalAudit.standards_sha, approvals: jira.get(issueKey).comments.filter(comment => comment.body.startsWith('[story-guard] APPROVED')).length };
    report.gitEvidence = { sourceCommit, publishedBranch: published.branch, reviewedDraftSha256: published.draft_sha256, mergedCommit, secondMemberHead: git(dataB, 'rev-parse', 'HEAD') };
    report.jiraEvents = jira.events;
    if (reportFile) write(path.resolve(reportFile), `${JSON.stringify(report, null, 2)}\n`);
    console.log(`Jira mock E2E: all ${report.checks.length} scenario groups passed.`);
    return report;
  } finally { fs.rmSync(sandbox, { recursive: true, force: true }); }
}

module.exports = { run };
if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    if (args.length && (args.length !== 2 || args[0] !== '--report')) throw new Error('Usage: verify_jira_mock_e2e.js [--report file]');
    run({ reportFile: args[1] });
  } catch (error) { console.error(error); process.exitCode = 1; }
}
