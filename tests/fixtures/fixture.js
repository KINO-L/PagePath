const type = new URLSearchParams(location.search).get('type') || 'simple';
const article = '网页中的内容构成了关卡的边界。观察文字之间、栏目之外的空白，找到一条连续的路线。每次生成关卡时，PagePath 都会先验证一条安全路径，再沿途放置节点。';
const views = {
  simple: `<section class="intro"><div class="eyebrow">THE WEBPAGE IS THE LEVEL</div><h1>留白，也有路径。</h1><div class="line"></div><p>文字、图片与按钮成为障碍。单击起点，从页面的空白中穿过，连接每一个节点。</p></section><aside class="floating-note">没有新世界。<br>这就是你正在浏览的网页。</aside>`,
  article: `<article class="article"><div class="eyebrow">FIELD NOTES / 001</div><h1>在日常网页里，<br>发现一条新的路径</h1>${Array.from({ length: 8 }, () => `<p>${article.repeat(2)}</p>`).join('')}</article>`,
  github: `<div class="eyebrow">PAGEPATH / REPOSITORY</div><h1>pagepath</h1><div class="tags"><button>Code</button><button>Issues 12</button><button>Pull requests 3</button><input aria-label="Search" placeholder="Search files"></div><div class="columns"><pre class="code">function createPuzzle(viewport) {\n  const obstacles = analyze(viewport);\n  const grid = buildGrid(obstacles);\n  const route = findSafeRoute(grid);\n  return sampleNodes(route);\n}\n\n// The webpage is the level.\nexport { createPuzzle };</pre><aside class="panel"><h2>About</h2><p>Turn any webpage into a puzzle.</p><button>Star project</button></aside></div>`,
  dashboard: `<div class="eyebrow">WORKSPACE / OVERVIEW</div><h1>每一天的进展</h1><div class="cards">${['访问量','已完成','活跃项目','待办事项','平均时长','本周目标'].map((name,i) => `<section class="card"><p>${name}</p><div class="metric">${[1248,36,8,14,27,92][i]}</div><p>与上周相比 +12%</p></section>`).join('')}</div>`,
  shop: `<div class="eyebrow">THE EVERYDAY COLLECTION</div><h1>日常器物</h1><div class="products">${['日光杯','方形托盘','棉布手袋','随行手册'].map((name,i) => `<article class="product"><img alt="${name}" src="data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="220" height="180"><rect width="220" height="180" fill="${['#d9dbcb','#d9cbbd','#c8d5d0','#d8d2da'][i]}"/><rect x="65" y="40" width="85" height="95" rx="14" fill="#f6f4eb"/></svg>`)}"><h2>${name}</h2><p>¥ ${[68,120,88,35][i]}</p><button>查看详情</button></article>`).join('')}</div>`,
  spa: `<div class="eyebrow">LIVE WORKSPACE</div><h1>会更新的页面</h1><p>时钟 <span class="clock" id="clock">00:00:00</span> · 等宽更新不应中断游戏。</p><div class="tags"><button id="mutate">添加新卡片</button><button id="move">移动内容</button></div><div id="feed" class="cards"><section class="card"><h2>保持观察</h2><p>结构、尺寸或位置变化后，应暂停并提示重新生成。</p></section></div>`
};
document.getElementById('content').innerHTML = views[type] || views.simple;
if (type === 'spa') {
  setInterval(() => { document.getElementById('clock').textContent = new Date().toLocaleTimeString('en-GB'); }, 1000);
  document.getElementById('mutate').onclick = () => { const card = document.createElement('section'); card.className = 'card'; card.innerHTML = '<h2>新内容</h2><p>这张卡片改变了可通行区域。</p>'; document.getElementById('feed').append(card); };
  document.getElementById('move').onclick = () => { document.getElementById('feed').style.transform = 'translateY(120px)'; };
}
const spacer = document.createElement('div'); spacer.className = 'scroll-space'; document.body.append(spacer);
// This local demo loads exactly the extension's modules in the same order.
// It is a test harness only: the real extension injects into an isolated world.
const scripts = ['config','collision','grid','pathfinding','scoring','mazeCleanup','mazeRoute','mazeConnectors','routeMazeGenerator','mazeGenerator','levelGenerator',
  'opencvRuntime','compactDom','compactMask','imageMapAnalyzer','mapCodec','overlay','pageSnapshot','game'].map(name => `/src/content/${name}.js`);
scripts.unshift('/vendor/opencv/opencv.js');
let loaded;
document.getElementById('launch').onclick = async () => {
  if (!globalThis.chrome?.runtime?.id) {
    document.getElementById('launch').textContent = '请点击浏览器工具栏中的 PagePath 扩展';
    return;
  }
  loaded ||= scripts.reduce((promise, source) => promise.then(() => new Promise((resolve,reject) => {
    const script = document.createElement('script'); script.src = source; script.onload = resolve; script.onerror = reject; document.head.append(script);
  })), Promise.resolve());
  await loaded;
  if (globalThis.__PAGEPATH__.instance) { globalThis.__PAGEPATH__.instance.destroy(); return; }
  const instance = new globalThis.__PAGEPATH__.Game(); globalThis.__PAGEPATH__.instance = instance; instance.start();
};
