/* Isolated browser verification: all non-loopback requests are intercepted.
   No real Supabase SDK, auth, emails, accounts, or database is used. */
const { chromium } = require('playwright');
const { createServer } = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const out = process.env.PIA_TEST_OUTPUT || '/tmp/pia-batch-1-evidence';
fs.mkdirSync(out, { recursive: true });
const mime = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.svg':'image/svg+xml', '.webp':'image/webp', '.png':'image/png', '.mp4':'video/mp4' };
const server = createServer((req,res) => {
  const file = path.resolve(root, '.' + decodeURIComponent(new URL(req.url,'http://localhost').pathname));
  if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (error,data) => {
    if (error) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type', mime[path.extname(file)] || 'application/octet-stream');
    res.end(data);
  });
});
function fixture() {
  window.fixture = { calls:[], result:null, delay:0, role:null, session:null, userError:null, updateError:null, profileError:null, signoutError:null };
  const f = window.fixture;
  Object.assign(f, window.fixtureInitial || {});
  const user = { id:'isolated-user', email:'fixture@example.test', app_metadata:{} };
  const hash = new URLSearchParams(location.hash.slice(1));
  if (hash.get('access_token')) f.session = { access_token:hash.get('access_token'), user };
  const param = new URLSearchParams(location.search);
  if (param.has('fixtureRole')) { f.role = param.get('fixtureRole'); f.session = { access_token:'isolated-session', user }; }
  const call = async (method,args) => {
    f.calls.push({method,args});
    if (f.delay) await new Promise(resolve=>setTimeout(resolve,f.delay));
    return { data:{}, error:f.result };
  };
  const api = {
    auth: {
      getSession: async()=>({data:{session:f.session},error:null}),
      getUser: async()=>({data:{user:f.session?.user},error:f.userError}),
      onAuthStateChange: ()=>({data:{subscription:{unsubscribe(){}}}}),
      signInWithOtp: args=>call('activation',args),
      resetPasswordForEmail: (email,args)=>call('recovery',{email,...args}),
      signInWithPassword: async args=>{ f.calls.push({method:'signin'}); return {error:{message:'Invalid login credentials',status:400}}; },
      verifyOtp: async args=>{ f.calls.push({method:'verify',args:{type:args.type}}); if(f.result)return {error:f.result}; f.session={access_token:'isolated-exchanged',user};return {data:{session:f.session},error:null}; },
      updateUser: async()=>{ f.calls.push({method:'password'}); if(f.delay)await new Promise(r=>setTimeout(r,f.delay));return {data:{user},error:f.updateError}; },
      signOut: async()=>{f.calls.push({method:'signout'});if(!f.signoutError)f.session=null;return {error:f.signoutError};}
    },
    from: ()=>{
      let updating = false;
      const chain = {
        select(){return chain;}, eq(){return chain;},
        update(){updating=true;f.calls.push({method:'profile'});return chain;},
        maybeSingle: async()=>({data:updating && f.profileError ? null : {email:user.email,full_name:'Fixture Learner',role:f.role||'student'},error:updating?f.profileError:null})
      };return chain;
    },
    rpc:async()=>({data:true,error:null})
  };
  window.supabase = { createClient:()=>api };
}
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({headless:true, executablePath:process.env.PIA_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args:['--disable-background-networking']});
  const results=[];
  async function pageFor(url='/index.html',width=1280,height=900,theme='dark', initial={}) {
    const context=await browser.newContext({viewport:{width,height},reducedMotion:'reduce',serviceWorkers:'block'});
    await context.addInitScript(initial=>window.fixtureInitial=initial,initial);
    await context.addInitScript(theme=>localStorage.setItem('pia_theme',theme),theme);
    await context.route('**/*',route=>{
      const url=route.request().url();
      /* The SDK is served from this origin now, so the stand-in must be matched BEFORE the origin check. */
      if(url.includes('/assets/js/vendor/supabase.js'))return route.fulfill({contentType:'text/javascript',body:`(${fixture.toString()})();`});
      if(url.startsWith(origin+'/'))return route.continue();
      return route.abort('blockedbyclient');
    });
    const page=await context.newPage();
    page.setDefaultTimeout(6000);
    page.on('pageerror',error=>results.push({error:error.message}));
    await page.goto(origin+url); await page.waitForTimeout(180);
    return page;
  }
  async function check(name,fn) { if(process.env.PIA_TEST_FILTER && !name.includes(process.env.PIA_TEST_FILTER))return; try {await fn();results.push({name,pass:true});}catch(e){results.push({name,pass:false,error:e.message});} }
  for(const width of [320,343,345,375,768,1280,1440])for(const theme of ['dark','light']) {
    await check(`responsive ${width} ${theme}`,async()=>{
      const page=await pageFor('/index.html',width,800,theme);
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'page overflow');
      await page.locator('#hero-cta [data-auth-open="signin"]').click();
      assert(await page.locator('#modal-signin').evaluate(el=>el.classList.contains('is-open')));
      const bounds=await page.locator('#modal-signin .modal').boundingBox();
      assert(bounds.x>=0&&bounds.x+bounds.width<=width+1,'dialog overflow');
      await page.locator('#modal-signin [data-auth-open="forgot"]').click();
      await page.locator('#fp-email').fill('fixture@example.test');
      await page.locator('#fp-submit').click();
      await page.waitForFunction(()=>document.querySelector('#fp-accepted').hidden===false);
      assert.equal(await page.locator('#fp-sent-to').textContent(),'fixture@example.test');
      await page.waitForTimeout(200); await page.screenshot({path:path.join(out,`recovery-${width}-${theme}.png`)});
      await page.locator('#modal-forgot [data-modal-close]').click();
      assert(await page.locator('#modal-signin').evaluate(el=>el.classList.contains('is-open')),'return context');
      await page.context().close();
    });
  }
  await check('request validation, failure, pending, late response, cooldown, rate limit',async()=>{
    const p=await pageFor();
    await p.locator('#hero-cta [data-auth-open="activate"]').click();
    await p.locator('#ac-submit').click();assert.equal(await p.locator('#ac-email').getAttribute('aria-invalid'),'true');
    await p.locator('#ac-email').fill('fixture@example.test');
    await p.evaluate(()=>fixture.result={message:'Network unavailable',status:0});
    await p.locator('#ac-submit').click();assert(await p.locator('#ac-accepted').isHidden());
    assert.equal(await p.locator('#ac-email').inputValue(),'fixture@example.test');
    await p.evaluate(()=>{fixture.result=null;fixture.delay=500;});
    await p.locator('#ac-submit').click();assert(await p.locator('#ac-submit').isDisabled());
    await p.locator('#modal-activate [data-modal-close]').click();
    await p.waitForTimeout(600);
    assert(await p.locator('#modal-activate').isHidden());
    await p.locator('#hero-cta [data-auth-open="activate"]').click();
    assert(await p.locator('#ac-accepted').isHidden(),'late response displayed');
    assert(await p.locator('#ac-submit').isDisabled(),'closing bypassed cooldown');
    await p.context().close();
    const q=await pageFor();
    await q.locator('#hero-cta [data-auth-open="activate"]').click();
    await q.locator('#ac-email').fill('fixture@example.test');
    await q.evaluate(()=>fixture.result={message:'Wait after 120 seconds',status:429});
    await q.locator('#ac-submit').click();assert.match(await q.locator('#ac-cooldown').textContent(),/1[12]\d seconds/);
    assert(await q.locator('#ac-accepted').isHidden());
    await q.context().close();
  });
  await check('accepted state survives reopening; changing email retains cooldown',async()=>{
    const p=await pageFor();await p.locator('#hero-cta [data-auth-open="activate"]').click();
    await p.locator('#ac-email').fill('fixture@example.test');await p.locator('#ac-submit').click();
    await p.waitForFunction(()=>!document.querySelector('#ac-accepted').hidden);
    await p.locator('#modal-activate [data-modal-close]').click();
    await p.locator('#hero-cta [data-auth-open="activate"]').click();assert(await p.locator('#ac-accepted').isVisible());
    await p.locator('#ac-change-email').click();assert(await p.locator('#ac-email').evaluate(el=>el===document.activeElement));
    assert(await p.locator('#ac-submit').isDisabled());
    const calls=await p.evaluate(()=>fixture.calls);assert.equal(calls.filter(c=>c.method==='activation').length,1);
    assert.equal(calls.find(c=>c.method==='activation').args.options.shouldCreateUser,false);
    await p.context().close();
  });
  await check('navbar full visibility, clipping, focus retention, menu actions',async()=>{
    const p=await pageFor('/index.html',1280,1000);
    await p.locator('#hero-cta').scrollIntoViewIfNeeded();await p.waitForTimeout(100);
    const full=await p.evaluate(()=>{const r=document.querySelector('#hero-cta').getBoundingClientRect();return r.top>=document.querySelector('#nav').getBoundingClientRect().bottom&&r.bottom<=innerHeight;});
    if(full) assert.equal(await p.locator('#nav').evaluate(el=>el.classList.contains('has-auth')),false);
    await p.evaluate(()=>{const r=document.querySelector('#hero-cta button').getBoundingClientRect();window.scrollBy(0,r.top-document.querySelector('#nav').getBoundingClientRect().bottom+8);});await p.waitForTimeout(100);
    assert(await p.locator('#nav').evaluate(el=>el.classList.contains('has-auth')),'clipped buttons must reveal nav');
    await p.locator('.nav-signin').focus();await p.evaluate(()=>window.scrollTo(0,0));await p.waitForTimeout(100);
    assert(await p.locator('.nav-signin').isVisible(),'focused nav action disappeared');
    await p.setViewportSize({width:343,height:650});await p.evaluate(()=>window.scrollTo(0,document.body.scrollHeight));await p.waitForTimeout(100);
    assert(await p.locator('.nav-signin').isVisible());await p.locator('#nav-burger').click();
    assert(await p.locator('.nav-menu-student [data-auth-open="activate"]').isVisible());
    await p.context().close();
  });
  await check('tutor keyboard and skip link',async()=>{
    const p=await pageFor();await p.locator('[data-skip]').focus();await p.keyboard.press('Enter');
    assert(await p.locator('#main').evaluate(el=>el===document.activeElement));
    await p.locator('#tab-pia-open').focus();await p.keyboard.press('ArrowRight');
    assert.equal(await p.locator('#tab-pia-conscientious').getAttribute('aria-selected'),'true');
    await p.locator('#tab-pia-neutral').click();assert(await p.locator('#panel-pia-neutral').isVisible());
    assert.equal((await p.evaluate(()=>fixture.calls)).length,0,'preview made service call');
    await p.context().close();
  });
  for(const role of ['student','teacher','admin'])await check(`signed in continuation ${role}`,async()=>{
    const p=await pageFor('/index.html?fixtureRole='+role);
    assert.match(await p.locator('#hero-cta [data-auth-open="signin"]').textContent(),/Continue/);
    assert(await p.locator('#hero-cta [data-auth-open="activate"]').isHidden());
    await p.route('**/'+(role==='student'?'student/html/waiting-room.html':role+'/html/'+role+'-dashboard.html'),route=>route.fulfill({contentType:'text/html',body:'<p>Isolated destination</p>'}));
    await p.locator('#hero-cta [data-auth-open="signin"]').click();await p.waitForURL('**/'+(role==='student'?'waiting-room.html':role+'-dashboard.html'));
    await p.context().close();
  });
  await check('untrusted mode cannot authorize cached session',async()=>{
    const p=await pageFor('/assets/html/sign-up.html?mode=reset&fixtureRole=student');
    assert(await p.locator('#setup-password-form').isHidden());assert(await p.locator('#setup-link-actions').isVisible());
    assert.equal((await p.evaluate(()=>fixture.calls)).filter(c=>c.method==='password').length,0);
    await p.context().close();
  });
  for(const mode of ['recovery','magiclink'])await check(`verified ${mode} setup and success`,async()=>{
    const p=await pageFor('/assets/html/sign-up.html#access_token=isolated-link&type='+mode,375,800);
    await p.locator('#setup-password').waitFor({state:'visible'});
    assert.equal(await p.locator('#setup-email').textContent(),'fixture@example.test');
    await p.locator('#setup-submit-btn').click();assert.equal(await p.locator('#setup-password').getAttribute('aria-invalid'),'true');
    await p.locator('#setup-password').fill('Example123');await p.locator('#setup-confirm-password').fill('Example123');
    await p.locator('#setup-submit-btn').click();await p.locator('#setup-signin').waitFor({state:'visible'});
    assert.deepEqual((await p.evaluate(()=>fixture.calls)).map(c=>c.method),['password','profile','signout']);
    await p.screenshot({path:path.join(out,`setup-${mode}.png`)});await p.context().close();
  });
  await check('partial save retries cleanup only; uncertain password saves cannot retry',async()=>{
    const p=await pageFor('/assets/html/sign-up.html#access_token=isolated-link&type=recovery');
    await p.locator('#setup-password').fill('Example123');await p.locator('#setup-confirm-password').fill('Example123');
    await p.evaluate(()=>fixture.profileError={status:503,message:'Unavailable'});await p.locator('#setup-submit-btn').click();
    assert(await p.locator('#setup-signin').isHidden());assert.match(await p.locator('#setup-submit-btn').textContent(),/Finish setup/);
    await p.evaluate(()=>fixture.profileError=null);await p.locator('#setup-submit-btn').click();await p.locator('#setup-signin').waitFor({state:'visible'});
    assert.equal((await p.evaluate(()=>fixture.calls)).filter(c=>c.method==='password').length,1);await p.context().close();
    const q=await pageFor('/assets/html/sign-up.html#access_token=isolated-link&type=recovery');
    await q.locator('#setup-password').fill('Example123');await q.locator('#setup-confirm-password').fill('Example123');
    await q.evaluate(()=>fixture.updateError={status:0,message:'Network error'});await q.locator('#setup-submit-btn').click();
    assert(await q.locator('#setup-submit-btn').isDisabled());assert(await q.locator('#setup-signin').isHidden());await q.context().close();
  });
  await check('expired and missing verification errors',async()=>{
    const p=await pageFor('/assets/html/sign-up.html#error=access_denied&error_code=otp_expired');
    assert.match(await p.locator('#setup-status-box').textContent(),/expired or was already used/);assert(await p.locator('#setup-password-form').isHidden());await p.context().close();
    const q=await pageFor('/assets/html/sign-up.html');assert(await q.locator('#setup-password-form').isHidden());await q.context().close();
  });
  await check('200 percent text size and short viewport',async()=>{
    const p=await pageFor('/index.html',375,480);await p.addStyleTag({content:'html { font-size: 200% !important; }'});
    await p.locator('#hero-cta [data-auth-open="signin"]').click();
    assert(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    await p.locator('#si-submit').scrollIntoViewIfNeeded();assert(await p.locator('#si-submit').isVisible());
    await p.screenshot({path:path.join(out,'text-zoom-200.png')});await p.context().close();
  });
  await check('temporary verification retry and invalid identity',async()=>{
    const p=await pageFor('/assets/html/sign-up.html#access_token=isolated-link&type=recovery',375,800,'dark',{userError:{status:503,message:'Unavailable'}});
    assert(await p.locator('#setup-password-form').isHidden());assert(await p.locator('#setup-retry').isVisible());
    assert.doesNotMatch(await p.locator('#setup-status-box').textContent(),/expired/);
    await p.evaluate(()=>fixture.userError=null);await p.locator('#setup-retry').click();await p.locator('#setup-password').waitFor({state:'visible'});await p.context().close();
    const q=await pageFor('/assets/html/sign-up.html#access_token=isolated-link&type=recovery',375,800,'light',{userError:{status:401,message:'Invalid token'}});
    assert(await q.locator('#setup-password-form').isHidden());assert(await q.locator('#setup-retry').isHidden());await q.context().close();
  });
  await check('token-hash exchange, wrong-purpose link and session changed before save',async()=>{
    const p=await pageFor('/assets/html/sign-up.html?token_hash=isolated-hash&type=recovery');
    assert(await p.locator('#setup-password').isVisible());assert.equal((await p.evaluate(()=>fixture.calls))[0].method,'verify');
    await p.locator('#setup-password').fill('Example123');await p.locator('#setup-confirm-password').fill('Example123');
    await p.evaluate(()=>fixture.session={access_token:'different',user:{id:'other',email:'other@example.test'}});await p.locator('#setup-submit-btn').click();
    assert(await p.locator('#setup-password-form').isHidden());assert.equal((await p.evaluate(()=>fixture.calls)).filter(c=>c.method==='password').length,0);await p.context().close();
    const q=await pageFor('/assets/html/sign-up.html?token_hash=isolated-hash&type=email');assert(await q.locator('#setup-password-form').isHidden());assert(await q.locator('#setup-link-actions').isVisible());await q.context().close();
  });
  await check('confirmed password failure preserves values; signout failure cannot show success',async()=>{
    const p=await pageFor('/assets/html/sign-up.html#access_token=isolated-link&type=recovery',375,800,'dark',{updateError:{status:422,code:'same_password'}});
    await p.locator('#setup-password').fill('Example123');await p.locator('#setup-confirm-password').fill('Example123');await p.locator('#setup-submit-btn').click();
    assert.equal(await p.locator('#setup-password').inputValue(),'Example123');assert(await p.locator('#setup-submit-btn').isEnabled());
    await p.evaluate(()=>{fixture.updateError=null;fixture.signoutError={status:503};});await p.locator('#setup-submit-btn').click();assert(await p.locator('#setup-signin').isHidden());
    await p.evaluate(()=>{fixture.signoutError=null;fixture.session=null;});await p.locator('#setup-submit-btn').click();await p.locator('#setup-signin').waitFor({state:'visible'});
    assert.equal((await p.evaluate(()=>fixture.calls)).filter(c=>c.method==='password').length,2);await p.context().close();
  });
  await check('long destination, resend failure, elapsed cooldown and keyboard dismissal',async()=>{
    const p=await pageFor('/index.html',320,620);await p.clock.install();
    await p.locator('#hero-cta [data-auth-open="signin"]').click();await p.locator('#modal-signin [data-auth-open="forgot"]').click();
    const email='very.long.student.name.for.wrapping.check@long-school-name.example.test';
    await p.locator('#fp-email').fill(email);await p.locator('#fp-submit').click();await p.waitForFunction(()=>!document.querySelector('#fp-accepted').hidden);
    assert(await p.locator('#fp-resend').isDisabled());await p.clock.fastForward(61000);assert(await p.locator('#fp-resend').isEnabled());
    await p.evaluate(()=>fixture.result={status:503,message:'Service down'});await p.locator('#fp-resend').click();assert(await p.locator('#fp-accepted').isVisible());assert.equal(await p.locator('#fp-sent-to').textContent(),email);
    assert(await p.locator('#modal-forgot .modal').evaluate(el=>el.scrollWidth<=el.clientWidth+1));
    await p.waitForFunction(()=>!document.querySelector('#fp-change-email').disabled);
    await p.locator('#modal-forgot [data-modal-close]').focus();await p.keyboard.press('Shift+Tab');assert(await p.locator('#fp-change-email').evaluate(el=>el===document.activeElement), await p.evaluate(()=>JSON.stringify({active:document.activeElement.outerHTML,buttons:[...document.querySelectorAll('#modal-forgot button')].map(b=>({id:b.id,disabled:b.disabled,visible:!!b.offsetParent,inert:b.inert}))})));
    await p.keyboard.press('Escape');assert(await p.locator('#modal-signin').evaluate(el=>el.classList.contains('is-open')));
    assert(await p.locator('#modal-signin [data-auth-open="forgot"]').evaluate(el=>el===document.activeElement));await p.keyboard.press('Escape');assert(await p.locator('#hero-cta [data-auth-open="signin"]').evaluate(el=>el===document.activeElement));
    await p.context().close();
  });
  for(const theme of ['dark','light'])await check('contrast and touch targets '+theme,async()=>{
    const p=await pageFor('/index.html',375,800,theme);await p.locator('#hero-cta [data-auth-open="signin"]').click();
    const checks=await p.evaluate(()=>{
      const canvas=document.createElement('canvas'),ctx=canvas.getContext('2d');canvas.width=canvas.height=1;
      function rgb(c){ctx.clearRect(0,0,1,1);ctx.fillStyle=c;ctx.fillRect(0,0,1,1);return [...ctx.getImageData(0,0,1,1).data];}
      function lum(c){let a=c.slice(0,3).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;});return .2126*a[0]+.7152*a[1]+.0722*a[2];}
      return ['#signin-title','#signin-sub','#modal-signin .label','#si-submit','#modal-signin .link-btn'].map(sel=>{
        const el=document.querySelector(sel),cs=getComputedStyle(el);let parent=el,bg;
        while(parent){bg=rgb(getComputedStyle(parent).backgroundColor);if(bg[3]===255)break;parent=parent.parentElement;}
        const a=lum(rgb(cs.color)),b=lum(bg);return {sel,ratio:(Math.max(a,b)+.05)/(Math.min(a,b)+.05)};
      });
    });
    for(const c of checks)assert(c.ratio>=4.5,JSON.stringify(c));
    for(const sel of ['#si-submit','#modal-signin .modal-close','#modal-signin .pw-toggle']){const r=await p.locator(sel).boundingBox();assert(r.width>=44&&r.height>=44,sel);}
    await p.context().close();
  });
  for(const [width,theme] of (process.env.PIA_TEST_FILTER ? [] : [[1280,'dark'],[375,'light']])) {const p=await pageFor('/index.html',width,900,theme);await p.screenshot({path:path.join(out,`homepage-${width}-${theme}.png`),fullPage:true});await p.context().close();}
  await browser.close();server.close();
  fs.writeFileSync(path.join(out,'results.json'),JSON.stringify(results,null,2));
  console.log(JSON.stringify(results,null,2));
  if(results.some(r=>r.pass===false||(!r.name&&r.error)))process.exitCode=1;
})().catch(error=>{console.error(error);server.close();process.exitCode=1;});
