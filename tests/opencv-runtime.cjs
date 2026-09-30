// MV3 CSP and lifecycle probe using the real unpacked extension.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const root = path.resolve(__dirname, '..');
let playwright;
try { playwright = require('playwright'); }
catch { playwright = require(path.resolve(path.dirname(process.execPath), '../node_modules/playwright')); }
async function until(read, check, timeout = 15000) {
  const deadline = Date.now() + timeout;
  do { const value = await read(); if (check(value)) return value; await new Promise(resolve => setTimeout(resolve, 30)); }
  while (Date.now() < deadline);
  throw new Error('Timed out waiting for extension runtime');
}
(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pagepath-opencv-'));
  const server = http.createServer((_req, res) => {
    res.writeHead(200, {'Content-Type':'text/html','Content-Security-Policy':"default-src 'none'; script-src 'none'; style-src 'unsafe-inline'"});
    res.end('<!doctype html><style>body{background:white;margin:0}p{position:absolute;top:200px;left:250px;font:24px serif}</style><p>OpenCV screenshot map</p>');
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  let context;
  try {
    const executablePath = process.env.PAGEPATH_BROWSER || (process.platform === 'win32' ? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' : undefined);
    context = await playwright.chromium.launchPersistentContext(profile, {executablePath,headless:true,viewport:{width:900,height:650},deviceScaleFactor:2,
      ignoreDefaultArgs:['--disable-extensions'],args:['--disable-extensions-except='+root,'--load-extension='+root,'--enable-unsafe-extension-debugging']});
    let worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const origin = new URL(worker.url()).origin, id = new URL(worker.url()).hostname;
    await until(()=>worker.evaluate(()=>chrome.action.onClicked.hasListeners()), Boolean);
    const info = await worker.evaluate(async () => {
      const cv = await globalThis.__PAGEPATH__.OpenCV.ready();
      globalThis.__firstCV = cv;
      const source = cv.matFromArray(3,3,cv.CV_8UC1,[255,255,255,255,0,255,255,255,255]), distance = new cv.Mat();
      try { cv.distanceTransform(source,distance,cv.DIST_L2,cv.DIST_MASK_PRECISE); return {version:cv.getBuildInformation().slice(0,100),center:distance.data32F[4],neighbor:distance.data32F[1]}; }
      finally {source.delete();distance.delete();}
    });
    assert.match(info.version,/OpenCV 4\.12\.0/); assert.equal(info.center,0); assert.equal(info.neighbor,1);
    const repeated = await worker.evaluate(async () => {
      importScripts('../vendor/opencv/opencv.js','content/opencvRuntime.js');
      const abort = new AbortController(); abort.abort(); let name;
      try {await globalThis.__PAGEPATH__.OpenCV.ready({signal:abort.signal});} catch(error) {name=error.name;}
      return {same:await globalThis.__PAGEPATH__.OpenCV.ready()===globalThis.__firstCV,name};
    });
    assert.deepEqual(repeated,{same:true,name:'AbortError'});
    const page = await context.newPage(); await page.goto('http://127.0.0.1:'+server.address().port); await page.bringToFront();
    const cdp = await context.browser().newBrowserCDPSession();
    const targets = await cdp.send('Target.getTargets',{filter:[{}]});
    const tab = targets.targetInfos.find(target=>target.type==='tab'&&target.url===page.url());
    async function action() {await cdp.send('Extensions.triggerAction',{id,targetId:tab.targetId});}
    await action();
    await page.waitForFunction(()=>document.querySelector('[data-pagepath-root]')?.shadowRoot.querySelector('.toolbar').dataset.state==='READY',{},{timeout:30000});
    let result = await worker.evaluate(async () => {
      const [tab]=await chrome.tabs.query({active:true,lastFocusedWindow:true});
      const [r]=await chrome.scripting.executeScript({target:{tabId:tab.id},world:'ISOLATED',func:()=>{
        const game=globalThis.__PAGEPATH__.instance;
        return {width:game.snapshot.analysis.width,height:game.snapshot.analysis.height,runtime:typeof globalThis.__PAGEPATH_OPENCV__,state:game.state};
      }});
      return r.result;
    });
    assert.deepEqual(result,{width:900,height:650,runtime:'undefined',state:'READY'});
    await action();
    await page.waitForFunction(()=>!document.querySelector('[data-pagepath-root]'));
    // Reload creates a fresh worker rather than reusing its initialized WASM.
    // Edge's debugger keeps an attached worker alive, so this explicitly tests
    // fresh lifecycle initialization instead of claiming the idle timer fired.
    const restarted=context.waitForEvent('serviceworker',{timeout:15000});
    await worker.evaluate(()=>chrome.runtime.reload()).catch(error=>{
      if (!/closed|destroyed/i.test(error.message)) throw error;
    });
    worker=await restarted;
    assert.equal(await worker.evaluate(()=>typeof globalThis.__firstCV),'undefined');
    await until(()=>worker.evaluate(()=>chrome.action.onClicked.hasListeners()),Boolean);
    await action();
    await page.waitForFunction(()=>document.querySelector('[data-pagepath-root]')?.shadowRoot.querySelector('.toolbar').dataset.state==='READY',{},{timeout:30000});
    assert.equal(await worker.evaluate(async()=>typeof(await globalThis.__PAGEPATH__.OpenCV.ready()).Mat),'function');
    console.log('OpenCV MV3: strict page CSP, real DPR=2 capture, 1 CSS-pixel map, native distance transform, cancellation, reinjection and extension reload with a fresh worker passed');
  } finally {await context?.close();server.close();fs.rmSync(profile,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
