// Run from an existing ego-browser TaskSpace; does not create spaces or mutate server data.
// await (await import("file:///absolute/project/.qa/ui-polish.mjs")).runUiPolish(page, "/tmp/screenshots")
import assert from 'node:assert/strict';

export async function runUiPolish(page, outputDir, base = 'http://127.0.0.1:8790') {
  const results = [];
  const check = (name, condition) => {
    assert.ok(condition, name);
    results.push(name);
  };
  const viewport = (width, height) => page.cdp('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: 1, mobile: width < 980,
  });
  const prefKeys = ['et.rate','et.fs','et.leading','et.theme','et.autonext','et.autoscroll','et.learning.open','et.showzh'];
  await page.goto(base, {waitUntil:'domcontentloaded'});
  const prefs = await page.evaluate(keys => Object.fromEntries(keys.map(key => [key, localStorage.getItem(key)])), prefKeys);
  let positionKey, positionValue;
  try {
    await page.waitForSelector('.episode-card', {state:'visible'});
    await page.evaluate(() => {
      window.__uiErrors = [];
      window.addEventListener('error', e => window.__uiErrors.push(e.message));
      window.addEventListener('unhandledrejection', e => window.__uiErrors.push(String(e.reason)));
    });
    await viewport(1440, 1000);
    await page.cdp('Emulation.setEmulatedMedia', {features:[{name:'prefers-reduced-motion',value:'reduce'}]});
    const library = await page.evaluate(() => {
      const hero = document.querySelector('.hero-card').getBoundingClientRect();
      const input = document.querySelector('#url').getBoundingClientRect();
      const card = [...document.querySelectorAll('.episode-card')].find(el => el.querySelector('.badge.ready'));
      return {height:hero.height, top:hero.top, inputTop:input.top, id:card?.dataset.id,
        nav:[...document.querySelectorAll('#appNav button')].map(el=>el.getAttribute('aria-label'))};
    });
    check('Prominent import hero remains first, at least 252px tall', library.height >= 252 && library.top < 150 && library.inputTop < 500);
    check('Navigation contains pages, not a duplicate playback action', library.nav.join(',') === '资料库,生词本');
    assert.ok(library.id, 'A ready episode is required for this smoke test');
    positionKey = 'et.pos.' + library.id;
    positionValue = await page.evaluate(key => localStorage.getItem(key), positionKey);
    await page.screenshot({path:outputDir+'/desktop-library.png'});
    await page.focus(`.episode-card[data-id="${library.id}"]`);
    await page.press(`.episode-card[data-id="${library.id}"]`, 'Enter');
    await page.waitForSelector('#article .s', {state:'visible'});
    check('Episode cards support keyboard navigation', await page.evaluate(()=>location.hash.length > 1));
    check('Settings remains visible while player is open', await page.evaluate(()=>document.querySelector('#settingsBtn').getBoundingClientRect().width >= 44));
    check('Player uses SVG controls and a larger progress hit target', await page.evaluate(()=>
      ['barPlay','barBack10','barFwd10','rateCtl'].every(id=>document.getElementById(id).querySelector('svg')) &&
      document.querySelector('#barTrack').getBoundingClientRect().height >= 28));
    await page.screenshot({path:outputDir+'/desktop-reader.png'});
    await page.click('#rateCtl');
    check('Speed picker marks current selection', await page.evaluate(()=>document.querySelectorAll('.rate-option[aria-pressed="true"]').length === 1));
    await page.screenshot({path:outputDir+'/desktop-rate.png'});
    await page.click('.rate-option[data-rate="1.5"]');
    check('Speed selects directly and closes picker', await page.evaluate(()=>document.querySelector('#rateVal').textContent === '1.5×' && !document.querySelector('#rateMenu').open));
    const beforeSeek = await page.evaluate(()=>Number(document.querySelector('#barTrack').getAttribute('aria-valuenow')));
    await page.focus('#barTrack');
    await page.press('#barTrack','ArrowRight');
    check('Keyboard seeking updates slider accessibility state', await page.evaluate(before=>Number(document.querySelector('#barTrack').getAttribute('aria-valuenow')) === before + 5, beforeSeek));
    await page.press('#barTrack','Home');
    await page.evaluate(()=>{ensureAudio().muted=true});
    await page.click('#barPlay');
    await page.waitForFunction(()=>document.querySelector('#etAudio')?.currentTime > .15,undefined,{timeout:10000});
    check('Playback starts and respects chosen speed', await page.evaluate(()=>!document.querySelector('#etAudio').paused && document.querySelector('#etAudio').playbackRate===1.5 && document.querySelector('#barPlay').getAttribute('aria-label')==='暂停'));
    await page.click('#barPlay');
    check('Pause updates audio and icon state', await page.evaluate(()=>document.querySelector('#etAudio').paused && document.querySelector('#barPlay').dataset.icon==='play'));
    const beforeSkip = await page.evaluate(()=>document.querySelector('#etAudio').currentTime);
    await page.click('#barFwd10');
    check('Forward control seeks ten seconds', await page.evaluate(before=>Math.abs(document.querySelector('#etAudio').currentTime-before-10)<.3,beforeSkip));
    await page.click('#barBack10');
    check('Rewind control seeks ten seconds', await page.evaluate(before=>Math.abs(document.querySelector('#etAudio').currentTime-before)<.3,beforeSkip));
    await page.click('#settingsBtn');
    await page.focus('#fs');
    await page.press('#fs','End');
    check('Font preview updates immediately', await page.evaluate(()=>getComputedStyle(document.querySelector('.reading-preview p')).fontSize === '24px'));
    await page.focus('#leading');
    await page.press('#leading','Home');
    check('Line-height preview updates immediately', await page.evaluate(()=>Math.abs(parseFloat(getComputedStyle(document.querySelector('.reading-preview p')).lineHeight)-37.2) < .1));
    await page.selectOption('#theme','dark');
    check('Dark theme applies', await page.evaluate(()=>document.documentElement.dataset.theme === 'dark'));
    await page.screenshot({path:outputDir+'/desktop-settings-dark.png'});
    await page.selectOption('#theme','light');
    await page.evaluate(()=>{applyFontSize(20);applyLeading(1.8)});
    await page.click('#settingsClose');

    for (const [width,height] of [[768,1024],[390,844],[320,568]]) {
      await viewport(width,height);
      check(`No horizontal overflow at ${width}px`, await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth));
      if(width > 760) continue;
      if(!await page.evaluate(()=>document.body.classList.contains('player-sheet-open'))) await page.click('#learningToggle');
      check(`Mobile sheet isolates background at ${width}px`, await page.evaluate(()=>document.querySelector('.app-shell').inert && document.querySelector('#bar').getAttribute('aria-modal') === 'true'));
      await page.click('#mobileRateCtl');
      check(`Mobile rate picker opens at ${width}px`, await page.evaluate(()=>document.querySelector('#rateMenu').open));
      await page.click('.rate-option[data-rate="0.75"]');
      check(`Mobile rate choice matches desktop at ${width}px`, await page.evaluate(()=>document.querySelector('#rateVal').textContent === document.querySelector('#mobileRateVal').textContent));
      await page.focus('#learningClose');
      await page.press('#learningClose','Tab');
      check(`Focus stays in player sheet at ${width}px`, await page.evaluate(()=>document.querySelector('#bar').contains(document.activeElement)));
      await page.screenshot({path:outputDir+`/mobile-player-${width}.png`});
      await page.press('#barTrack','Escape');
      check(`Closing sheet restores background at ${width}px`, await page.evaluate(()=>!document.querySelector('.app-shell').inert && !document.body.classList.contains('player-sheet-open')));
    }
    await viewport(390,844);
    await page.click('#vocabBtn');
    await page.waitForSelector('.vword', {state:'visible'});
    check('Vocabulary title is clamped to two lines', await page.evaluate(()=>getComputedStyle(document.querySelector('.vt')).webkitLineClamp === '2'));
    await page.click('.vg-source summary >> nth=0');
    check('Full source title can be expanded', await page.evaluate(()=>document.querySelector('.vg-source').open));
    await page.click('.vg-source summary >> nth=0');
    await page.click('.vmore summary >> nth=0');
    check('Remove is a labelled secondary action', await page.evaluate(()=>document.querySelector('.vmore').open && document.querySelector('.vx').textContent.includes('移出生词本')));
    await page.click('.vmore summary >> nth=0');
    await page.screenshot({path:outputDir+'/mobile-vocab.png'});

    // Mock only the definition response; never incur a model call during regression tests.
    await page.evaluate(() => {
      window.__uiFetch = window.fetch;
      window.fetch = (url, options) => String(url).includes('/explain?')
        ? Promise.resolve(new Response(JSON.stringify({cached:true,payload:{sense_here:'结合上下文理解并掌握。',pos:'动词',ipa:'/test/',roots:{available:false},related:{sentences:Array(18).fill('Stay curious and keep reading every day.')}}}),{headers:{'Content-Type':'application/json'}}))
        : window.__uiFetch(url, options);
    });
    await page.click('.vword >> nth=0');
    await page.waitForSelector('#pBody .field', {state:'visible'});
    check('Definition details start collapsed; no cache jargon', await page.evaluate(()=>!document.querySelector('#pBody details[open]') && !document.querySelector('#pBody').textContent.includes('缓存命中')));
    await page.click('#pBody .def-extra:last-child summary');
    await page.evaluate(()=>document.querySelector('#pBody').scrollTop=10000);
    check('Definition close and saved state stay visible on long content', await page.evaluate(()=>{
      const close=document.querySelector('#pClose').getBoundingClientRect(), save=document.querySelector('#pMark').getBoundingClientRect();
      return close.top >= 0 && close.bottom <= innerHeight && save.bottom <= innerHeight && document.querySelector('#pBody').scrollTop>0;
    }));
    await page.screenshot({path:outputDir+'/mobile-definition-expanded.png'});
    await page.click('#pClose');
    await page.evaluate(()=>{window.fetch=window.__uiFetch;delete window.__uiFetch});
    await page.click('#settingsBtn');
    await viewport(320,568);
    check('Small-screen settings scroll within dialog', await page.evaluate(()=>{
      const d=document.querySelector('#settings').getBoundingClientRect();
      return d.left>=0 && d.right<=innerWidth && d.bottom<=innerHeight && d.height<=innerHeight;
    }));
    await page.click('#settingsClose');
    await page.click('#homeBtn');
    await page.click('#go');
    check('Empty import has inline mobile feedback', await page.evaluate(()=>!document.querySelector('#importStatus').hidden && document.activeElement.id === 'url'));
    await page.evaluate(()=>{
      window.__uiFetch=window.fetch;
      window.__uiLoadOffline=loadOffline;
      loadOffline=()=>null;
      window.fetch=(url,options)=>String(url)==='/episodes'
        ? Promise.resolve(new Response(JSON.stringify({detail:'未授权，请使用已授权链接'}),{status:401,headers:{'Content-Type':'application/json'}}))
        : window.__uiFetch(url,options);
      loadList();
    });
    await page.waitForSelector('#listRetry',{state:'visible'});
    check('Library authorization/network failure is visible, not an empty library', await page.evaluate(()=>document.querySelector('#list [role="alert"]').textContent.includes('未授权')));
    await page.evaluate(()=>{window.fetch=window.__uiFetch;delete window.__uiFetch;loadOffline=window.__uiLoadOffline;delete window.__uiLoadOffline});
    await page.click('#listRetry');
    await page.waitForSelector('.episode-card',{state:'visible'});
    check('Library retry recovers after transient failure', await page.evaluate(()=>!document.querySelector('#listRetry')));
    check('No uncaught runtime errors', await page.evaluate(()=>window.__uiErrors.length === 0));
    return {passed:results.length,checks:results};
  } finally {
    await page.evaluate(({prefs,positionKey,positionValue}) => {
      if(window.__uiFetch){window.fetch=window.__uiFetch;delete window.__uiFetch}
      if(window.__uiLoadOffline){loadOffline=window.__uiLoadOffline;delete window.__uiLoadOffline}
      stopAndClose();
      document.querySelectorAll('dialog[open]').forEach(dialog=>dialog.close());
      closeLearning();
      if(positionKey) prefs[positionKey]=positionValue;
      for(const [key,value] of Object.entries(prefs)){
        if(value === null) localStorage.removeItem(key); else localStorage.setItem(key,value);
      }
    },{prefs,positionKey,positionValue});
  }
}
