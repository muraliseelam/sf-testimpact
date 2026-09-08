import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join, relative, resolve as resolvePath } from 'node:path';
const LIB='file:///C:/EB1A/repos/sf-testimpact/lib';
const { loadGraph, saveGraph, hashContents, buildGraph, currentGenerator, graphPath } = await import(`${LIB}/graph/store.js`);
const { planReindex, filesToExtract, mergeFacts, mergeFiles } = await import(`${LIB}/graph/incremental.js`);
const { extractFile, isModelledPath } = await import(`${LIB}/extract/index.js`);
const { resolve: resolveGraph } = await import(`${LIB}/resolve/resolver.js`);
const { serializeGraph } = await import(`${LIB}/graph/serialize.js`);

const repo = process.argv[2];
const at = (p) => resolvePath(repo, p);
// Same capability set as the shipped command: without writeBytes/rename this profiles the
// plain-JSON fallback, and on a project whose graph exceeds 8 MB it cannot even load one.
const fs = { readFile:(p)=>readFileSync(at(p),'utf8'), readBytes:(p)=>readFileSync(at(p)),
             writeFile:(p,c)=>writeFileSync(at(p),c,'utf8'), writeBytes:(p,b)=>writeFileSync(at(p),b),
             rename:(a,b)=>renameSync(at(a),at(b)), remove:(p)=>rmSync(at(p),{force:true}),
             mkdirp:(p)=>mkdirSync(at(p),{recursive:true}), exists:(p)=>existsSync(at(p)) };
const project = { root: repo, sourcePaths:['force-app'], namespace:'c' };
const skip = new Set(['node_modules','.git','.sf-testimpact','.sfdx','.sf']);
const walk = () => { const out=[]; const visit=(d)=>{ let es; try{es=readdirSync(d);}catch{return;}
  for(const e of es){ if(skip.has(e))continue; const f=join(d,e); let st; try{st=statSync(f);}catch{continue;}
    if(st.isDirectory())visit(f); else out.push(relative(repo,f).split(String.fromCharCode(92)).join('/')); } };
  visit(join(repo,'force-app')); return out; };

const T = (label, fn) => { const t=process.hrtime.bigint(); const r=fn(); const ms=Number(process.hrtime.bigint()-t)/1e6;
  console.log(`  ${label.padEnd(34)} ${ms.toFixed(1).padStart(9)} ms`); return [r,ms]; };

console.log('INCREMENTAL INDEX PROFILE —', repo);
const [existing, loadMs] = T('loadGraph (parse + resolve)', () => loadGraph(fs, repo));
const [paths] = T('walk source tree', () => walk().filter(isModelledPath));
const [scanned] = T('read + sha256 every file', () => paths.map(p => ({ path:p, hash:hashContents(fs.readFile(p)) })));
const [plan] = T('planReindex (diff hashes)', () => planReindex(existing?.files ?? [], scanned));
const toExtract = filesToExtract(plan);
console.log(`     -> ${toExtract.length} file(s) to re-extract, ${plan.unchanged.length} unchanged`);
const [fresh] = T('extract changed files', () => toExtract.map(p => extractFile(p, fs.readFile(p))).filter(Boolean));
const freshFiles = fresh.map(f => ({ path:f.path, hash:hashContents(fs.readFile(f.path)), parsedOk:f.parsedOk, extractor:f.extractor }));
const [facts] = T('mergeFacts', () => mergeFacts(existing?.facts ?? [], fresh, plan));
const [files] = T('mergeFiles', () => mergeFiles(existing?.files ?? [], freshFiles, plan));
const [resolved, resolveMs] = T('resolve (GLOBAL)', () => resolveGraph(facts, { namespace:'c' }));
console.log(`     -> ${resolved.nodes.length} nodes, ${resolved.edges.length} edges`);
const [doc, serMs] = T('serializeGraph', () => serializeGraph({ files, facts, project, generator: currentGenerator(), createdAt:'x' }));
const [json, strMs] = T('JSON.stringify', () => JSON.stringify(doc));
console.log(`     -> ${(json.length/1048576).toFixed(2)} MiB`);
T('write to disk', () => saveGraph(fs, { root:repo, files, facts, project, generator: currentGenerator(), createdAt:'x' }));
console.log(`\n  loadGraph breakdown:`);
const gz = `${graphPath(repo)}.gz`;
const raw = existsSync(gz) ? gunzipSync(readFileSync(gz)).toString('utf8') : readFileSync(graphPath(repo),'utf8');
const [parsed, pMs] = T('  JSON.parse only', () => JSON.parse(raw));
console.log(`\n  DOMINANT: resolve=${resolveMs.toFixed(0)}ms  load=${loadMs.toFixed(0)}ms  serialize=${serMs.toFixed(0)}ms  stringify=${strMs.toFixed(0)}ms  parse=${pMs.toFixed(0)}ms`);
