#!/usr/bin/env node
'use strict';
const fs=require('fs'),path=require('path');
const SECRET_CHECKS = [
  [new RegExp('\\bgh' + '[pousr]_[A-Za-z0-9]{20,}'), 'GitHub token'],
  [new RegExp('\\bAK' + 'IA[0-9A-Z]{16}\\b'), 'AWS access key'],
  [new RegExp('-----BEGIN ' + '[A-Z ]*PRIVATE KEY-----'), 'private key'],
  [new RegExp('\\bxox' + '[abprs]-[A-Za-z0-9-]{10,}'), 'Slack token'],
  [new RegExp('\\bsk-' + '[A-Za-z0-9_-]{20,}'), 'API key'],
  [/\bBearer\s+[A-Za-z0-9._~+/-]{20,}/, 'Bearer token'],
  [/(?<![A-Za-z0-9])(\/Users\/[A-Za-z0-9._-]+\/|\/home\/[A-Za-z0-9._-]+\/|[A-Za-z]:\\Users\\[A-Za-z0-9._-]+\\)/, 'local machine user path'],
];


function stripInlineComment(line) {
  let inQ = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === inQ) inQ = null;
    } else if (ch === '"' || ch === "'") {
      inQ = ch;
    } else if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i).trimEnd();
    }
  }
  return line.trimEnd();
}

function unquote(val) {
  const s = val.trim();
  if (s.length >= 2 && s[0] === s[s.length - 1] && (s[0] === '"' || s[0] === "'")) {
    const inner = s.slice(1, -1);
    return s[0] === '"' ? inner.replace(/\\"/g, '"').replace(/\\\\/g, '\\') : inner;
  }
  return s;
}

function parseInlineList(text) {
  const inner = text.trim().slice(1, -1).trim();
  if (!inner) return [];
  const items = [];
  let buf = '';
  let inQ = null;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (inQ) {
      if (ch === inQ) inQ = null;
      else buf += ch;
    } else if (ch === '"' || ch === "'") {
      inQ = ch;
    } else if (ch === ',') {
      const s = buf.trim();
      if (s) items.push(s);
      buf = '';
    } else {
      buf += ch;
    }
  }
  const tail = buf.trim();
  if (tail) items.push(tail);
  return items;
}

function parseMarkdownEntry(rawText) {
  const text = String(rawText || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (!text.startsWith('---\n')) return { meta: {}, body: text };
  let end = text.indexOf('\n---\n', 4);
  if (end === -1) {
    if (text.endsWith('\n---')) end = text.length - 4;
    else return { meta: {}, body: text };
  }
  const fmBlock = text.slice(4, end);
  const body = end + 5 <= text.length ? text.slice(end + 5) : '';
  const meta = Object.create(null);
  let curListKey = null;
  for (const rawLine of fmBlock.split('\n')) {
    const line = stripInlineComment(rawLine);
    if (!line.trim()) continue;
    if (curListKey && /^\s*-\s+/.test(line)) {
      const item = unquote(line.replace(/^\s*-\s+/, ''));
      if (item) meta[curListKey].push(item);
      continue;
    }
    curListKey = null;
    const m = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1];
    const rest = m[2].trim();
    if (!rest) {
      meta[key] = [];
      curListKey = key;
    } else if (rest.startsWith('[') && rest.endsWith(']')) {
      meta[key] = parseInlineList(rest);
    } else {
      meta[key] = unquote(rest);
    }
  }
  return { meta, body: body.trim() };
}

const VALIDATOR_VERSION='3.0.0';
function validate(root=path.resolve(__dirname,'..'),args=process.argv.slice(2)){
 const errors=[],warnings=[];
 const owner=path.join(root,'CODEOWNERS');
 if(!fs.existsSync(owner)) errors.push('Missing CODEOWNERS');
 else if(fs.readFileSync(owner,'utf8').includes('@your-org/'))(args.includes('--strict-owners')||process.env.KB_STRICT_OWNERS==='1'?errors:warnings).push('Replace CODEOWNERS @your-org/ placeholders');
 const walk=dir=>{if(!fs.existsSync(dir)){errors.push('Missing data directory');return;}for(const d of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,d.name);if(d.isDirectory())walk(p);else if(d.isFile()&&p.endsWith('.md')){
 const raw=fs.readFileSync(p,'utf8'),{meta,body}=parseMarkdownEntry(raw), rel=path.relative(root,p).replace(/\\/g,'/');
 for(const [re,label]of SECRET_CHECKS)if(re.test(raw))errors.push(rel+': '+label);
 if(!body.trim())errors.push(rel+': missing body');
 if(rel.startsWith('kb/')){
 if(!/^kb\/[a-z0-9][a-z0-9-]{0,62}\/(map|spec|redline|adr|gotcha|runbook|postmortem)\/[a-z0-9][a-z0-9-]{0,62}\.md$/.test(rel))errors.push('Invalid entry path');
 for(const key of ['title','summary'])if(typeof meta[key]!=='string'||!meta[key].trim())errors.push(rel+': missing '+key);
 for(const key of ['sources','triggers'])if(!Array.isArray(meta[key])||meta[key].filter(x=>String(x).trim()).length<(key==='triggers'?2:1))errors.push(rel+': missing '+key);
 for(const key of ['expires','verified_at'])if(meta[key]&&(!/^\d{4}-\d{2}-\d{2}$/.test(meta[key])||Number.isNaN(Date.parse(meta[key]))))errors.push(rel+': invalid date');
 if(args.includes('--stale')){
 if(meta.disputed||meta.expires&&meta.expires<new Date().toISOString().slice(0,10)||meta.verified_at&&Date.now()-Date.parse(meta.verified_at)>90*86400000||/\/(map|spec)\//.test(rel)&&!meta.verified_at)errors.push(rel+': stale or disputed; owner review needed');
 }
 }else if(!meta.id||!meta.version||!Array.isArray(meta.required_sections)||!meta.required_sections.length||!Array.isArray(meta.required_case_prefixes)||!meta.required_case_prefixes.length||!(Number(meta.min_examples_rows)>=1))errors.push(rel+': invalid standard');
 }}};
 walk(path.join(root,'kb'));walk(path.join(root,'standards'));
 console.log(JSON.stringify({version:VALIDATOR_VERSION,passed:!errors.length,errors,warnings},null,2));return errors.length?1:0;
}
if(require.main===module)process.exitCode=validate();
module.exports={validate,VALIDATOR_VERSION};
