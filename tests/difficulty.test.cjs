'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const context = vm.createContext({});
for (const file of ['config','collision','mazeCleanup','mazeRoute','mazeConnectors','mazeGenerator','routeMazeGenerator','levelGenerator'])
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/content', file + '.js'), 'utf8'), context);
const P = context.__PAGEPATH__;
function rng(seed) { return () => { seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
  t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function fixture(kind = 'blank', width = 640, height = 480) {
  const mask = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    mask[y * width + x] = kind === 'solid' ? 1 : kind === 'cards' ? Number(x % 158 < 120 && y % 116 < 84)
      : kind === 'noise' ? Number(x % 37 < 22 && y % 19 < 12) : 0;
  }
  return P.MazeGeometry.rebuild({ width, height, obstacleMask: mask, stats: {} }, [], mask);
}
function verify(level, source) {
  assert.equal(level.nodes.length, 2); assert.equal(level.nodes[0].kind, 'start'); assert.equal(level.nodes[1].kind, 'finish');
  assert.equal(level.unlimitedInk, true); assert.equal(level.maxInk, Infinity);
  assert.equal(level.obstacleIndex.walkableMask, level.analysis.walkableMask);
  assert.ok(Number.isInteger(level.difficulty) && level.difficulty >= 0 && level.difficulty <= 100);
  assert.equal(level.stars, P.Difficulty.stars(level.difficulty));
  assert.equal(level.mode, undefined); assert.equal(level.modeLabel, undefined);
  let measured = 0;
  for (let i = 0; i < level.referencePath.length; i++) {
    const p = level.referencePath[i]; assert.equal(P.Collision.pointHits(p, level.obstacleIndex), false);
    if (i) { const a = level.referencePath[i - 1]; assert.equal(P.Collision.segmentHits(a, p, level.obstacleIndex), false); measured += Math.hypot(a.x-p.x,a.y-p.y); }
  }
  assert.ok(Math.abs(measured - level.referenceLength) < 1e-5);
  const [a,b] = level.nodes;
  assert.ok(Math.hypot(a.x-b.x,a.y-b.y) > Math.hypot(source.width,source.height)*.3, 'endpoints span the page');
  assert.ok(measured > Math.hypot(source.width,source.height)*.65, 'a short pocket is not a maze');
  for (const p of level.nodes) assert.ok(level.analysis.distanceMap[Math.floor(p.y)*source.width+Math.floor(p.x)] >= 12, 'both endpoint icons fit');
  // Remove all reported route portals at once. If two answer vertices remain
  // connected, an off-answer shortcut bypasses at least one of its edges.
  const adjacency=level.maze.vertices.map(()=>[]);
  level.maze.edges.forEach((e,i)=>{adjacency[e.a].push([e.b,i]);adjacency[e.b].push([e.a,i]);});
  const ids=level.maze.routeVertexIds,removed=new Set(level.maze.routeEdgeIds),labels=new Int32Array(adjacency.length);
  assert.equal(removed.size,ids.length-1);
  for(let i=0;i<ids.length-1;i++)assert.ok(adjacency[ids[i]].some(([next,edge])=>next===ids[i+1]&&removed.has(edge)));
  let component=0;
  for(let at=0;at<labels.length;at++)if(!labels[at]){
    const queue=[at];labels[at]=++component;
    for(let i=0;i<queue.length;i++)for(const [next,edge]of adjacency[queue[i]])if(!removed.has(edge)&&!labels[next]){labels[next]=component;queue.push(next);}
  }
  assert.equal(new Set(ids.map(id=>labels[id])).size,ids.length,'every answer portal is necessary');
}

for(const kind of ['blank','cards','noise','solid'])test(kind+' pages generate all five stars from their final geometry',()=>{
  const source=fixture(kind),before=source.obstacleMask.slice(),levels=[],seeds=[];
  // Find the first seeded draw of each target without overriding construction
  // or score. This exercises both the public sampler and real maze generation.
  for(let seed=1;seed<300&&seeds.filter(Boolean).length<5;seed++){
    const inner=rng(Math.floor(rng(seed)()*4294967296)),draw=P.Difficulty.draw(source,inner);
    seeds[draw.targetStars-1] ||= seed;
  }
  assert.equal(seeds.filter(Boolean).length,5);
  for(const [index,seed]of seeds.entries()){
    const level=P.LevelGenerator.generate(source,[],rng(seed));verify(level,source);verifyCollectibles(level,[],{compact:true});
    assert.equal(level.challenge.targetStars,index+1);
    assert.equal(level.stars,index+1,kind+' target '+(index+1)+' seed '+seed+' must change actual geometry');
    const proof=P.RouteMazeGenerator.topology(level.analysis,...level.nodes);
    const measured=P.RouteMazeGenerator.measuredChallenge(level.analysis,level.referencePath,proof);
    assert.equal(level.difficulty,Math.round(measured.complexity*100));
    assert.equal(level.challenge.complexity,measured.complexity);
    assert.equal(level.stars,P.Difficulty.stars(measured.difficulty));
    assert.ok(level.challenge.intensity>=0 && level.challenge.intensity<=1);
    if(kind==='blank')assert.equal(level.mazeOpenings.length,0,'blank maps use irregular baffles, never artificial carved corridors');
    levels.push(level);
  }
  assert.deepEqual(source.obstacleMask,before,'random difficulty never mutates the cached screenshot');
  assert.ok(levels.at(-1).referenceLength>levels[0].referenceLength*1.5);
  assert.ok(levels.at(-1).challenge.turns>levels[0].challenge.turns+5);
});

test('remote forks inside one wrong turn do not inflate the number of choices along the answer',()=>{
  function measure(extraForks){
    const width=360,height=240,mask=new Uint8Array(width*height).fill(1);
    const rectangles=[[15,180,345,212],[130,20,158,196]];
    if(extraForks)rectangles.push([150,35,270,51],[150,90,280,106]);
    for(const [left,top,right,bottom]of rectangles)for(let y=top;y<bottom;y++)mask.fill(0,y*width+left,y*width+right);
    const analysis=P.MazeGeometry.rebuild({width,height,obstacleMask:mask,stats:{}},[],mask);
    const route=[{x:30.5,y:196.5},{x:330.5,y:196.5}],proof=P.RouteMazeGenerator.topology(analysis,...route);
    assert.equal(proof.unique,true);
    return P.RouteMazeGenerator.measuredChallenge(analysis,route,proof);
  }
  const simple=measure(false),tree=measure(true);
  assert.ok(simple.deadEnds>=1);
  assert.equal(tree.deadEnds,simple.deadEnds);
  assert.equal(tree.difficulty,simple.difficulty);
});

function verifyCollectibles(level, reserved = [], { compact = false, underToolbar = false, centerOnly = false } = {}) {
  const rules=P.Config.COLLECTIBLES,{width,height,walkableMask}=level.analysis;
  const reached=new Uint8Array(walkableMask.length),queue=[Math.floor(level.nodes[0].y)*width+Math.floor(level.nodes[0].x)];
  reached[queue[0]]=1;
  for(let i=0;i<queue.length;i++){
    const at=queue[i],x=at%width,y=Math.floor(at/width);
    for(const next of [x?at-1:-1,x+1<width?at+1:-1,y?at-width:-1,y+1<height?at+width:-1]){
      if(next>=0&&walkableMask[next]&&!reached[next]&&Math.hypot(next%width+.5-level.nodes.at(-1).x,Math.floor(next/width)+.5-level.nodes.at(-1).y)>P.Config.HIT_RADIUS+1){reached[next]=1;queue.push(next);}
    }
  }
  const items=level.collectibles;
  assert.ok(Array.isArray(items));assert.ok(items.filter(p=>p.kind==='xp').length<=10);
  assert.equal(items.filter(p=>p.kind==='multiplier').length,1,'every playable map receives one multiplier');
  assert.equal(new Set(items.map(p=>p.id)).size,items.length);
  for(let i=0;i<items.length;i++){
    const p=items[i];
    if(compact&&p.kind==='multiplier')assert.ok([1,2,4,6,10].includes(p.radius));else assert.equal(p.radius,10);
    assert.equal(reached[Math.floor(p.y)*width+Math.floor(p.x)],1,'bubble can be collected from the start before triggering the finish');
    assert.ok(p.kind==='xp'?[10,20,40].includes(p.value):[2,3,5,8].includes(p.value));
    for(const node of level.nodes)assert.ok(Math.hypot(p.x-node.x,p.y-node.y)>=(compact&&p.kind==='multiplier'?P.Config.HIT_RADIUS+2:rules.endpointMargin));
    for(const rect of underToolbar&&p.kind==='multiplier'?[]:[...reserved,...(level.toolbarRect?[level.toolbarRect]:[])]){
      const dx=Math.max(rect.x-p.x,0,p.x-rect.x-rect.width),dy=Math.max(rect.y-p.y,0,p.y-rect.y-rect.height);
      assert.ok(Math.hypot(dx,dy)>p.radius,'the full bubble avoids reserved controls');
    }
    for(let j=0;j<i;j++)assert.ok(Math.hypot(p.x-items[j].x,p.y-items[j].y)>=rules.minSpacing);
    if(centerOnly&&p.kind==='multiplier')continue;
    for(let y=Math.floor(p.y-p.radius);y<=Math.floor(p.y+p.radius);y++)for(let x=Math.floor(p.x-p.radius);x<=Math.floor(p.x+p.radius);x++){
      const dx=Math.max(x-p.x,0,p.x-x-1),dy=Math.max(y-p.y,0,p.y-y-1);
      if(Math.hypot(dx,dy)<=p.radius)assert.ok(x>=0&&y>=0&&x<width&&y<height&&walkableMask[y*width+x],'every pixel touched by the bubble is walkable');
    }
  }
}
function rewardsOnly(level,reserved=[],random=rng(17)) {
  const local=vm.createContext({__PAGEPATH__:{MazeGenerator:{generate:()=>level}}});
  for(const file of ['config','levelGenerator'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../src/content',file+'.js'),'utf8'),local);
  return local.__PAGEPATH__.LevelGenerator.generate(level.analysis,reserved,random);
}
function draws(prefix,seed=17){const rest=rng(seed);let at=0;return()=>at<prefix.length?prefix[at++]:rest();}
function rewardFixture(stars=3){
  const analysis=fixture(),nodes=[{x:30.5,y:30.5,kind:'start'},{x:609.5,y:449.5,kind:'finish'}];
  return {analysis,nodes,stars};
}

test('bubbles use only the final reachable component, avoid controls and preserve every map pixel',()=>{
  const width=640,height=480,mask=new Uint8Array(width*height);
  for(let y=0;y<height;y++)mask.fill(1,y*width+360,y*width+365);
  const analysis=P.MazeGeometry.rebuild({width,height,obstacleMask:mask,stats:{}},[],mask);
  const level={analysis,stars:5,nodes:[{x:30.5,y:30.5},{x:320.5,y:449.5}],toolbarRect:{x:40,y:170,width:260,height:65}};
  const reserved=[{x:180,y:25,width:150,height:80}],before=analysis.obstacleMask.slice(),walkable=analysis.walkableMask.slice();
  const result=rewardsOnly(level,reserved,draws([.999,.999]));verifyCollectibles(result,reserved);
  assert.equal(result.collectibles.filter(p=>p.kind==='xp').length,10);assert.equal(result.collectibles[0].value,8);
  assert.ok(result.collectibles.every(p=>p.x<360),'unreachable background on the other side of a wall receives no rewards');
  assert.equal(result.analysis,analysis);assert.deepEqual(analysis.obstacleMask,before);assert.deepEqual(analysis.walkableMask,walkable);
});

test('reward amount and rare multiplier boundaries follow the shared weights exactly',()=>{
  for(const [ticket,value]of [[0,2],[.624999,2],[.625,3],[.874999,3],[.875,5],[.974999,5],[.975,8],[.999999,8]]){
    const result=rewardsOnly(rewardFixture(1),[],draws([0,ticket]));
    assert.equal(result.collectibles.filter(p=>p.kind==='multiplier').length,1);
    assert.equal(result.collectibles.find(p=>p.kind==='multiplier').value,value,String(ticket));
    assert.equal(result.collectibles.filter(p=>p.kind==='xp').length,4);
  }
  for(const [ticket,value]of [[0,10],[.599999,10],[.6,20],[.899999,20],[.9,40],[.999999,40]]){
    const result=rewardsOnly(rewardFixture(1),[],draws([0,0,ticket,ticket,ticket,ticket]));
    assert.ok(result.collectibles.filter(p=>p.kind==='xp').every(p=>p.value===value));
  }
  assert.equal(rewardsOnly(rewardFixture(5),[],draws([.999999,0])).collectibles.length,11);
});

test('reward positions reproduce by seed, spread around the page and vary on the next draw',()=>{
  const level=rewardFixture(),a=rewardsOnly(level,[],rng(23)),b=rewardsOnly(level,[],rng(23)),c=rewardsOnly(level,[],rng(24));
  assert.equal(JSON.stringify(a.collectibles),JSON.stringify(b.collectibles));
  assert.notEqual(JSON.stringify(a.collectibles),JSON.stringify(c.collectibles));verifyCollectibles(a);
  assert.ok(new Set(a.collectibles.map(p=>(p.x<320?0:1)+(p.y<240?0:2))).size>=3,'rewards are spatially spread, not a pile along the answer');
});

test('a narrow passage keeps its guaranteed multiplier without adding XP bubbles or changing any map pixel',()=>{
  const width=220,height=120,mask=new Uint8Array(width*height).fill(1);
  for(let y=51;y<69;y++)mask.fill(0,y*width+10,y*width+210);
  const analysis=P.MazeGeometry.rebuild({width,height,obstacleMask:mask,stats:{}},[],mask),before=analysis.walkableMask.slice();
  const result=rewardsOnly({analysis,stars:5,nodes:[{x:20.5,y:60.5},{x:199.5,y:60.5}]},[],draws([.99,.99]));
  assert.equal(result.collectibles.length,1);assert.equal(result.collectibles[0].kind,'multiplier');
  assert.ok(result.collectibles[0].radius>0&&result.collectibles[0].radius<=6);verifyCollectibles(result,[],{compact:true});
  assert.deepEqual(analysis.walkableMask,before);
});

test('tight endpoint spacing permits one multiplier after the start and before the finish',()=>{
  const width=80,height=60,mask=new Uint8Array(width*height).fill(1);
  for(let y=14;y<46;y++)mask.fill(0,y*width+10,y*width+70);
  const analysis=P.MazeGeometry.rebuild({width,height,obstacleMask:mask,stats:{}},[],mask);
  const before=analysis.obstacleMask.slice(),walkable=analysis.walkableMask.slice();
  const result=rewardsOnly({analysis,stars:1,nodes:[{x:18.5,y:30.5},{x:61.5,y:30.5}]},[],draws([0,.8]));
  assert.equal(result.collectibles.length,1);verifyCollectibles(result,[],{compact:true});
  assert.equal(result.collectibles[0].value,3);assert.ok(result.collectibles[0].radius<10);
  assert.deepEqual(analysis.obstacleMask,before);assert.deepEqual(analysis.walkableMask,walkable);
});

test('a toolbar covering a tiny maze cannot suppress its multiplier while drawing controls are folded',()=>{
  const width=220,height=120,mask=new Uint8Array(width*height).fill(1);
  for(let y=51;y<69;y++)mask.fill(0,y*width+10,y*width+210);
  const analysis=P.MazeGeometry.rebuild({width,height,obstacleMask:mask,stats:{}},[],mask),before=analysis.walkableMask.slice();
  const reserved=[{x:0,y:0,width,height}];
  const result=rewardsOnly({analysis,stars:5,nodes:[{x:20.5,y:60.5},{x:199.5,y:60.5}]},reserved,draws([.99,.99]));
  assert.equal(result.collectibles.length,1);assert.equal(result.collectibles[0].value,8);
  verifyCollectibles(result,reserved,{compact:true,underToolbar:true});assert.deepEqual(analysis.walkableMask,before);
});

test('a one-pixel player passage still gets a reachable multiplier center without changing the collision mask',()=>{
  const width=160,height=60,walkableMask=new Uint8Array(width*height),componentLabels=new Int32Array(width*height);
  const distanceMap=new Float32Array(width*height);
  for(let x=10;x<150;x++){const at=30*width+x;walkableMask[at]=componentLabels[at]=1;distanceMap[at]=1;}
  const analysis={width,height,walkableMask,componentLabels,distanceMap,stats:{walkableThreshold:0}},before=walkableMask.slice();
  const result=rewardsOnly({analysis,stars:1,nodes:[{x:15.5,y:30.5},{x:144.5,y:30.5}]},[],draws([0,0]));
  assert.equal(result.collectibles.length,1);assert.equal(result.collectibles[0].radius,1);
  verifyCollectibles(result,[],{compact:true,centerOnly:true});assert.deepEqual(walkableMask,before);
});


test('the finish trigger cannot hide rewards behind the only exit passage',()=>{
  const width=640,height=320,mask=new Uint8Array(width*height).fill(1);
  for(const [left,top,right,bottom]of [[10,10,270,310],[250,146,400,174],[380,10,630,310]]){
    for(let y=top;y<bottom;y++)mask.fill(0,y*width+left,y*width+right);
  }
  const analysis=P.MazeGeometry.rebuild({width,height,obstacleMask:mask,stats:{}},[],mask);
  const nodes=[{x:40.5,y:160.5},{x:320.5,y:160.5}],before=analysis.obstacleMask.slice(),walkable=analysis.walkableMask.slice();
  assert.equal(analysis.componentLabels[160*width+40],analysis.componentLabels[160*width+580],'both rooms belong to the same original component');
  const result=rewardsOnly({analysis,stars:5,nodes},[],draws([.999,.999]));verifyCollectibles(result);
  assert.ok(result.collectibles.length>=4,'usable foreground-side space still receives rewards');
  assert.ok(result.collectibles.every(p=>p.x<nodes[1].x),'no reward requires crossing the finish to reach its room');
  assert.equal(result.analysis,analysis);assert.deepEqual(analysis.obstacleMask,before);assert.deepEqual(analysis.walkableMask,walkable);
});
