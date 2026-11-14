'use strict';

const fs = require('fs');
const path = require('path');

// Test adapter for the Jira Editor contract. It does not call Jira or implement
// story hashes: approval/content verification stays in the real story.js CLI.
class JiraEditorMock {
  constructor(storeFile) {
    this.storeFile = storeFile;
    this.issues = new Map();
    this.events = [];
    this.revision = 0;
    if (fs.existsSync(storeFile)) {
      const saved = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
      this.issues = new Map(saved.issues.map(issue => [issue.key, issue]));
      this.events = saved.events;
      this.revision = saved.events.length;
    }
  }

  save(action, actor, issue) {
    issue.updated = `mock-revision-${++this.revision}`;
    this.events.push({ action, actor: actor.name, issue: issue.key, status: issue.status });
    fs.mkdirSync(path.dirname(this.storeFile), { recursive: true });
    fs.writeFileSync(this.storeFile, JSON.stringify({ issues: [...this.issues.values()], events: this.events }, null, 2));
  }

  get(key) {
    const issue = this.issues.get(key);
    if (!issue) throw new Error('ISSUE_NOT_FOUND');
    return issue;
  }

  create(actor, { summary, description, qaRoute }) {
    if (actor.role !== 'pm') throw new Error('CREATE_FORBIDDEN');
    if (!['REQUIRED', 'STANDARD'].includes(qaRoute)) throw new Error('INVALID_QA_ROUTE');
    const key = `BILL-${this.issues.size + 1}`;
    const issue = { key, summary, description, comments: [], fields: {}, status: qaRoute === 'REQUIRED' ? 'Pending Story QA' : 'Ready' };
    this.issues.set(key, issue);
    this.save('create', actor, issue);
    return key;
  }

  update(actor, key, changes) {
    const issue = this.get(key);
    if (['Story Approved', 'Closed'].includes(issue.status)) throw new Error('ISSUE_EDIT_LOCKED');
    if (!['pm', 'qa', 'dev'].includes(actor.role)) throw new Error('EDIT_FORBIDDEN');
    if (Object.keys(changes).some(key => !['summary', 'description', 'fields'].includes(key))) throw new Error('INVALID_EDIT_FIELD');
    if (changes.summary !== undefined) issue.summary = changes.summary;
    if (changes.description !== undefined) issue.description = changes.description;
    if (changes.fields) Object.assign(issue.fields, changes.fields);
    this.save('update', actor, issue);
  }

  comment(actor, key, body) {
    const issue = this.get(key);
    if (body.startsWith('[story-guard] APPROVED') && actor.role !== 'qa') throw new Error('APPROVAL_FORBIDDEN');
    issue.comments.push({ author: actor.name, body });
    this.save('comment', actor, issue);
  }

  transition(actor, key, target) {
    const issue = this.get(key);
    if (target === 'Story Approved') {
      if (actor.role !== 'qa') throw new Error('APPROVAL_FORBIDDEN');
      if (issue.status !== 'Pending Story QA') throw new Error('INVALID_TRANSITION');
      if (!issue.comments.some(comment => comment.body.startsWith('[story-guard] APPROVED'))) throw new Error('APPROVAL_COMMENT_REQUIRED');
    } else if (target === 'In Progress') {
      if (actor.role !== 'dev' || !['Story Approved', 'Ready'].includes(issue.status)) throw new Error('INVALID_TRANSITION');
    } else if (target === 'Pending Story QA') {
      if (issue.status !== 'In Progress' || !['dev', 'qa'].includes(actor.role)) throw new Error('INVALID_TRANSITION');
    } else if (target === 'Closed') {
      if (issue.status !== 'In Progress' || !['dev', 'qa'].includes(actor.role)) throw new Error('INVALID_TRANSITION');
      if (!['No Impact', 'Spec Updated'].includes(issue.fields['KB Spec Impact'])) throw new Error('SPEC_IMPACT_REQUIRED');
      if (issue.fields['KB Spec Impact'] === 'Spec Updated' && !issue.fields['KB Spec PR']) throw new Error('SPEC_PR_REQUIRED');
    } else throw new Error('INVALID_TRANSITION');
    issue.status = target;
    this.save('transition', actor, issue);
  }

  exportIssue(key, file) {
    const issue = this.get(key);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Preserve raw description bytes and line endings; never re-render Wiki markup.
    fs.writeFileSync(file, `Issue: ${key}\nUpdated: ${issue.updated}\nTitle: ${issue.summary}\n\n${issue.description}`, 'utf8');
    return file;
  }

  exportComments(key, file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, this.get(key).comments.map(comment => comment.body).join('\n'), 'utf8');
    return file;
  }
}

module.exports = { JiraEditorMock };
