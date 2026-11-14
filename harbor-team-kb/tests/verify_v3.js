'use strict';
const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert'),crypto=require('crypto');
const {spawnSync}=require('child_process');
const root=path.resolve(__dirname,'..'),kb=path.join(root,'skills/team-kb/scripts/kb.js'),story=path.join(root,'skills/story-guard/scripts/story.js'),pub=path.join(root,'skills/team-kb-publish/scripts/publish.js'),plug=path.join(root,'plug.js');
function run(){
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'harbor-v3-suite-')),home=path.join(tmp,'home');fs.mkdirSync(home);
 const env={...process.env,HOME:home,HARBOR_KB_CACHE_DIR:path.join(tmp,'cache'),HARBOR_KB_ROOT:'',GIT_CONFIG_NOSYSTEM:'1',GIT_TERMINAL_PROMPT:'0'};
 const node=(script,args=[],status=0,opts={})=>{const r=spawnSync(process.execPath,[script,...args],{cwd:tmp,env,encoding:'utf8',timeout:30000,...opts});assert.strictEqual(r.status,status,r.stderr+'\n'+r.stdout);return r.stdout;};
 const git=(dir,...args)=>{const r=spawnSync('git',['-C',dir,...args],{env,encoding:'utf8',timeout:10000});assert.strictEqual(r.status,0,r.stderr);return r.stdout.trim();};
 const write=(file,body)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,body);};
 let count=0;const test=(name,fn)=>{fn();count++;console.log('  ✓ V3 '+name);};
 try{
 const data=path.join(tmp,'data');node(plug,['init-data-repo',data]);
 const card=(id,trigger='hard rule')=>write(path.join(data,'kb',id+'.md'),`---\ntitle: "Example business invariant"\nsummary: "Rejected requests never mutate persisted state."\ntriggers: ["${trigger}", "contract invariant"]\nsources: ["JIRA:DEMO-1"]\n---\n\n## Rule\nRejected requests never mutate persisted state.\n`);
 card('billing/spec/reject-write');card('other/redline/limit','global cap');card('billing/map/service-map','repo topology');
 const draft=path.join(tmp,'story.md');const original=`Issue: BILL-402\nUpdated: before\nTitle: Add seats\n\n## Story Statement\nAs an admin I add seats.\n## Scope & Architecture Mapping\nDomain: billing\nAffected Repos: demo-service\nbilling/map/service-map\n## Spec Delta\nNONE\n## Acceptance Criteria & Concrete Examples\n| Case | Input | Output |\n| --- | --- | --- |\n| Normal: add | 2 | 2 |\n| Boundary: zero | 0 | 0 |\n## Out of Scope\nTaxes.\n`;write(draft,original);
 test('data validator strict owners and non-destructive upgrades',()=>{
  node(path.join(data,'scripts/validate-data.js'),['--strict-owners'],1);write(path.join(data,'CODEOWNERS'),'* @demo/owners\n');
  const standard=fs.readFileSync(path.join(data,'standards/user-story.md'),'utf8');node(plug,['init-data-repo',data,'--upgrade-scripts']);assert.strictEqual(fs.readFileSync(path.join(data,'CODEOWNERS'),'utf8'),'* @demo/owners\n');assert.strictEqual(fs.readFileSync(path.join(data,'standards/user-story.md'),'utf8'),standard);node(path.join(data,'scripts/validate-data.js'),['--strict-owners']);
 });
 test('three resolvers and secret scanners agree for configured/legacy/fail-closed paths',()=>{
  const modules=[kb,pub,story].map(require);const before={HOME:process.env.HOME,HARBOR_KB_ROOT:process.env.HARBOR_KB_ROOT};
  try{process.env.HOME=home;delete process.env.HARBOR_KB_ROOT;
   for(const pointer of [data,path.join(tmp,'missing')]){
    const values=modules.map(m=>{try{return m.resolveKbRoot(pointer);}catch{return 'ERROR';}});assert.deepStrictEqual(values[0],values[1]);assert.deepStrictEqual(values[1],values[2]);
   }
   assert.deepStrictEqual(modules[0].SECRET_CHECKS.map(x=>x[0].source),modules[1].SECRET_CHECKS.map(x=>x[0].source));assert.deepStrictEqual(modules[1].SECRET_CHECKS.map(x=>x[0].source),modules[2].SECRET_CHECKS.map(x=>x[0].source));
  }finally{for(const [k,v]of Object.entries(before))if(v===undefined)delete process.env[k];else process.env[k]=v;}
  node(plug,['install','--data-repo',data,'--mode','copy']);
  for(const [file,args]of [[kb,['stats','--json']],[story,['standard']],[pub,['missing']]]){const saved=path.join(tmp,'saved');fs.renameSync(data,saved);node(file,args,2);fs.renameSync(saved,data);}
  node(pub,['--kb-root',root,'missing'],2);node(story,['--kb-root',root,'audit',draft],2);
  for(const skill of ['team-kb','team-kb-publish','story-guard'])assert(fs.existsSync(path.join(home,'.copilot/skills',skill,'SKILL.md')));
 });
 test('Story classification, cross-domain references, Wiki, Chinese and routing',()=>{
  const check=text=>{write(draft,text);return JSON.parse(node(story,['check',draft,'--json'],text.includes('missing/ref')?1:0));};
  assert.strictEqual(check(original).qa_route,'STANDARD');assert.strictEqual(check(original.replace('Taxes.','global cap')).qa_route,'REQUIRED');
  write(draft,original.replace('NONE','other/spec/unknown'));const missing=JSON.parse(node(story,['check',draft],1));assert(missing.errors.some(x=>x.includes('Unknown KB')));
  write(draft,original.replace('Domain: billing',''));assert.strictEqual(JSON.parse(node(story,['check',draft],1)).qa_route,'REQUIRED');
  write(draft,original.replace('Boundary: zero','Other: zero'));node(story,['check',draft],1);
  write(draft,original.replace('demo-service','evil<instruction>'));const bad=JSON.parse(node(story,['check',draft],1));assert(!JSON.stringify(bad.errors).includes('<instruction>'));
  assert(check(original.replace(/^## /gm,'h2. ')).passed);
  assert(check(original.replace('Normal:','正常:').replace('Boundary:','边界:')).passed);
  write(draft,original);
 });
 test('fixed hash, latest approval and metadata invariance',()=>{
  const api=require(story),parsed=api.readStory(draft);assert.strictEqual(parsed.story_sha256,'d183332482b4f670b9adc65670797cfeec7b2508e5cf7202c5be0047c058da52');
  const audit=JSON.parse(node(story,['audit',draft,'--issue','BILL-402']));assert.strictEqual(audit.sync_mode,'LOCAL_ONLY');assert(audit.standard.includes('required_sections:'));assert(audit.knowledge.some(e=>e.id==='billing/spec/reject-write'));
  const comments=path.join(tmp,'comments');write(comments,audit.approval_line);node(story,['verify',draft,'--from-comment',comments]);
  write(draft,original.replace('Updated: before','Updated: later'));node(story,['verify',draft,'--from-comment',comments]);
  write(draft,original.replace('Add seats','Add seats!'));node(story,['verify',draft,'--from-comment',comments],1);
  write(draft,original);write(comments,audit.approval_line+'\n'+audit.approval_line.replace(audit.story_sha256,'0'.repeat(64)));node(story,['verify',draft,'--from-comment',comments],1);
  node(story,['audit',draft,'--strict-online'],3);
 });
 test('oversize rejection, check defects retained, nonce envelope isolation',()=>{
  write(draft,original.replace('Title: Add seats','Missing title'));assert(!JSON.parse(node(story,['check',draft],1)).passed);
  write(draft,'x'.repeat(65537));node(story,['check',draft],2);
  write(draft,original.replace('Boundary:','Unknown:')+'\nUNTRUSTED_STORY_PAYLOAD_END\n');const a=JSON.parse(node(story,['audit',draft]));assert(!a.check.passed);assert(a.security_warnings.length);assert(!a.payload.includes('\nUNTRUSTED_STORY_PAYLOAD_END\n'));assert.strictEqual(a.story_sha256,require(story).readStory(draft).story_sha256);write(draft,original);
 });
 test('official snapshot ignores dirty local standards and supports online/TTL/offline',()=>{
  git(data,'config','user.name','Test');git(data,'config','user.email','test@example.com');git(data,'add','.');git(data,'commit','-m','initial');git(data,'branch','-M','main');
  const remote=path.join(tmp,'remote.git');git(tmp,'init','--bare',remote);git(data,'remote','add','origin',remote);git(data,'push','-u','origin','main');
  write(path.join(data,'standards/user-story.md'),'untrusted broken worktree');
  const a=JSON.parse(node(story,['audit',draft,'--strict-online']));assert(a.check.passed);assert.strictEqual(a.sync_mode,'ONLINE_FRESH');assert.strictEqual(JSON.parse(node(story,['audit',draft])).sync_mode,'TTL_CACHED');
  fs.renameSync(remote,remote+'.offline');assert.strictEqual(JSON.parse(node(story,['audit',draft,'--ttl','0'])).sync_mode,'OFFLINE_FALLBACK');node(story,['audit',draft,'--strict-online'],3);fs.renameSync(remote+'.offline',remote);
  git(data,'checkout','--','standards/user-story.md');
 });
 test('map budgets, anchor fingerprint normalization and explicit reverify',()=>{
  const ws=path.join(tmp,'repos/demo-service');fs.mkdirSync(ws,{recursive:true});git(ws,'init');git(ws,'config','user.name','Test');git(ws,'config','user.email','test@example.com');git(ws,'remote','add','origin','https://example.com/demo-service.git');
  write(path.join(ws,'code.js'),'function main() {}\n');git(ws,'add','.');git(ws,'commit','-m','source');
  const args=['propose','--id','billing/spec/pinned','--title','Pinned invariant','--summary','State remains unchanged on rejection','--triggers','rejection,state','--sources','demo-service:code.js#main','--body','Rejected requests must never mutate state.','--json','--force','--workspace-root',ws];
  const first=JSON.parse(node(kb,args));assert(first.draft.startsWith(path.join(home,'.harbor/drafts/kb')));fs.copyFileSync(first.draft,path.join(data,'kb/billing/spec/pinned.md'));
  const pin=fs.readFileSync(first.draft,'utf8').match(/@[a-f0-9]{8}/)[0];
  write(path.join(ws,'code.js'),'function main() {}\r\n');let get=JSON.parse(node(kb,['get','billing/spec/pinned','--json','--workspace-root',ws]));assert.strictEqual(get.anchor_checks[0].status,'verified');
  write(path.join(ws,'code.js'),'function main() { return 1; }\n');get=JSON.parse(node(kb,['get','billing/spec/pinned','--json','--workspace-root',ws]));assert.strictEqual(get.anchor_checks[0].status,'content_changed');
  assert(fs.readFileSync(JSON.parse(node(kb,args)).draft,'utf8').includes(pin));node(kb,[...args,'--reverify'],2);
  git(ws,'add','.');git(ws,'commit','-m','change');const fresh=JSON.parse(node(kb,[...args,'--reverify']));assert(!fs.readFileSync(fresh.draft,'utf8').includes(pin));assert(fs.readFileSync(fresh.draft,'utf8').includes('verified_at:'));
  assert(node(kb,['map']).length<=3200);assert(JSON.parse(node(kb,['map','--auto','--json','--workspace-root',ws])).domains.length>0);
  node(kb,['drift','--exit-code','--workspace-root',ws],1);fs.unlinkSync(path.join(ws,'code.js'));node(kb,['drift','--exit-code','--workspace-root',ws],0);
 });
 test('copied publisher validates and publishes private data without sibling skills',()=>{
  const isolated=path.join(tmp,'isolated-publish');fs.mkdirSync(isolated);
  const copied=path.join(home,'.copilot/skills/team-kb-publish/scripts/publish.js');
  fs.copyFileSync(copied,path.join(isolated,'publish.js'));
  const file=path.join(home,'.harbor/drafts/kb/billing/gotcha/private-fix.md');
  write(file,'---\ntitle: "Private verified fix"\nsummary: "Use verified timeouts when processing rejected requests."\ntriggers: ["timeout fix", "request handling"]\nsources: ["JIRA:BILL-402"]\n---\n\nUse the verified timeout and preserve request state.\n');
  const result=JSON.parse(node(path.join(isolated,'publish.js'),['billing/gotcha/private-fix','--no-push','--json']));assert(!result.pushed);assert(fs.existsSync(file));assert.strictEqual(result.kb_source,'USER_DATA_PTR');
 });
 test('subdirectory Git snapshot, no prior remote baseline, and all seven anchor states',()=>{
  const parent=path.join(tmp,'parent');fs.mkdirSync(parent);git(parent,'init');git(parent,'config','user.name','Test');git(parent,'config','user.email','test@example.com');
  const nested=path.join(parent,'nested');fs.cpSync(data,nested,{recursive:true,filter:p=>path.basename(p)!=='.git'});git(parent,'add','.');git(parent,'commit','-m','nested data');
  assert(JSON.parse(node(story,['--kb-root',nested,'audit',draft])).check.passed);
  const unseeded=path.join(tmp,'unseeded');node(plug,['init-data-repo',unseeded]);git(unseeded,'remote','add','origin',path.join(tmp,'absent.git'));node(story,['--kb-root',unseeded,'audit',draft],3);
  const engine=require(path.join(root,'skills/team-kb/scripts/kb_index.js'));
  const ws=path.join(tmp,'anchor-states'),file=path.join(ws,'repos','demo','file.js');write(file,'function keep() {}\n');
  assert.strictEqual(engine.anchorInfo(ws,'JIRA:DEMO-1').status,'external_ref');
  assert.strictEqual(engine.anchorInfo(ws,'absent:file.js').status,'unverified_repo_absent');
  assert.strictEqual(engine.anchorInfo(ws,'demo:missing.js').status,'file_missing');
  assert.strictEqual(engine.anchorInfo(ws,'demo:file.js#gone').status,'symbol_missing');
  assert.strictEqual(engine.anchorInfo(ws,'demo:file.js').status,'present_unpinned');
  const pin=engine.anchorInfo(ws,'demo:file.js').fingerprint;
  assert.strictEqual(engine.anchorInfo(ws,'demo:file.js@'+pin).status,'verified');
  assert.strictEqual(engine.anchorInfo(ws,'demo:file.js@00000000').status,'content_changed');
  const wt=path.join(tmp,'named-worktree');git(parent,'remote','add','origin','https://example.com/real-project.git');git(parent,'worktree','add','-b','feature',wt);
  assert.strictEqual(engine.detectRepoNames(wt)[0],'real-project');
 });
 test('independent holdout retrieval Recall@3 >= 95%, negative FPR zero',()=>{
  const engine=require(path.join(root,'skills/team-kb/scripts/kb_index.js'));
  const {index}=engine.ensureIndex(root),queries=JSON.parse(fs.readFileSync(path.join(__dirname,'holdout_queries.json'),'utf8'));
  let hits=0;for(const q of queries){const results=engine.rankSearch(index,q.query,new Date().toISOString().slice(0,10),{limit:3});if(results.some(r=>r.id===q.expected))hits++;else console.error('Holdout missed',q.query,results.map(r=>r.id));}
  assert(hits/queries.length>=0.95);
  for(const q of JSON.parse(fs.readFileSync(path.join(__dirname,'golden_queries.json'),'utf8')).filter(q=>q.expect_empty))assert.strictEqual(engine.rankSearch(index,q.query,'2026-11-13',{limit:3}).length,0);
 });
 test('copied public engine guards survive cache deletion and all explicit pointer sources',()=>{
  const publicRoot=path.join(tmp,'public-engine');fs.cpSync(root,publicRoot,{recursive:true});
  const guardHome=path.join(tmp,'guard-home'),guardWs=path.join(tmp,'guard-ws');fs.mkdirSync(guardHome);fs.mkdirSync(guardWs);
  const copied=path.join(tmp,'guard-copy');fs.mkdirSync(copied);
  const audit=path.join(copied,'story.js'),publish=path.join(copied,'publish.js');fs.copyFileSync(story,audit);fs.copyFileSync(pub,publish);
  const guardEnv={...env,HOME:guardHome,HARBOR_KB_CACHE_DIR:path.join(tmp,'guard-cache')};
  for(const source of ['CLI_FLAG','ENV_VAR','USER_DATA_PTR','WORKSPACE_PTR']){
    const configEnv={...guardEnv};let flags=[];
    const userPtr=path.join(guardHome,'.harbor','kb_data_root'),wsPtr=path.join(guardWs,'.loop','outbox','kb','.kb_root');
    fs.rmSync(path.dirname(userPtr),{recursive:true,force:true});fs.rmSync(path.join(guardWs,'.loop'),{recursive:true,force:true});
    if(source==='CLI_FLAG')flags=['--kb-root',publicRoot];
    if(source==='ENV_VAR')configEnv.HARBOR_KB_ROOT=publicRoot;
    if(source==='USER_DATA_PTR')write(userPtr,publicRoot);
    if(source==='WORKSPACE_PTR')write(wsPtr,publicRoot);
    for(const [script,args]of [[audit,['audit',draft]],[publish,['missing.md']]]){
      const result=spawnSync(process.execPath,[script,...flags,...args],{cwd:guardWs,env:configEnv,encoding:'utf8',timeout:10000});
      assert.strictEqual(result.status,2,result.stderr);assert(result.stderr.includes('Bind a private data repository'),result.stderr);
    }
  }
  node(audit,['--kb-root',publicRoot,'audit',draft,'--allow-demo-fallback'],0,{cwd:guardWs,env:guardEnv});
 });
 test('home expansion agrees across all three CLIs without cached engine identity',()=>{
  const tildeHome=path.join(tmp,'tilde-home');fs.mkdirSync(path.join(tildeHome,'kb'),{recursive:true});fs.mkdirSync(path.join(tildeHome,'child','kb'),{recursive:true});
  for(const input of ['~','~/child','~'+String.fromCharCode(92)+'child']){
    const results=[kb,pub,story].map(file=>{
      const r=spawnSync(process.execPath,['-e','console.log(JSON.stringify(require(process.argv[1]).resolveKbRoot(process.argv[2])))',file,input],{cwd:tmp,env:{...env,HOME:tildeHome},encoding:'utf8',timeout:10000});
      assert.strictEqual(r.status,0,JSON.stringify({input,file,home:tildeHome})+r.stderr);return JSON.parse(r.stdout);
    });assert.deepStrictEqual(results[0],results[1]);assert.deepStrictEqual(results[1],results[2]);
  }
 });
 test('map auto follows origin from nested worktree paths',()=>{
  const parent=path.join(tmp,'parent'),wt=path.join(tmp,'named-worktree'),nested=path.join(wt,'src','nested');fs.mkdirSync(nested,{recursive:true});
  const engine=require(path.join(root,'skills/team-kb/scripts/kb_index.js'));assert.strictEqual(engine.detectRepoNames(nested)[0],'real-project');
  const sameName=path.join(wt,'real-project');fs.mkdirSync(sameName,{recursive:true});assert.strictEqual(engine.detectRepoNames(sameName)[0],'real-project');
  const map=path.join(data,'kb','navigation','map','actual-origin.md');
  write(map,'---\ntitle: "Real project repository map"\nsummary: "The real project owns the request processing boundary."\ntriggers: ["real project", "request boundary"]\nsources: ["real-project:src/"]\n---\n\nThe real-project repository handles request processing.\n');
  const result=JSON.parse(node(kb,['map','--auto','--json','--no-sync'],0,{cwd:nested}));assert(result.domains.some(d=>d.domain==='navigation'));
 });
 test('positional reverify updates the existing draft and validation failures preserve it',()=>{
  const ws=path.join(tmp,'repos/demo-service'),file=path.join(ws,'code.js');write(file,'function main() { return 2; }\n');git(ws,'add','.');git(ws,'commit','-m','second source change');
  const existing=path.join(home,'.harbor/drafts/kb/billing/spec/pinned.md');
  const result=JSON.parse(node(kb,['propose',existing,'--reverify','--workspace-root',ws,'--json']));assert.strictEqual(result.draft,existing);assert(result.fingerprint_changes.length);
  const broken=path.join(home,'.harbor/drafts/kb/billing/spec/broken.md');write(broken,'---\ntitle: x\nsummary: x\ntriggers: ["first", "second"]\nsources: ["JIRA:BILL-402"]\n---\n\nx\n');const before=fs.readFileSync(broken);
  node(kb,['propose',broken,'--reverify'],2);assert.deepStrictEqual(fs.readFileSync(broken),before);
 });
 test('copied skills remain independent, budgets and static safety',()=>{
  for(const name of ['team-kb','team-kb-publish','story-guard']){
   const dir=path.join(root,'skills',name),skill=fs.readFileSync(path.join(dir,'SKILL.md'),'utf8');assert(skill.length<4096);
   for(const file of fs.readdirSync(path.join(dir,'scripts'))){const content=fs.readFileSync(path.join(dir,'scripts',file),'utf8');assert(Buffer.byteLength(content)<=57344);assert(skill.includes(file));assert(!/require\(['"]\.\.\//.test(content));}
  }
  const copied=path.join(home,'.copilot/skills/story-guard/scripts/story.js');node(copied,['check',draft]);
 });
 console.log('Suite 12: '+count+' scenario groups passed.');
 }finally{fs.rmSync(tmp,{recursive:true,force:true});}
}
module.exports={run};if(require.main===module)run();
