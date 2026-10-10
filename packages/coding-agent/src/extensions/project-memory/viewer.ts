import type { ProjectGraph } from "./graph.ts";

/** Offline viewer: no web service, CDN, repository source bodies or network requests. */
export function renderGraphViewer(graph: ProjectGraph): string {
	const data = JSON.stringify(graph)
		.replace(/</g, "\\u003c")
		.replace(/\u2028/g, "\\u2028")
		.replace(/\u2029/g, "\\u2029");
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Relay · Project memory</title>
<style>
:root{color-scheme:dark;--bg:#17191e;--panel:#202329;--text:#edf0f4;--muted:#b3bac7;--line:#424955;--accent:#8ed3d8;font-family:system-ui,sans-serif}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);height:100dvh;display:grid;grid-template-rows:auto 1fr}::selection{background:var(--accent);color:var(--bg)}
header{padding:18px 24px;border-bottom:1px solid var(--line);display:flex;gap:16px;align-items:baseline;flex-wrap:wrap}h1{font-size:20px;letter-spacing:-.02em;margin:0}header p{margin:0;color:var(--muted);font-size:13px}main{min-height:0;display:grid;grid-template-columns:290px minmax(0,1fr) 300px}
aside{padding:20px;overflow:auto;background:var(--panel)}aside:first-child{border-right:1px solid var(--line)}aside:last-child{border-left:1px solid var(--line)}label{display:block;font-size:13px;color:var(--muted);margin-bottom:8px}input,select,button{font:inherit;color:var(--text);background:var(--bg);border:1px solid var(--line);border-radius:4px}input,select{width:100%;padding:10px;margin-bottom:16px;caret-color:var(--accent)}input::placeholder{color:var(--muted)}button{cursor:pointer;padding:8px 10px}button:hover{border-color:var(--accent);background:#2c353e}button:disabled{cursor:default;color:var(--muted)}:focus-visible{outline:2px solid var(--accent);outline-offset:3px}#results{display:grid;gap:4px}#results button{text-align:left;border:0;background:transparent;overflow-wrap:anywhere;font-size:13px;line-height:1.5}#results button[aria-pressed=true]{background:#31454c;color:var(--accent)}small{color:var(--muted)}#status{margin:0 0 12px;font-size:12px;color:var(--muted);font-variant-numeric:tabular-nums}.scene{position:relative;min-width:0;overflow:hidden}canvas{display:block;width:100%;height:100%;touch-action:none}.toolbar{position:absolute;top:16px;left:16px;display:flex;gap:6px}.hint{position:absolute;bottom:12px;left:16px;right:16px;font-size:12px;color:var(--muted);pointer-events:none}.legend{display:flex;gap:14px;flex-wrap:wrap;margin-top:16px;font-size:12px;color:var(--muted)}.legend span::before{content:"";display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--node);margin-right:6px}h2{font-size:16px;margin:0 0 12px;overflow-wrap:anywhere}#details p{color:var(--muted);font-size:13px;line-height:1.6;white-space:pre-wrap;overflow-wrap:anywhere}#relations{display:grid;gap:6px;margin-top:20px}#relations button{text-align:left;font-size:12px;overflow-wrap:anywhere}#details code{font-size:12px;color:var(--accent);overflow-wrap:anywhere}::-webkit-scrollbar{width:8px}::-webkit-scrollbar-thumb{background:var(--line);border-radius:4px}
@media(max-width:1000px){main{grid-template-columns:240px minmax(0,1fr)}aside:last-child{grid-column:1/-1;max-height:260px;border-left:0;border-top:1px solid var(--line)}main{grid-template-rows:minmax(300px,1fr) auto}}
@media(max-width:600px){body{height:auto;min-height:100dvh}header{padding:16px}main{display:flex;flex-direction:column}aside:first-child{max-height:310px;border-right:0;border-bottom:1px solid var(--line)}.scene{height:440px;flex-shrink:0}aside:last-child{max-height:none}.toolbar{flex-wrap:wrap}header p{font-size:12px}}
</style></head><body>
<header><h1>Project memory</h1><p id="summary">Loading repository map…</p></header>
<main><aside aria-label="Find nodes"><label for="search">Find a file, symbol or package</label><input id="search" type="search" placeholder="Search repository" autocomplete="off"><label for="kind">Node type</label><select id="kind"><option value="">All types</option><option value="directory">Directories</option><option value="file">Files</option><option value="package">Packages</option><option value="dependency">Dependencies</option></select><p id="status" role="status"></p><div id="results"></div></aside>
<section class="scene" aria-label="Repository graph"><canvas id="graph" role="img" aria-label="Graph of repository relationships. Select nodes using the search results to explore them."></canvas><div class="toolbar"><button id="overview">Overview</button><button id="fit">Fit graph</button><button id="plus" aria-label="Zoom in">+</button><button id="minus" aria-label="Zoom out">−</button></div><div class="hint" id="hint">Drag to pan · Scroll to zoom · Select a node to explore its connections</div></section>
<aside id="details" aria-label="Node details"><h2 id="title">Explore the repository</h2><code id="path"></code><p id="description">Find a file or package, then select it to see its relationships. This map helps navigation; read the source before editing.</p><div class="legend"><span style="--node:#8ed3d8">Directory</span><span style="--node:#edf0f4">File</span><span style="--node:#eab978">Package</span><span style="--node:#bfa5e7">Dependency</span></div><div id="relations"></div></aside></main>
<script id="memory-data" type="application/json">${data}</script>
<script>
const graph = JSON.parse(document.getElementById('memory-data').textContent);
const byId = new Map(graph.nodes.map(n => [n.id, n]));
const adjacency = new Map(graph.nodes.map(n => [n.id, []]));
for (const e of graph.edges) { adjacency.get(e.from)?.push(e); adjacency.get(e.to)?.push(e); }
const search = document.getElementById('search'), kind = document.getElementById('kind'), results = document.getElementById('results');
const canvas = document.getElementById('graph'), ctx = canvas.getContext('2d');
const colors = {directory:'#8ed3d8',file:'#edf0f4',package:'#eab978',dependency:'#bfa5e7'};
let selected = null, hovered = null, visible = [], links = [], width = 0, height = 0, scale = 1, panX = 0, panY = 0;
document.getElementById('summary').textContent = graph.nodes.length + ' nodes · ' + graph.edges.length + ' relationships · Updated ' + new Date(graph.updatedAt).toLocaleString();
function button(n, caption, parent) { const b = document.createElement('button'); b.textContent = caption; b.setAttribute('aria-pressed', String(n.id === selected)); b.addEventListener('click', () => select(n.id)); parent.append(b); }
function showResults() {
 const query = search.value.trim().toLowerCase();
 const matches = graph.nodes.filter(n => (!kind.value || n.kind === kind.value) && (!query || (n.label+' '+(n.path || '')+' '+n.summary).toLowerCase().includes(query)));
 results.replaceChildren(); for (const n of matches.slice(0,100)) button(n,n.path || n.label,results);
 document.getElementById('status').textContent = matches.length ? matches.length + ' matches' + (matches.length > 100 ? ' · First 100 shown; refine your search' : '') : 'No matches. Try a different name or node type.';
}
function select(id) {
 selected = id; const n = byId.get(id); if (!n) return;
 document.getElementById('title').textContent = n.label; document.getElementById('path').textContent = n.path || n.kind;
 document.getElementById('description').textContent = n.summary;
 const related = document.getElementById('relations'); related.replaceChildren();
 const edges = adjacency.get(id) || [];
 for (const e of edges.slice(0,100)) { const target = byId.get(e.from === id ? e.to : e.from); if (target) button(target, e.kind + (e.from === id ? ' → ' : ' ← ') + (target.path || target.label), related); }
 if (!edges.length) { const p = document.createElement('p'); p.textContent = 'No indexed relationships.'; related.append(p); }
 showResults(); layout();
}
function layout() {
 let nodes;
 if (selected) { const ids = new Set([selected]); for (const e of adjacency.get(selected) || []) { ids.add(e.from); ids.add(e.to); } nodes = Array.from(ids).map(id => byId.get(id)).filter(Boolean).slice(0,180); }
 else { const ids = new Set(graph.nodes.filter(n => n.kind === 'directory' && n.path.split('/').length <= 2 || n.kind === 'package').map(n => n.id)); for (const n of graph.nodes.filter(n => n.kind === 'package')) { const parent = (adjacency.get(n.id) || []).find(e => e.kind === 'contains' && e.to === n.id); if (parent) ids.add(parent.from); } nodes = Array.from(ids).map(id => byId.get(id)).filter(Boolean).slice(0,180); if (!nodes.length) nodes = graph.nodes.slice(0,180); }
 const ids = new Set(nodes.map(n => n.id)); links = graph.edges.filter(e => ids.has(e.from) && ids.has(e.to));
 visible = nodes.map((n,i) => ({...n,x:Math.cos(i*2.39996)*Math.sqrt(i+1)*24,y:Math.sin(i*2.39996)*Math.sqrt(i+1)*24}));
 const positions = new Map(visible.map(n => [n.id,n]));
 for (let step=0;step<60;step++) {
  for (let i=0;i<visible.length;i++) for (let j=i+1;j<visible.length;j++) { const a=visible[i], b=visible[j], dx=a.x-b.x, dy=a.y-b.y, d=Math.max(50,dx*dx+dy*dy), f=Math.min(1,500/d); a.x+=dx*f; a.y+=dy*f; b.x-=dx*f; b.y-=dy*f; }
  for (const e of links) { const a=positions.get(e.from),b=positions.get(e.to),dx=b.x-a.x,dy=b.y-a.y,d=Math.max(1,Math.hypot(dx,dy)),f=(d-95)/d*.035; a.x+=dx*f;a.y+=dy*f;b.x-=dx*f;b.y-=dy*f; }
  for (const n of visible) { n.x*=.99;n.y*=.99; }
 }
 document.getElementById('hint').textContent = visible.length + ' nodes shown · '+(selected ? 'Selected node and direct neighbors' : 'Directories and packages')+' · Drag to pan, scroll to zoom';
 fit();
}
function fit() { panX=0;panY=0;const extent=Math.max(120,...visible.map(n=>Math.max(Math.abs(n.x),Math.abs(n.y))));scale=Math.max(.08,Math.min(1.5,(Math.min(width,height)-100)/(extent*2)));draw(); }
function draw() {
 ctx.clearRect(0,0,width,height); ctx.save(); ctx.translate(width/2+panX,height/2+panY);ctx.scale(scale,scale);
 const positions=new Map(visible.map(n=>[n.id,n]));ctx.lineWidth=1/scale;ctx.strokeStyle='#505968';
 for(const e of links){const a=positions.get(e.from),b=positions.get(e.to);ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.stroke();}
 for(const n of visible){ctx.beginPath();ctx.arc(n.x,n.y,(n.id===selected?8:4)/scale,0,Math.PI*2);ctx.fillStyle=colors[n.kind];ctx.fill();if(n.id===selected||n.id===hovered){ctx.strokeStyle='#ffffff';ctx.lineWidth=2/scale;ctx.stroke();}}
 const boxes=[];ctx.font=(12/scale)+'px system-ui';
 const labels=[...visible].sort((a,b)=>(b.id===selected?3:b.id===hovered?2:b.kind==='package'?1:0)-(a.id===selected?3:a.id===hovered?2:a.kind==='package'?1:0));
 for(const n of labels){const label=n.label.slice(0,38),w=ctx.measureText(label).width*scale,x=n.x*scale+width/2+panX+10,y=n.y*scale+height/2+panY-10;const box={x,y,w,h:18};if(n.id!==selected&&n.id!==hovered&&(x<0||x+w>width||y<50||y+18>height-35||boxes.some(b=>x<b.x+b.w&&x+w>b.x&&y<b.y+b.h&&y+18>b.y)))continue;boxes.push(box);ctx.fillStyle=colors[n.kind];ctx.fillText(label,n.x+10/scale,n.y+4/scale);}
 ctx.restore();
}
new ResizeObserver(() => { const rect=canvas.getBoundingClientRect();width=rect.width;height=rect.height;const dpr=devicePixelRatio||1;canvas.width=width*dpr;canvas.height=height*dpr;ctx.setTransform(dpr,0,0,dpr,0,0);fit(); }).observe(canvas);
let drag=null;
canvas.addEventListener('pointerdown',e=>{drag={x:e.clientX,y:e.clientY,moved:false};canvas.setPointerCapture(e.pointerId);});
canvas.addEventListener('pointermove',e=>{if(!drag){const rect=canvas.getBoundingClientRect(),x=(e.clientX-rect.left-width/2-panX)/scale,y=(e.clientY-rect.top-height/2-panY)/scale;const n=visible.find(n=>Math.hypot(n.x-x,n.y-y)<12/scale);const next=n?.id||null;if(next!==hovered){hovered=next;canvas.title=n?.path||n?.label||'';draw();}return;}const dx=e.clientX-drag.x,dy=e.clientY-drag.y;if(Math.abs(dx)+Math.abs(dy)>2)drag.moved=true;panX+=dx;panY+=dy;drag.x=e.clientX;drag.y=e.clientY;draw();});
canvas.addEventListener('pointerup',e=>{if(drag&&!drag.moved){const rect=canvas.getBoundingClientRect(),x=(e.clientX-rect.left-width/2-panX)/scale,y=(e.clientY-rect.top-height/2-panY)/scale;const n=visible.find(n=>Math.hypot(n.x-x,n.y-y)<12/scale);if(n)select(n.id);}drag=null;});
canvas.addEventListener('pointercancel',()=>{drag=null;});
function zoom(factor){scale=Math.max(.05,Math.min(5,scale*factor));draw();}
canvas.addEventListener('wheel',e=>{e.preventDefault();zoom(e.deltaY<0?1.12:1/1.12);},{passive:false});
document.getElementById('plus').onclick=()=>zoom(1.25);document.getElementById('minus').onclick=()=>zoom(.8);document.getElementById('fit').onclick=fit;
document.getElementById('overview').onclick=()=>{selected=null;showResults();layout();document.getElementById('title').textContent='Explore the repository';document.getElementById('path').textContent='';document.getElementById('description').textContent='Select a file or package to explore its connections.';document.getElementById('relations').replaceChildren();};
search.addEventListener('input',showResults);kind.addEventListener('change',showResults);
if(graph.warnings.length){document.getElementById('description').textContent=graph.warnings.join('\\n');}
showResults();layout();
</script></body></html>`;
}
