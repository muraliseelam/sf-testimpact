import { execFileSync } from 'node:child_process';
const LIB = 'file:///C:/EB1A/repos/sf-testimpact/lib';
const { isModelledPath } = await import(`${LIB}/extract/index.js`);
const repo = 'C:/t/ar', windowSize = 30, sourcePaths = ['force-app'];
const git = (a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', maxBuffer: 512*1024*1024 });
const commits = git(['log','--format=%H','-n',String(windowSize*6),'--','*.cls','*.trigger'])
  .split('\n').map(s=>s.trim()).filter(Boolean).slice(0,windowSize).reverse();
const inSource = (p) => sourcePaths.some(sp => p===sp || p.startsWith(sp+'/'));

// Successive fixes, each ADDED to the previous.
const fixes = {
  none:        () => false,
  outside:     (p) => !inSource(p),
  companion:   (p) => p.endsWith('-meta.xml') && isModelledPath(p.replace(/-meta\.xml$/,'')),
  staticres:   (p) => /(^|\/)staticresources\//.test(p),
  dataweave:   (p) => /\.dwl(-meta\.xml)?$/.test(p),
};
const order = ['none','outside','companion','staticres','dataweave'];
const perCommit = [];
for (const c of commits) {
  let parent; try { parent = execFileSync('git',['rev-parse','--verify',c+'^1'],{cwd:repo,encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim(); } catch { continue; }
  let names; try { names = git(['diff','--name-only',`${parent}...${c}`]); } catch { continue; }
  perCommit.push(names.split('\n').map(s=>s.trim()).filter(Boolean));
}
console.log('commits analysed:', perCommit.length);
const applied = [];
for (const f of order) {
  if (f !== 'none') applied.push(fixes[f]);
  let blocked = 0;
  const blockers = {};
  for (const paths of perCommit) {
    const remaining = paths.filter(p => !applied.some(fn => fn(p)));
    const bad = remaining.filter(p => inSource(p) && !isModelledPath(p));
    if (bad.length > 0) {
      blocked++;
      for (const p of bad) {
        const base = p.split('/').pop();
        const m = /(\.[A-Za-z0-9]+(?:-meta\.xml)?)$/.exec(base);
        const k = m ? m[1] : base;
        blockers[k] = (blockers[k] ?? 0) + 1;
      }
    }
  }
  const pct = (blocked/perCommit.length*100).toFixed(1);
  const top = Object.entries(blockers).sort((a,b)=>b[1]-a[1]).slice(0,5);
  console.log(`after +${f.padEnd(10)} commits blocked by unmodelled-in-source: ${blocked}/${perCommit.length} (${pct}%)  top: ${JSON.stringify(Object.fromEntries(top))}`);
}
