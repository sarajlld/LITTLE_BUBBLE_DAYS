/* Little Bubble Days V18 — index-only 250ms dwell selection and independent pinch gameplay.
   NAVIGATION DETECTOR: 250ms index fingertip hover for ALL buttons and menus (except
   initial physical camera consent); name/age may additionally use mouse+keyboard.
   GAMEPLAY DETECTOR: thumb + index pinch for popping bubbles and growing giant bubble.
   One webcam, separate HandLandmarker models, separate gesture states and rates.
   All original image, palette, and scoring assets are kept unchanged.
*/
const $ = id => document.getElementById(id);
const world = $('world'), video = $('webcam'), canvas = $('gameCanvas'), ctx = canvas.getContext('2d');
const colors = ['#79c3e3', '#f49aaa', '#d0b1ed', '#a5d99c'];
const panels = ['permissionScreen','navigationScreen','storyScreen','profileScreen','memoryScreen','colorScreen','messageScreen','resultScreen'];
const random = (a,b) => a + Math.random()*(b-a);
const clamp = (n,a,b) => Math.min(b,Math.max(a,n));
const dist = (a,b) => Math.hypot(a.x-b.x,a.y-b.y);
let W=innerWidth,H=innerHeight,ratio=1,lastFrame=0;
let stream=null,visionLib=null,soundContext=null,delayed=0;
const HISTORY_KEY='little-bubble-days-v11-best-scores';
let virtualClick=false; // index-finger dwell or physical mouse triggers UI; pinch is reserved for game objects
let gameVisualSeconds=0;

const state = {
  phase:'permission', camera:false,loadingCamera:false,paused:false,preGameNavigation:true,name:'',age:7,
  selectedColor:colors[0],score:0,total:0,scores:{my:0,reverse:0},correct:0,remaining:20,
  soap:{x:0,y:0,active:0},
  balls:[],particles:[],spawnTime:0,lastPop:0,hoverBall:null,
  hand:{visible:false,x:0,y:0,target:{x:0,y:0},cover:{x:0,y:0},rawCenter:null,shape:null,seenAt:0,
        gap:2,pinch:false,pinchCandidate:false,pinchCount:0,v:false,
        thumb:{x:0,y:0},index:{x:0,y:0},thumbTarget:null,indexTarget:null,
        tipSeenAt:0},
  giantStep:0,giantArmed:false,giantLast:0,giantTime:30,demo:null,guideUntil:0,randomColor:false,
  startedAnyStage:false,rewinding:false,
  speed:55,sensitivity:70,pastelTint:14,bubbleDensity:100,sound:true
};

/* Sensor 1 owns the only on-screen UI pointer; it NEVER generates game pops.
   Sensor 2 owns thumb-index gameplay events and NEVER presses UI buttons. */
// Dwell selection: one click after 250ms on a stable button, then require
// a deliberate finger move (35px) before another click can be generated.
const NAV_DWELL_MS=250;
const NAV_REARM_MOVE_PX=35;
const navSensor={visible:false,rawCenter:null,seenAt:0,index:{x:0,y:0},indexTarget:null,
  holdTarget:null,holdSince:0,holdProgress:0,
  clickAnchor:null};
const sensors={
  navigation:{name:'navigation',instance:null,promise:null,delegate:'GPU',rebuilding:false,errors:0,lastDetect:0,lastVideoTime:-1},
  gameplay:{name:'gameplay',instance:null,promise:null,delegate:'GPU',rebuilding:false,errors:0,lastDetect:0,lastVideoTime:-1}
};

// Avoid a detected pinch leaking across stages, messages or the tutorial.
let inputLockUntil=0;
function lockInput(ms=220){
  inputLockUntil=performance.now()+ms;
  handInput.pinchAt=0;handInput.releaseAt=0;
  navSensor.holdTarget=null;navSensor.holdSince=0;navSensor.holdProgress=0;
  // Keep clickAnchor through a screen transition: staying over the same spot
  // must not auto-click the next screen's button by accident.
}
function only(id){for(const name of panels)$(name).hidden = name!==id;lockInput();}
function phase(name){state.phase=name;scene();lockInput();}
function scene(){
  const mapping={soap:'soap','soap-vanish':'soap',my:'my',reverse:'reverse',giant:'giant',burst:'giant',result:'giant'};
  world.dataset.scene=mapping[state.phase]||'illustration';
  $('homeResetBtn').hidden=!state.startedAnyStage;
}
function fit(){
  W=world.clientWidth||innerWidth;H=world.clientHeight||innerHeight;
  ratio=Math.min(2,devicePixelRatio||1);
  canvas.width=Math.round(W*ratio);canvas.height=Math.round(H*ratio);ctx.setTransform(ratio,0,0,ratio,0,0)
}
new ResizeObserver(fit).observe(world);fit();
function delay(ms,fn){const t=++delayed;setTimeout(()=>{if(t===delayed)fn();},ms)}

function audioNote(freq=560,len=.11,volume=.027){
  if(!state.sound)return;
  try{
    soundContext ||= new (window.AudioContext||window.webkitAudioContext)();
    if(soundContext.state==='suspended')soundContext.resume();
    const t=soundContext.currentTime,osc=soundContext.createOscillator(),vol=soundContext.createGain();
    osc.type='sine';osc.frequency.setValueAtTime(freq,t);osc.frequency.exponentialRampToValueAtTime(Math.max(130,freq*.54),t+len);
    vol.gain.setValueAtTime(.0001,t);vol.gain.exponentialRampToValueAtTime(volume,t+.012);
    vol.gain.exponentialRampToValueAtTime(.0001,t+len);
    osc.connect(vol).connect(soundContext.destination);osc.start(t);osc.stop(t+len+.02);
  }catch(error){console.info('소리를 재생하지 못했어요.',error)}
}
const clickSounds = Array.from({length:5},()=>{
  const sound=new Audio('./assets/button-bloop.wav');
  sound.preload='auto';sound.volume=.85;
  return sound;
});
let nextClickSound=0;
function buttonBloop(force=false){
  if(!force&&!state.sound)return;
  const sound=clickSounds[nextClickSound++ % clickSounds.length];
  try{
    sound.pause();sound.currentTime=0;
    const playback=sound.play();
    if(playback?.catch)playback.catch(()=>audioNote(650,.20,.10));
  }catch(error){audioNote(650,.20,.10)}
}
document.addEventListener('click',event=>{
  const button=event.target.closest('button');if(!button||button.disabled)return;
  buttonBloop(button.id==='soundToggle'&&!state.sound);
  button.classList.remove('clicked');void button.offsetWidth;button.classList.add('clicked');
  setTimeout(()=>button.classList.remove('clicked'),190);
},true);
let toastTimer;
function toast(text){clearTimeout(toastTimer);const el=$('toast');el.textContent=text;el.classList.add('show');toastTimer=setTimeout(()=>el.classList.remove('show'),1700)}
function fitSentences(){
  for(const el of document.querySelectorAll('.layer:not([hidden]) .sentence')){
    el.style.fontSize='';
    const parent=el.closest('.paper-box');if(!parent)continue;
    const boxStyle=getComputedStyle(parent);
    const max=parent.clientWidth-parseFloat(boxStyle.paddingLeft)-parseFloat(boxStyle.paddingRight)-4;
    let n=parseFloat(getComputedStyle(el).fontSize);
    const range=document.createRange();range.selectNodeContents(el);
    while(range.getBoundingClientRect().width>max && n>11){
      n-=.5;el.style.fontSize=n+'px';
    }
  }
}
function refreshLayout(){requestAnimationFrame(()=>requestAnimationFrame(fitSentences))}
// The messages can display the PINCH-only instruction or the giant-bubble example.
function showMessage(title,lines,label,next,demo=null){
  phase('message');$('messageTitle').textContent=title;
  $('messageBody').replaceChildren();
  for(const line of (Array.isArray(lines)?lines:[lines])){
    const p=document.createElement('p');p.className='sentence';p.textContent=line;$('messageBody').append(p);
  }
  state.demo=demo;$('gestureDemo').hidden=!demo;
  const continueButton = $('messageContinue');
  continueButton.textContent = label;
  continueButton.onclick = typeof next === 'function' ? next : null;
  continueButton.disabled = typeof next !== 'function';
  only('messageScreen');refreshLayout();
}
function setPlayVisible(show){$('playScreen').hidden=!show;if(!show)hideHUD()}
function hideHUD(){for(const id of ['scoreHud','timerHud','gameHint','activeControls','runHistory'])$(id).hidden=true;state.paused=false;$('pausedOverlay').hidden=true}
function stageHUD(name){$('stageName').textContent=name;$('scoreValue').textContent=String(state.score);$('timeValue').textContent=String(Math.ceil(state.remaining));$('scoreHud').hidden=false;$('timerHud').hidden=false}

/* ---------- PERSISTENT BEST SCORES (browser localStorage) ---------- */
function allRecords(){
  try{
    const data=JSON.parse(localStorage.getItem(HISTORY_KEY)||'[]');
    return Array.isArray(data)?data.filter(r=>r&&typeof r.name==='string'&&Number.isFinite(r.score)):[];
  }catch{return []}
}
function saveRecord(){
  if(!state.name.trim())return;
  const records=allRecords(),key=state.name.trim().toLocaleLowerCase();
  const match=records.find(r=>r.name.trim().toLocaleLowerCase()===key);
  if(match){
    if(state.total>match.score){match.score=state.total;match.name=state.name.trim()}
  }else records.push({name:state.name.trim(),score:state.total});
  records.sort((a,b)=>b.score-a.score||a.name.localeCompare(b.name));
  try{localStorage.setItem(HISTORY_KEY,JSON.stringify(records))}catch(error){console.warn('기록을 저장하지 못했어요.',error)}
  showRecords();
}
function showRecords(){
  const list=$('recordEntries');list.replaceChildren();
  const records=allRecords().sort((a,b)=>b.score-a.score||a.name.localeCompare(b.name));
  if(!records.length){
    const empty=document.createElement('p');empty.className='record-empty';empty.textContent='아직 기록이 없어요';list.append(empty);
  }
  for(const [rank,entry] of records.slice(0,6).entries()){
    const line=document.createElement('div');line.className='record-entry';
    const name=document.createElement('span');name.textContent=entry.name;name.title=entry.name;
    if(rank<3){const medal=document.createElement('span');medal.className='record-star '+['gold','silver','bronze'][rank];medal.textContent='★';medal.setAttribute('aria-label',`${rank+1}위`);line.append(medal);}
    const score=document.createElement('strong');score.textContent=String(entry.score);
    line.append(name,score);list.append(line);
  }
  if(records.length>6){const more=document.createElement('small');more.textContent=`외 ${records.length-6}명`;list.append(more)}
}

/* ---------- PAUSE / PLAY / RESTART (from first active game onwards) ---------- */
function syncPlayControls(){
  $('backStageBtn').disabled=state.phase==='my';
  $('pauseBtn').disabled=state.paused;
  $('playBtn').disabled=!state.paused;
  $('pausedOverlay').hidden=!state.paused;
}
function pauseGame(){
  if(!['my','reverse','giant'].includes(state.phase)||state.paused||state.rewinding)return;
  state.paused=true;if(state.phase==='giant'){state.giantArmed=false;giantHint()}syncPlayControls();lockInput(180);
}
function playGame(){
  if(!state.paused||state.rewinding)return;
  state.paused=false;syncPlayControls();lockInput(600);
}
function restartStage(){
  if(!['my','reverse','giant'].includes(state.phase)||state.rewinding)return;
  const current=state.phase;
  state.paused=false;
  state.particles=[];state.balls=[];
  lockInput(650);
  if(current==='giant')startGiant();else startRound(current,{tutorial:false});
  syncPlayControls();
}
$('pauseBtn').addEventListener('click',pauseGame);
$('playBtn').addEventListener('click',playGame);
$('restartBtn').addEventListener('click',restartStage);
// Shared three-second bubble/blur transition: previous stage and all exit/restart buttons.
// The visual is identical for every transition. UI and gameplay inputs are locked.
function populateBackTransition(){
  const layer=$('backTransitionBubbles');layer.replaceChildren();
  for(let i=0;i<46;i++){
    const b=document.createElement('span');b.className='rewind-bubble';
    const x=random(4,96),y=random(15,93),size=random(25,112);
    b.style.left=x+'%';b.style.top=y+'%';
    b.style.width=size+'px';b.style.height=size+'px';
    b.style.setProperty('--bubble-dx',random(-170,170)+'px');
    b.style.setProperty('--bubble-dy',random(-210,-25)+'px');
    b.style.animationDelay=random(0,.95).toFixed(2)+'s';
    b.style.animationDuration=random(1.5,2.4).toFixed(2)+'s';
    layer.append(b);
  }
}
function showBubbleTransition(message, after){
  if(state.rewinding)return false;
  state.rewinding=true;
  state.paused=true; // stop time, bubbles, Pinch actions during the 3-second overlay
  lockInput(3500);
  syncPlayControls();
  $('pausedOverlay').hidden=true;
  $('backTransition').hidden=false;
  $('backTransitionMessage').textContent=message;
  populateBackTransition();
  delay(3000,()=>{
    $('backTransition').hidden=true;
    $('backTransitionBubbles').replaceChildren();
    state.rewinding=false;
    state.paused=false;
    after();
    // Stop an old hover/pinch from activating an overlapping new screen.
    lockInput(550);
  });
  return true;
}
function backStage(){
  const current=state.phase;
  if(!['reverse','giant'].includes(current))return;
  showBubbleTransition('이전 단계로 돌아가고 있어요...',()=>{
    state.particles=[];
    state.balls=[];
    if(current==='reverse'){
      state.scores.my=0;state.scores.reverse=0;state.total=0;
      startRound('my',{tutorial:false});
    }else{
      state.scores.reverse=0;state.total=state.scores.my;
      startRound('reverse',{tutorial:false});
    }
  });
}
$('backStageBtn').addEventListener('click',backStage);

// "집으로 들어가기" returns to the finger-selection tutorial WITHOUT reloading
// the page or requesting the camera permission again. MediaPipe/webcam stay on.
function resetToNavigationGuide(){
  ++delayed; // cancel any older delayed stage/message actions
  state.particles=[];state.balls=[];state.scores={my:0,reverse:0};
  state.total=0;state.score=0;state.remaining=20;state.correct=0;
  state.giantStep=0;state.giantArmed=false;state.giantTime=30;
  state.guideUntil=0;state.demo=null;state.hoverBall=null;
  state.startedAnyStage=false;state.preGameNavigation=true;
  state.randomColor=false;state.selectedColor=colors[0];
  state.name='';state.age=7;
  $('playerName').value='';$('playerAge').value='';
  $('gestureGuide').hidden=true;$('pausedOverlay').hidden=true;
  $('extraColors').hidden=true;
  $('customColorButton').classList.remove('selected');
  $('randomColorButton').classList.remove('selected');
  document.querySelectorAll('.color-chip[data-color]').forEach(el=>el.classList.toggle('selected',el.dataset.color.toLowerCase()===colors[0]));
  drawPreview();
  setPlayVisible(false);
  goNavigationGuide();
}
function replayFromSoap(){
  ++delayed;
  state.particles=[];state.balls=[];state.scores={my:0,reverse:0};
  state.score=0;state.total=0;state.correct=0;state.giantStep=0;
  state.guideUntil=0;state.startedAnyStage=false;
  $('gestureGuide').hidden=true;
  startSoap(); // same player/profile, begin again at soap and then color choice
}
$('homeResetBtn').addEventListener('click',()=>{
  showBubbleTransition('처음으로 돌아가고 있어요...',resetToNavigationGuide);
});


/* Every button accepts both real mouse clicks and sensor-1 index dwell clicks. */

/* ---------- TWO MediaPipe Hand Landmarkers / one shared camera ----------
   A separate model is created for each sensor and frames are processed at separate
   cadences. The navigation model does dwell selection; the gameplay model
   independently detects pinch. Running navigation less often in active
   gameplay keeps frame rates higher. Uses the official Google Tasks Vision API.
*/
const MP_VERSION='0.10.32';
const MODEL_URL='https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
let fileset=null;
async function createModel(delegate,kind){
  visionLib ||= await import(`https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}/+esm`);
  fileset ||= await visionLib.FilesetResolver.forVisionTasks(`https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}/wasm`);
  const isNavigation=kind==='navigation';
  return visionLib.HandLandmarker.createFromOptions(fileset,{
    baseOptions:{modelAssetPath:MODEL_URL,delegate},runningMode:'VIDEO',numHands:1,
    minHandDetectionConfidence:isNavigation?.48:.5,
    minHandPresenceConfidence:isNavigation?.48:.5,
    minTrackingConfidence:isNavigation?.44:.52
  });
}
function ensureSensor(kind){
  const s=sensors[kind];
  if(!s.promise){
    s.promise=(async()=>{
      try{s.instance=await createModel('GPU',kind);s.delegate='GPU'}
      catch(error){console.warn(`${kind}: GPU 연결 실패, CPU 사용`,error);
        s.instance=await createModel('CPU',kind);s.delegate='CPU'}
      return s.instance;
    })();
    s.promise.catch(()=>{s.promise=null});
  }
  return s.promise;
}
async function loadModel(){
  // Separate instances are initialized serially, preventing GPU startup races.
  await ensureSensor('navigation');
  await ensureSensor('gameplay');
  return true;
}
loadModel().catch(error=>console.warn('손 인식 준비를 다시 시도합니다.',error));
async function rebuildOnCPU(kind){
  const s=sensors[kind];
  if(s.rebuilding||s.delegate==='CPU')return;
  s.rebuilding=true;
  try{const replacement=await createModel('CPU',kind);
    try{s.instance?.close()}catch{}
    s.instance=replacement;s.delegate='CPU';s.errors=0;
  }catch(error){console.error(`${kind} detector rebuild failed`,error)}
  finally{s.rebuilding=false}
}

// Camera permission always requires the physical initial click; then index-only UI navigation begins.
$('allowCamera').addEventListener('click',startCamera);
function goStory(){phase('story');only('storyScreen');refreshLayout()}
function goNavigationGuide(){
  phase('navigation');only('navigationScreen');refreshLayout();
}
$('navGuideContinue').addEventListener('click',goStory);
async function startCamera(){
  if(state.camera){goNavigationGuide();return}
  if(state.loadingCamera)return;
  state.loadingCamera=true;$('allowCamera').disabled=true;
  $('allowCamera').textContent='카메라를 연결하고 있어요...';$('cameraWarning').hidden=true;
  let step='camera';
  try{
    if(!navigator.mediaDevices?.getUserMedia)throw new Error('보안 연결(HTTPS 또는 localhost)에서 열어 주세요.');
    stream=await navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:'user',width:{ideal:1280},height:{ideal:720},frameRate:{ideal:30}}});
    video.srcObject=stream;await video.play();
    step='model';$('allowCamera').textContent='손 인식을 준비하고 있어요...';
    await loadModel();
    state.camera=true;video.classList.add('on');
    goNavigationGuide();
  }catch(error){
    console.error(error);
    $('cameraWarning').hidden=false;
    $('cameraWarning').textContent=step==='model'
      ?'손 인식을 불러오지 못했어요. 인터넷 연결을 확인하고 다시 눌러 주세요.'
      :error?.name==='NotAllowedError'?'카메라 권한이 꺼져 있어요. 주소창의 카메라 아이콘에서 허용해 주세요.'
      :'카메라 연결에 실패했어요. 권한과 인터넷 연결을 확인해 주세요.';
    stream?.getTracks().forEach(track=>track.stop());stream=null;video.srcObject=null;
    refreshLayout();
  }finally{state.loadingCamera=false;$('allowCamera').disabled=false;if(!state.camera)$('allowCamera').textContent='카메라 허용하기'}
}
$('storyStart').addEventListener('click',()=>{phase('profile');only('profileScreen');refreshLayout()});
$('playerAge').addEventListener('input',e=>e.target.value=e.target.value.replace(/[^0-9]/g,'').slice(0,2));
$('profileForm').addEventListener('submit',e=>{
  e.preventDefault();const name=$('playerName').value.trim(),ageText=$('playerAge').value.trim(),age=Number(ageText);
  if(!name||!ageText){toast('먼저 이름과 나이를 입력해 주세요.');return}
  if(!Number.isInteger(age)||age<1||age>10){toast('나이는 1살부터 10살까지 입력해 주세요.');return}
  state.name=name;state.age=age;document.activeElement?.blur?.();
  phase('transition');$('memoryText').textContent=`${playerLabel()}의 어린 시절로 들어가고 있어요...`;
  only('memoryScreen');refreshLayout();delay(2600,startSoap);
});
function playerLabel(){return `${state.age}살 ${state.name}`}

/* ---------- SOAP ---------- */
function startSoap(){
  state.preGameNavigation=true;
  phase('soap');setPlayVisible(true);only('');hideHUD();
  $('soap').hidden=false;$('soap').classList.remove('vanish');$('soapMeter').hidden=true;
  state.soap={x:W*.45,y:H*.44,active:0};
  state.balls=[];state.particles=[];moveSoap(state.soap.x,state.soap.y);
  $('soapPercent').textContent='0%';$('soapFill').style.width='0%';
}
function moveSoap(x,y){
  state.soap.x=clamp(x,70,W-70);state.soap.y=clamp(y,115,H*.72);
  $('soap').style.left=state.soap.x+'px';$('soap').style.top=state.soap.y+'px';
}
function tinyFoam(x,y,n=3,pop=false){
  for(let i=0;i<n;i++){
    const t=random(.5,1.3),a=random(0,Math.PI*2),speed=pop?random(30,160):random(10,50);
    state.particles.push({kind:'foam',x:x+random(-16,16),y:y+(pop?0:random(20,40)),vx:Math.cos(a)*speed,vy:pop?Math.sin(a)*speed:random(-55,-10),r:(!pop&&state.phase==='soap')?random(4,14):random(2,7),life:t,maxLife:t,rot:0});
  }
}
function moveSoapWithHand(pt,dt){
  if(state.phase!=='soap')return;
  const last={...state.soap};
  const alpha=clamp(dt*15,.18,.55);
  const x=last.x+(pt.x-last.x)*alpha,y=last.y+(pt.y-last.y)*alpha;
  moveSoap(x,y);
  const moved=dist(last,state.soap);
  if(moved>2.7){
    $('soapMeter').hidden=false;tinyFoam(x,y,4);state.soap.active=Math.min(3,state.soap.active+dt);
  }else state.soap.active=Math.max(0,state.soap.active-dt*.08);
  const percentage=clamp(state.soap.active/3*100,0,100);
  $('soapPercent').textContent=Math.round(percentage)+'%';$('soapFill').style.width=percentage+'%';
  if(state.soap.active>=3)finishSoap();
}
function finishSoap(){
  if(state.phase!=='soap')return;
  phase('soap-vanish');$('soapMeter').hidden=true;$('soap').classList.add('vanish');audioNote(590,.22);
  delay(950,()=>{$('soap').hidden=true;phase('color');only('colorScreen');drawPreview();refreshLayout()});
}

/* ---------- Bubble art ---------- */
const bubbleArt=new Image();bubbleArt.src='./assets/Bubble1.png';
const coloredImages=new Map();
function bubbleSprite(hex){
  const key=hex.toLowerCase();if(coloredImages.has(key))return coloredImages.get(key);
  const c=document.createElement('canvas');c.width=c.height=256;
  const g=c.getContext('2d',{willReadFrequently:true});
  if(bubbleArt.complete&&bubbleArt.naturalWidth){
    g.drawImage(bubbleArt,0,0,256,256);
    const image=g.getImageData(0,0,256,256),p=image.data;
    const rgb=[1,3,5].map((_,i)=>parseInt(hex.slice(1+i*2,3+i*2),16));
    for(let i=0;i<p.length;i+=4){
      if(p[i+3]===0)continue;
      const luminance=p[i]*.2126+p[i+1]*.7152+p[i+2]*.0722;
      const pigment=clamp((252-luminance)/35,0,.88);
      for(let k=0;k<3;k++)p[i+k]=Math.round(p[i+k]*(1-pigment)+rgb[k]*pigment);
    }
    g.putImageData(image,0,0);
  }else{
    g.strokeStyle=hex;g.lineWidth=14;
    g.beginPath();g.arc(128,128,108,0,Math.PI*2);g.stroke();
    return c; // not cached: recolor the real artwork once it has loaded
  }
  coloredImages.set(key,c);return c;
}
bubbleArt.addEventListener('load',()=>{coloredImages.clear();drawPreview()});
const previewCtx=$('bubblePreviewCanvas').getContext('2d');
function drawPreview(){
  previewCtx.clearRect(0,0,320,320);
  const hide=state.randomColor&&state.phase==='color';
  $('bubblePreviewCanvas').hidden=hide;
  $('bubblePreviewFloat').hidden=hide;
  $('randomPreviewPlaceholder').hidden=!hide;
  if(!hide)previewCtx.drawImage(bubbleSprite(state.selectedColor),0,0,320,320);
}
function setColor(value){
  state.selectedColor=value;
  for(const chip of document.querySelectorAll('.color-chip[data-color]'))chip.classList.toggle('selected',chip.dataset.color.toLowerCase()===value.toLowerCase());
  drawPreview();
}
for(const chip of document.querySelectorAll('.color-chip[data-color]'))chip.addEventListener('click',()=>{
  state.randomColor=false;$('randomColorButton').classList.remove('selected');
  setColor(chip.dataset.color);$('customColorButton').classList.remove('selected');$('extraColors').hidden=true;
});
$('customColorButton').addEventListener('click',()=>{$('extraColors').hidden=!$('extraColors').hidden;refreshLayout()});
for(const chip of document.querySelectorAll('.extra-color'))chip.addEventListener('click',()=>{
  state.randomColor=false;$('randomColorButton').classList.remove('selected');
  setColor(chip.dataset.color);$('customColorButton').classList.add('selected');$('extraColors').hidden=true;
});
const RANDOM_PALETTE=[...colors,...Array.from(document.querySelectorAll('.extra-color'),el=>el.dataset.color)];
$('randomColorButton').addEventListener('click',()=>{
  // Deliberately do not draw or even choose the random color yet: reveal only after confirmation.
  state.randomColor=true;
  document.querySelectorAll('.color-chip[data-color]').forEach(chip=>chip.classList.remove('selected'));
  $('customColorButton').classList.remove('selected');$('randomColorButton').classList.add('selected');
  $('extraColors').hidden=true;
  drawPreview();
});
function showStartPrompt(){
  showMessage('내 비눗방울 놀이',[
    `이제 ${playerLabel()}! 네 비눗방울을 터뜨리고 점수를 모아 봐요!`,
    '비눗방울 위에서 엄지와 검지를 붙여 터뜨려 보세요!'
  ],'놀이 시작하기',()=>startRound('my'),'pinch');
}
$('chooseColor').addEventListener('click',()=>{
  if(state.randomColor){
    const choice=RANDOM_PALETTE[Math.floor(Math.random()*RANDOM_PALETTE.length)];
    state.selectedColor=choice;
    showMessage('랜덤 색깔이 나왔어요!',[
      `${playerLabel()}의 비눗방울은 이 색깔이에요!`,
      '이제 이 색깔의 비눗방울을 터뜨려 보세요!'
    ],'확인하고 시작하기',showStartPrompt,'random-reveal');
  }else showStartPrompt();
});
drawPreview();

/* ---------- ROUNDS: unlimited scores until 20-second timeout. ---------- */
const REVERSE_RATIOS={special:.25,forbidden:.35,other:.40};
function chooseSpecialShape(){
  const n=Math.random();
  return n<.50?'star':n<.80?'heart':'bunny'; // star 50%, heart 30%, bunny 20%
}
function spawnBubble(){
  if(state.balls.length>=95)return;
  const my=state.phase==='my',roll=Math.random();
  const kind=my?(roll<.80?'target':'other')
    :(roll<REVERSE_RATIOS.special?'special':roll<REVERSE_RATIOS.special+REVERSE_RATIOS.forbidden?'forbidden':'other');
  let color=state.selectedColor;
  if(kind==='special')color='#a6d7ed';
  if(kind==='other'){
    const others=colors.filter(c=>c.toLowerCase()!==state.selectedColor.toLowerCase());
    color=others[Math.floor(Math.random()*others.length)];
  }
  const shape=kind==='special'?chooseSpecialShape():null;
  const sizeMultiplier=kind==='special'?random(1.10,1.23):1;
  const r=random(36,58)*sizeMultiplier,x=random(r+7,Math.max(r+8,W-r-8));
  const baseSpeed=random(82,128)*(.71+state.speed/95);
  // Stage 2 remains at 0.75x stage 1 (the previously approved slowed reverse stage).
  const speed=baseSpeed*(my?1:.75);
  state.balls.push({x,baseX:x,y:-r-random(0,90),r,age:0,seed:random(0,7),speed,kind,color,shape,settled:false});
}
function beginGestureGuide(){
  const guide=$('gestureGuide');
  state.guideUntil=3500; // ONLY the 3.5s on-screen explanation; gameplay timer waits.
  guide.hidden=false;
  $('guideProgress').style.width='0%';
  lockInput(3800);
}
function finishGestureGuide(){
  // V11 bug: guideUntil became <=0 just before this function was called, so the
  // previous `if(!state.guideUntil)return` prevented the overlay from closing.
  // Hidden state is the source of truth; always dismiss even when remaining == 0.
  if($('gestureGuide').hidden)return;
  state.guideUntil=0;
  $('gestureGuide').hidden=true;
  $('guideProgress').style.width='100%';
  state.spawnTime=.12;
  lockInput(350); // no stale tutorial pinch can trigger a pop
}
function startRound(mode,{tutorial=true}={}){
  if(mode==='my'){state.preGameNavigation=false;state.startedAnyStage=true;}
  setPlayVisible(true);phase(mode);state.score=0;state.correct=0;state.remaining=20;state.balls=[];state.particles=[];
  state.spawnTime=.1;state.lastPop=0;state.hoverBall=null;state.guideUntil=0;
  $('gestureGuide').hidden=true;
  for(let j=0;j<7;j++){
    spawnBubble();const b=state.balls[state.balls.length-1];
    if(b){b.y=random(-b.r,H*.39);b.age=random(0,3)}
  }
  $('activeControls').hidden=false;$('runHistory').hidden=false;showRecords();state.paused=false;syncPlayControls();$('gameHint').hidden=false;only('');
  $('gameHint').textContent=mode==='my'
    ?'엄지와 검지를 붙여 비눗방울을 터뜨려요!'
    :'특별한 모양 +10점 · 내 색 -10점 · 다른 색 0점';
  stageHUD(mode==='my'?'내 비눗방울':'반대로 놀이');
  if(mode==='my'&&tutorial)beginGestureGuide();
}
function bubbleSupport(b){
  let limit=H-b.r-3;
  for(const other of state.balls){
    if(other===b||!other.settled)continue;
    const dx=b.x-other.x,rad=b.r+other.r-1;
    if(Math.abs(dx)>=rad)continue;
    const boundary=other.y-Math.sqrt(Math.max(0,rad*rad-dx*dx));
    if(b.y<=other.y&&boundary<limit)limit=boundary;
  }
  return limit;
}
function updateBubbles(dt){
  for(const b of state.balls){
    if(b.settled)continue;
    b.age+=dt;
    if(state.phase==='my')b.x=clamp(b.baseX+Math.sin(b.age*1.18+b.seed)*12,b.r,W-b.r);
    else b.x=clamp(b.baseX+Math.sin(b.age*1.4+b.seed)*20,b.r,W-b.r);
    const next=b.y+b.speed*dt;
    if(state.phase==='my'){
      const floor=bubbleSupport(b);
      if(next>=floor){b.y=floor;b.settled=true;}
      else b.y=next;
    }else{b.y=next;}
  }
  if(state.phase==='reverse')state.balls=state.balls.filter(b=>b.y<H+b.r+10);
}
function tinyExplosion(x,y,n=23){tinyFoam(x,y,n,true)}
function bubbleShower(x,y,n=24,fullScreen=false){
  for(let i=0;i<n;i++){
    const a=random(0,Math.PI*2),speed=fullScreen?random(115,660):random(65,230);
    const life=fullScreen?random(2.7,5.5):random(.65,1.7);
    const sx=fullScreen&&i%4===0?random(0,W):x;
    const sy=fullScreen&&i%4===0?random(0,H):y;
    state.particles.push({kind:'foam',x:sx,y:sy,
      vx:Math.cos(a)*speed,vy:Math.sin(a)*speed-(fullScreen?random(60,180):35),
      r:fullScreen?random(4,19):random(3,11),life,maxLife:life,rot:0});
  }
}
// Only the midpoint of the thumb and index fingertip can pop a bubble.
function bubbleUnderHand(){
  const h=state.hand;
  if(!h.visible||!h.pinchPoint)return null;
  const at=h.pinchPoint;
  let nearest=null,best=Infinity;
  for(const bubble of state.balls){
    const d=dist(at,bubble);
    const reach=bubble.r*1.15+10+state.sensitivity*.10;
    if(d<reach&&d<best){nearest=bubble;best=d}
  }
  return nearest;
}
function popBall(b,now){
  if(!['my','reverse'].includes(state.phase)||now-state.lastPop<75)return false;
  const i=state.balls.indexOf(b);if(i<0)return false;
  state.balls.splice(i,1);state.lastPop=now;state.hoverBall=null;
  let points=0;
  if(state.phase==='my'){
    if(b.kind==='target'){state.correct++;points=state.correct<=6?5:10}else points=-5;
  }else if(b.kind==='special')points=10;
  else if(b.kind==='forbidden')points=-10;
  state.score=Math.max(0,state.score+points);$('scoreValue').textContent=String(state.score);
  tinyExplosion(b.x,b.y,23);audioNote(points>=0?720:270,.09);
  if(points>0)toast(`+${points}점!`);else if(points<0)toast(`${points}점`);
  else toast('특별한 모양의 비눗방울을 찾아 주세요.');
  return true;
}
function endRound(mode){
  if(state.phase!==mode)return;
  state.scores[mode]=state.score;state.total=state.scores.my+state.scores.reverse;
  phase('between');state.balls=[];hideHUD();
  if(mode==='my')showMessage('이제 모든 게 반대예요!',[
    `잘했어요, ${playerLabel()}!`,
    '이번에는 네 색깔 비눗방울을 터뜨리면 안 돼요.',
    '네 색깔을 터뜨리면 10점을 잃어요.',
    '다른 색 비눗방울은 점수가 변하지 않아요.',
    '별, 하트, 토끼 모양의 특별한 비눗방울은 10점을 얻어요!'
  ],'다음 단계',()=>startRound('reverse'),null);
  else showMessage('마지막 단계로 가 볼까요?',[
    `이건 ${playerLabel()}가 터뜨릴 가장 큰 비눗방울이에요.`,
    '엄지와 검지를 붙였다가 쫙 벌리면 비눗방울이 커져요.',
    '다섯 번 키우면 펑 터져요!'
  ],'큰 비눗방울 만나기',startGiant,'spread');
}

/* ---------- GIANT: five thumb-index pinch → finger spread cycles ---------- */
function giantRadius(){return Math.min(W,H)*(.082+state.giantStep*.074)}
function giantHint(){
  $('gameHint').textContent=state.giantArmed
    ?`좋아요! 이제 손가락을 쫙 벌려 주세요! (${state.giantStep} / 5)`
    :`엄지와 검지를 붙였다가 쫙 벌려 주세요! (${state.giantStep} / 5)`;
}
function startGiant(){setPlayVisible(true);phase('giant');only('');state.balls=[];state.particles=[];state.giantStep=0;state.giantArmed=false;state.giantLast=0;state.giantTime=30;
  $('activeControls').hidden=false;$('runHistory').hidden=false;showRecords();state.paused=false;syncPlayControls();$('scoreHud').hidden=true;$('timerHud').hidden=false;$('timeValue').textContent='30';
  $('gameHint').hidden=false;giantHint();
}
function growGiant(now){
  if(state.phase!=='giant'||now-state.giantLast<300)return;
  state.giantLast=now;state.giantStep++;audioNote(410+state.giantStep*95,.13,.04);
  bubbleShower(W*.5,H*.43,Math.round(16+state.giantStep*5));
  giantHint();
  if(state.giantStep>=5)burstGiant();
}
function burstGiant(){
  phase('burst');state.giantArmed=false;$('activeControls').hidden=true;$('gameHint').hidden=true;$('timerHud').hidden=true;
  bubbleShower(W*.5,H*.43,380,true); // ONLY bubbles, fill the entire screen
  audioNote(870,.33,.06);
  saveRecord();
  delay(1700,showFinalResults);
}
function showFinalResults(){
  phase('result');setPlayVisible(false);only('resultScreen');
  $('finalPlayer').textContent='오늘의 기록';
  $('finalTotalScore').textContent=String(state.total);
  const records=allRecords().sort((a,b)=>b.score-a.score||a.name.localeCompare(b.name));
  const currentKey=state.name.trim().toLocaleLowerCase();
  const rank=records.findIndex(r=>r.name.trim().toLocaleLowerCase()===currentKey);
  const rankLabel=$('finalRank');
  rankLabel.textContent=rank>=0?`현재 최고 기록 순위: ${rank+1}위`:'현재 순위를 불러올 수 없어요.';
  const list=$('finalRankingList');list.replaceChildren();
  for(let i=0;i<records.length;i++){
    const entry=records[i],current=entry.name.trim().toLocaleLowerCase()===currentKey;
    const row=document.createElement('div');
    row.className='final-ranking-row'+(current?' is-current':'');
    if(current)row.setAttribute('aria-current','true');
    const position=document.createElement('span');position.className='final-position';position.textContent=`${i+1}위`;
    const who=document.createElement('span');who.className='final-name';who.textContent=entry.name;
    if(current){const strong=document.createElement('strong');strong.textContent=entry.name;who.replaceChildren(strong)}
    const point=document.createElement('strong');point.className='final-points';point.textContent=`${entry.score}점`;
    row.append(position,who,point);list.append(row);
  }
  if(!records.length){
    const empty=document.createElement('p');empty.textContent='아직 저장된 기록이 없어요.';list.append(empty);
  }
  // Make the current player's bold-highlighted row visible without removing other players.
  if(rank>=0){
    requestAnimationFrame(()=>{
      const rows=list.querySelectorAll('.final-ranking-row');
      const first=rows[0],at=rows[Math.max(0,rank-3)];
      if(!first||!at)return;
      list.scrollTop=Math.max(0,at.offsetTop-first.offsetTop);
    });
  }
  refreshLayout();
}
/* ---------- TWO ISOLATED HAND TRACKING SENSORS ---------- */
const PALM=[0,5,9,13,17];
function avgOf(pts,ids){let x=0,y=0;for(const i of ids){x+=pts[i].x;y+=pts[i].y}return{x:x/ids.length,y:y/ids.length}}
function zoneSize(){return clamp(.86-(state.sensitivity-30)/70*.32,.5,.9)}
function zonePoint(nx,ny){
  const z=zoneSize();
  return{x:clamp(((1-nx)-(.5-z/2))/z,-.02,1.02)*W,y:clamp((ny-(.5-z/2))/z,-.02,1.02)*H};
}
function coverPoint(nx,ny){
  const vw=video.videoWidth||1280,vh=video.videoHeight||720,scale=Math.max(W/vw,H/vh);
  return{x:(W-vw*scale)/2+(1-nx)*vw*scale,y:(H-vh*scale)/2+ny*vh*scale};
}
const handInput={pinchAt:0,releaseAt:0};
function resetGameplayHand(){
  const h=state.hand;
  h.visible=false;h.pinch=false;h.pinchCandidate=false;h.pinchCount=0;h.v=false;
  handInput.pinchAt=0;handInput.releaseAt=0;
}
function resetNavigationHand(){
  Object.assign(navSensor,{visible:false,indexTarget:null,holdTarget:null,holdSince:0,
    holdProgress:0,clickAnchor:null});
}
function navDetectionEnabled(){
  return ['navigation','story','profile','color','message','my','reverse','giant','burst','result'].includes(state.phase);
}
function gameplayDetectionEnabled(){
  return ['soap','soap-vanish','my','reverse','giant','burst'].includes(state.phase);
}
function detectHand(now){
  if(!state.camera||video.readyState<2)return;
  if(gameplayDetectionEnabled())detectSensor('gameplay',now,
    ['my','reverse','giant','soap'].includes(state.phase)?16:55);
  if(navDetectionEnabled())detectSensor('navigation',now,
    ['my','reverse','giant'].includes(state.phase)?115:34);
}
function detectSensor(kind,now,interval){
  const s=sensors[kind];
  if(!s.instance||s.rebuilding||now-s.lastDetect<interval||s.lastVideoTime===video.currentTime)return;
  s.lastDetect=now;s.lastVideoTime=video.currentTime;
  let result;
  try{result=s.instance.detectForVideo(video,now);s.errors=0}
  catch(error){if(++s.errors===1)console.warn(`${kind} 인식 프레임 오류`,error);
    if(s.errors>=6)rebuildOnCPU(kind);return;}
  const landmarks=result?.landmarks?.[0];
  if(!landmarks){
    if(kind==='navigation'&&navSensor.visible&&now-navSensor.seenAt>330)resetNavigationHand();
    if(kind==='gameplay'&&state.hand.visible&&now-state.hand.seenAt>330)resetGameplayHand();
    return;
  }
  const vw=video.videoWidth||1280,vh=video.videoHeight||720;
  const pts=landmarks.map(p=>({x:p.x*vw,y:p.y*vh,z:(p.z||0)*vw}));
  if(kind==='navigation')readNavigationHand(pts,now,vw,vh);
  else readGameplayHand(pts,now,vw,vh);
}
/* Detector 1: index-fingertip position ONLY. No air-tap, no finger bend,
   and no pinch is required for buttons. The dwell clock lives in
   selectViaIndexDwell() and uses the pink dot's smoothed on-screen location. */
function readNavigationHand(pts,now,vw,vh){
  const n=navSensor,raw=zonePoint(pts[8].x/vw,pts[8].y/vh);
  n.indexTarget=raw;
  if(!n.visible){n.index={...raw};n.visible=true;}
  n.rawCenter=avgOf(pts,PALM);n.seenAt=now;
}
/* Detector 2: gameplay-only thumb-index pinch (no fist/grab gestures).
   Handles first and reverse round pops and giant bubble. */
function readGameplayHand(pts,now,vw,vh){
  const h=state.hand,wasVisible=h.visible;
  const palm=Math.max(1,dist(pts[5],pts[17]));
  const center=avgOf(pts,PALM);
  const gap=dist(pts[4],pts[8])/palm;
  const pinchNow=wasVisible&&h.pinch?gap<.91:gap<.72;
  if(!wasVisible){h.pinch=pinchNow;h.pinchCandidate=pinchNow;h.pinchCount=2}
  else{
    if(pinchNow===h.pinchCandidate)h.pinchCount++;
    else{h.pinchCandidate=pinchNow;h.pinchCount=1}
    // A single confirmed landmark frame fires an edge; this catches fast pinches.
    // Hysteresis (0.72 close / 0.91 open) prevents oscillation from jitter.
    if(pinchNow!==h.pinch && now-(h.lastGestureEdge||0)>48){
      h.pinch=pinchNow;h.lastGestureEdge=now;
      if(pinchNow)handInput.pinchAt=now;
      else handInput.releaseAt=now;
    }
  }
  h.rawCenter=center;h.target=zonePoint(center.x/vw,center.y/vh);
  h.cover=coverPoint(center.x/vw,center.y/vh);
  const rawThumb=zonePoint(pts[4].x/vw,pts[4].y/vh);
  const rawIndex=zonePoint(pts[8].x/vw,pts[8].y/vh);
  const mid={x:(rawThumb.x+rawIndex.x)/2,y:(rawThumb.y+rawIndex.y)/2};
  const convergence=h.pinch?1:clamp((.42-gap)/.25,0,1);
  h.thumbTarget={x:rawThumb.x+(mid.x-rawThumb.x)*convergence,y:rawThumb.y+(mid.y-rawThumb.y)*convergence};
  h.indexTarget={x:rawIndex.x+(mid.x-rawIndex.x)*convergence,y:rawIndex.y+(mid.y-rawIndex.y)*convergence};
  if(!wasVisible){h.x=h.target.x;h.y=h.target.y;
    h.thumb={...h.thumbTarget};h.index={...h.indexTarget};h.visible=true;}
  h.gap=gap;h.seenAt=now;h.tipSeenAt=now;
}
// Smooth fingertip movement every animation frame. A 2px deadzone filters
// MediaPipe micromovements while allowing fast tracking of intentional gestures.
function dampPoint(previous,target,dt){
  if(!target)return previous;
  const d=dist(previous,target);
  if(d<2.1)return previous;
  const response=d>55?30:d>20?19:d>8?11:7;
  const t=1-Math.exp(-response*Math.min(dt,.05));
  const travel=(d-1.3)*t/d;
  return{x:previous.x+(target.x-previous.x)*travel,
         y:previous.y+(target.y-previous.y)*travel};
}
function smoothHand(dt){
  // Navigation and gameplay fingertip coordinates have independent smoothing.
  if(navSensor.visible)navSensor.index=dampPoint(navSensor.index,navSensor.indexTarget,dt);
  const h=state.hand;if(!h.visible)return;
  const a=1-Math.exp(-dt*22);h.x+=(h.target.x-h.x)*a;h.y+=(h.target.y-h.y)*a;
  h.thumb=dampPoint(h.thumb,h.thumbTarget,dt);
  h.index=dampPoint(h.index,h.indexTarget,dt);
  if(h.pinch){ // both physical tips are touching: make their visible markers touch too
    const shared={x:(h.thumb.x+h.index.x)/2,y:(h.thumb.y+h.index.y)/2};
    h.thumb={...shared};h.index={...shared};
  }
  // GAMEPLAY HIT TESTING uses the SAME smoothed position the player sees.
  h.pinchPoint={x:(h.thumb.x+h.index.x)/2,y:(h.thumb.y+h.index.y)/2};
}
function takePinch(now){
  const ok=handInput.pinchAt&&now>=inputLockUntil&&now-handInput.pinchAt<390;
  handInput.pinchAt=0;
  return !!ok;
}
function takeRelease(now){
  const ok=handInput.releaseAt&&now>=inputLockUntil&&now-handInput.releaseAt<390;
  handInput.releaseAt=0;
  return !!ok;
}

/* ---------- PINK FINGERTIPS / separate sensor display ---------- */
function updateFingertipDots(){
  const game=state.hand,n=navSensor;
  const showGame=state.camera&&game.visible&&gameplayDetectionEnabled();
  const showNavigation=state.camera&&n.visible&&navDetectionEnabled();
  // When hovering a UI button, the index marker must show the NAV sensor's
  // hit-test position; elsewhere in gameplay it shows the pinch sensor's tip.
  // Without this distinction the visible dot can miss the actual button target.
  const overButton=showNavigation&&!!visibleInteractiveAt(n.index.x,n.index.y);
  const indexPoint=overButton?n.index:(showGame?game.index:n.index);
  const showIndex=showGame||showNavigation;
  const indexEl=$('indexMarker'),thumbEl=$('thumbMarker');
  indexEl.hidden=!showIndex;thumbEl.hidden=!showGame;
  if(showIndex){indexEl.style.left=clamp(indexPoint.x,0,W)+'px';indexEl.style.top=clamp(indexPoint.y,0,H)+'px'}
  if(showGame){thumbEl.style.left=clamp(game.thumb.x,0,W)+'px';thumbEl.style.top=clamp(game.thumb.y,0,H)+'px'}
  thumbEl.classList.toggle('touching',showGame&&game.pinch);
  indexEl.classList.toggle('touching',showGame&&game.pinch);
}
let highlighted=null;
function visibleInteractiveAt(x,y){
  if(state.rewinding)return null;
  const el=document.elementFromPoint(clamp(x,1,W-1),clamp(y,1,H-1));
  if(!el)return null;
  const target=el.closest('button, input, .color-chip');
  if(!target||target.disabled||target.closest('[hidden]')||target.closest('.gesture-guide'))return null;
  if(target.id==='allowCamera')return null;
  if(target.matches('input'))return state.phase==='profile'&&['playerName','playerAge'].includes(target.id)?target:null;
  return target;
}
function updateHandHover(){
  highlighted?.classList.remove('hand-hover');highlighted=null;
  const n=navSensor;
  if(!n.visible||!navDetectionEnabled())return;
  const at=n.index;
  const target=visibleInteractiveAt(at.x,at.y);
  if(!target)return;
  if(['my','reverse','giant'].includes(state.phase) &&
     !['pauseBtn','playBtn','restartBtn','backStageBtn','homeResetBtn'].includes(target.id))return;
  highlighted=target;highlighted.classList.add('hand-hover');
}
function activateHandTarget(target){
  if(!target)return false;
  if(target.matches('input')){target.focus();lockInput(350);return true}
  virtualClick=true;
  try{target.click()}finally{virtualClick=false}
  lockInput(260);
  return true;
}
/* Select a UI control when the index fingertip STAYS over it for 250ms.
   Never trigger repeatedly at the same screen coordinate. Leaving a button,
   or moving at least 35px after clicking, rearms the next selection. */
function selectViaIndexDwell(now){
  const n=navSensor;
  const marker=$('indexMarker');
  const resetHold=()=>{n.holdTarget=null;n.holdSince=0;n.holdProgress=0;
    marker.classList.remove('dwell-active');marker.style.setProperty('--dwell-angle','0deg');};
  if(state.rewinding||!$('backTransition').hidden||!n.visible||!navDetectionEnabled()||now<inputLockUntil){resetHold();return false}
  // A visible tutorial overlay prevents clicking controls underneath it.
  if(!$('gestureGuide').hidden){resetHold();return false}
  const p=n.index;
  const target=visibleInteractiveAt(p.x,p.y);
  if(!target){resetHold();return false}
  if(['my','reverse','giant'].includes(state.phase)&&
    !['pauseBtn','playBtn','restartBtn','backStageBtn','homeResetBtn'].includes(target.id)){resetHold();return false}

  // Releasing the previously clicked position requires an intentional move.
  // Screen transitions can replace the button in place; this avoids chaining.
  if(n.clickAnchor){
    if(dist(p,n.clickAnchor)<NAV_REARM_MOVE_PX){resetHold();return false}
    n.clickAnchor=null;
  }
  if(n.holdTarget!==target){
    n.holdTarget=target;n.holdSince=now;n.holdProgress=0;
  }
  n.holdProgress=clamp((now-n.holdSince)/NAV_DWELL_MS,0,1);
  marker.classList.add('dwell-active');
  marker.style.setProperty('--dwell-angle',(n.holdProgress*360).toFixed(1)+'deg');
  if(n.holdProgress<1)return false;
  // Lock immediately, even if .click() swaps the screen synchronously.
  n.clickAnchor={...p};
  resetHold();
  return activateHandTarget(target);
}

function update(dt,now,guideDt=dt){
  const h=state.hand;
  if(state.paused)return;
  if(state.phase==='soap'&&h.visible)moveSoapWithHand(h.index,dt);
  if(state.phase==='my'||state.phase==='reverse'){
    if(state.guideUntil>0||!$('gestureGuide').hidden){
      state.guideUntil=Math.max(0,state.guideUntil-guideDt*1000);
      if(state.guideUntil<=0)finishGestureGuide();
      // While the guide is visible: leave bubbles and the 20-second timer paused.
    }else{
      state.remaining=Math.max(0,state.remaining-guideDt);$('timeValue').textContent=String(Math.ceil(state.remaining));
      state.spawnTime-=dt;
      if(state.spawnTime<=0){spawnBubble();state.spawnTime=clamp((.40-state.speed*.0022)*100/state.bubbleDensity,.13,.55)+random(-.02,.04)}
      updateBubbles(dt);
      state.hoverBall=bubbleUnderHand();
      // Pop only when the index finger and thumb actually pinch near a bubble.
      if(takePinch(now)){
        const bubble=bubbleUnderHand();
        if(bubble)popBall(bubble,now);
      }
      if(state.remaining<=0)endRound(state.phase);
    }
  }
  if(state.phase==='giant'){
    state.giantTime=Math.max(0,state.giantTime-guideDt);
    $('timeValue').textContent=String(Math.ceil(state.giantTime));
    if(!h.visible&&state.giantArmed){state.giantArmed=false;giantHint()}
    if(takePinch(now)&&!state.giantArmed){state.giantArmed=true;audioNote(520,.07,.03);giantHint()}
    if(state.giantArmed&&takeRelease(now)){state.giantArmed=false;growGiant(now);if(state.phase==='giant')giantHint()}
    if(state.phase==='giant'&&state.giantTime<=0){
      phase('giant-timeout');hideHUD();
      showMessage('비눗방울을 다시 키워 볼까요?',[
        `이번에는 ${state.giantStep}번 키웠어요.`,
        '큰 비눗방울은 5번 키워야 터져요.'
      ],'다시 도전하기',startGiant,'spread');
    }
  }
  for(let idx=state.particles.length-1;idx>=0;idx--){
    const p=state.particles[idx];p.life-=dt;p.x+=p.vx*dt;p.y+=p.vy*dt;p.vy+=65*dt;p.vx*=1-.2*dt;p.rot+=.25*dt;
    if(p.life<=0)state.particles.splice(idx,1);
  }
}

/* ---------- DRAWING ---------- */
function shapedOutline(g,shape,r){
  g.beginPath();
  if(shape==='heart'){
    for(let i=0;i<=100;i++){
      const t=Math.PI*2*i/100;
      const x=(16*Math.sin(t)**3)/18*r;
      const y=-(13*Math.cos(t)-5*Math.cos(2*t)-2*Math.cos(3*t)-Math.cos(4*t))/18*r;
      i?g.lineTo(x,y):g.moveTo(x,y);
    }
  }else if(shape==='bunny'){
    g.moveTo(-.70*r,.47*r);
    g.bezierCurveTo(-1.04*r,.16*r,-.97*r,-.33*r,-.62*r,-.56*r);
    g.bezierCurveTo(-.72*r,-.95*r,-.70*r,-1.43*r,-.43*r,-1.40*r);
    g.bezierCurveTo(-.19*r,-1.38*r,-.19*r,-.99*r,-.12*r,-.75*r);
    g.bezierCurveTo(-.03*r,-.73*r,.08*r,-.73*r,.16*r,-.75*r);
    g.bezierCurveTo(.22*r,-1.01*r,.27*r,-1.42*r,.51*r,-1.39*r);
    g.bezierCurveTo(.81*r,-1.36*r,.79*r,-.90*r,.61*r,-.55*r);
    g.bezierCurveTo(.95*r,-.29*r,1.00*r,.21*r,.68*r,.51*r);
    g.bezierCurveTo(.26*r,.96*r,-.32*r,.96*r,-.70*r,.47*r);
  }else{
    // Rounded star: curved vertices read as a glass bubble, not a flat sticker.
    const pts=[];
    for(let k=0;k<10;k++){
      const a=-Math.PI/2+k*Math.PI/5,rr=(k%2?.51:1.05)*r;
      pts.push({x:Math.cos(a)*rr,y:Math.sin(a)*rr});
    }
    const midpoint=(p,q)=>({x:(p.x+q.x)/2,y:(p.y+q.y)/2});
    const start=midpoint(pts[9],pts[0]);g.moveTo(start.x,start.y);
    for(let k=0;k<10;k++){
      const q=midpoint(pts[k],pts[(k+1)%10]);
      g.quadraticCurveTo(pts[k].x,pts[k].y,q.x,q.y);
    }
  }
  g.closePath();
}
function drawSpecialBubble(b,g=ctx){
  const r=b.r,shape=b.shape||'star';
  g.save();g.translate(b.x,b.y+(shape==='bunny'?r*.17:0));
  // Semi-transparent inner glass, letting the illustrated bath remain visible through it.
  const fill=g.createLinearGradient(-r,-r,r,r);
  fill.addColorStop(0,'rgba(251,254,255,.43)');
  fill.addColorStop(.42,'rgba(195,226,248,.14)');
  fill.addColorStop(.7,'rgba(243,191,225,.15)');
  fill.addColorStop(1,'rgba(181,222,248,.36)');
  shapedOutline(g,shape,r);g.fillStyle=fill;g.fill();
  const edge=g.createLinearGradient(-r,-r,r,r);
  edge.addColorStop(0,'rgba(148,216,246,.93)');
  edge.addColorStop(.28,'rgba(251,253,255,.95)');
  edge.addColorStop(.55,'rgba(226,166,219,.9)');
  edge.addColorStop(.83,'rgba(140,205,244,.92)');
  edge.addColorStop(1,'rgba(255,239,216,.92)');
  g.strokeStyle=edge;g.lineWidth=Math.max(3,r*.11);g.lineJoin='round';g.stroke();
  // Soft pencil irregularities along the contour, using a narrow secondary line.
  g.strokeStyle='rgba(255,255,255,.74)';g.lineWidth=Math.max(1,r*.028);g.stroke();
  g.save();shapedOutline(g,shape,r);g.clip();
  const gleam=g.createRadialGradient(-r*.33,-r*.42,r*.02,-r*.22,-r*.45,r*.78);
  gleam.addColorStop(0,'rgba(255,255,255,.50)');gleam.addColorStop(.48,'rgba(255,255,255,.12)');gleam.addColorStop(1,'rgba(255,255,255,0)');
  g.fillStyle=gleam;g.fillRect(-r*1.5,-r*1.8,r*3,r*3);
  g.strokeStyle='rgba(255,255,255,.72)';g.lineWidth=Math.max(2,r*.05);g.lineCap='round';
  g.beginPath();g.ellipse(-r*.25,-r*.50,r*.28,r*.12,-.6,Math.PI*.1,Math.PI*1.08);g.stroke();
  g.restore();
  // Two tiny pale flecks are part of the bubble material, not a star icon overlay.
  g.fillStyle='rgba(255,255,255,.85)';
  for(const [x,y,size] of [[-.30,-.36,.055],[.54,.24,.034]]){
    g.beginPath();g.arc(x*r,y*r,size*r,0,Math.PI*2);g.fill();
  }
  g.restore();
}
function drawBubble(b,g=ctx){
  if(b.kind==='special'){drawSpecialBubble(b,g);return}
  // Ordinary bubbles use only the exact user-supplied Bubble1.png artwork, recolored at the outlines.
  const size=b.r*2.5;g.save();g.translate(b.x,b.y);
  g.drawImage(bubbleSprite(b.color),-size/2,-size/2,size,size);
  g.restore();
}
function drawParticle(p){
  // All particles are small transparent soap bubbles — never confetti or stars.
  ctx.save();ctx.translate(p.x,p.y);ctx.rotate(p.rot||0);
  ctx.globalAlpha=clamp(p.life/Math.min(.8,p.maxLife),0,1)*.95;
  ctx.strokeStyle='#f8fdff';ctx.lineWidth=Math.max(1,p.r*.25);
  ctx.beginPath();ctx.arc(0,0,p.r,0,Math.PI*2);ctx.stroke();
  ctx.strokeStyle='#81c9ed';ctx.lineWidth=Math.max(.7,p.r*.13);
  ctx.beginPath();ctx.arc(-p.r*.08,0,p.r*.85,3.75,5.75);ctx.stroke();
  ctx.restore();
}

// Hand poses for the example animations (palm-width units, as seen on screen).
const POSES=(()=>{
  const open=[[0,.5],[-.35,.3],[-.68,.06],[-.92,-.2],[-1.12,-.45],[-.4,-.45],[-.5,-.95],[-.56,-1.3],[-.6,-1.6],[-.08,-.5],[-.1,-1.05],[-.11,-1.45],[-.12,-1.78],[.22,-.45],[.3,-.95],[.35,-1.3],[.38,-1.58],[.5,-.33],[.65,-.72],[.75,-.98],[.82,-1.2]];
  const pinch=[[0,.5],[-.35,.3],[-.64,.06],[-.82,-.3],[-.9,-.7],[-.4,-.45],[-.62,-.85],[-.8,-.95],[-.9,-.78],[-.08,-.5],[-.1,-1.02],[-.11,-1.4],[-.12,-1.72],[.22,-.45],[.3,-.92],[.35,-1.26],[.38,-1.52],[.5,-.33],[.65,-.7],[.75,-.95],[.82,-1.16]];
  const centred=pose=>{const pts=pose.map(([x,y])=>({x,y})),c=avgOf(pts,PALM);return pts.map(p=>({x:p.x-c.x,y:p.y-c.y}))};
  return{open:centred(open),pinch:centred(pinch)};
})();
const lerpPose=(a,b,t)=>a.map((p,i)=>({x:p.x+(b[i].x-p.x)*t,y:p.y+(b[i].y-p.y)*t}));
const ease=t=>t*t*(3-2*t);
// 0 → 1 → 0 loop with pauses at both ends: open (hold) → close (hold) → open …
function pingPong(t,period=2.2){const u=(t%period)/period;return u<.3?0:u<.45?ease((u-.3)/.15):u<.8?1:ease(1-(u-.8)/.2)}

const BONES=[[[1,2],[2,3],[3,4]],[[5,6],[6,7],[7,8]],[[9,10],[10,11],[11,12]],[[13,14],[14,15],[15,16]],[[17,18],[18,19],[19,20]]];
const PALM_SHAPE=[0,1,2,5,9,13,17];
// A soft, paper-white cartoon hand with the same dark pencil outline as the paper boxes.
function drawHandShape(g,pts,palmPx,o={}){
  const fill=o.fill||'#fffdf8',line=o.line||'#2b2828',finger=palmPx*.28,edge=Math.max(2.4,palmPx*.055);
  g.save();g.lineCap='round';g.lineJoin='round';
  const palmPath=()=>{g.beginPath();PALM_SHAPE.forEach((i,k)=>k?g.lineTo(pts[i].x,pts[i].y):g.moveTo(pts[i].x,pts[i].y));g.closePath()};
  const fingerPath=chain=>{g.beginPath();g.moveTo(pts[chain[0][0]].x,pts[chain[0][0]].y);for(const[,b]of chain)g.lineTo(pts[b].x,pts[b].y)};
  // 1) one dark silhouette with a soft shadow
  g.shadowColor='rgba(38,82,122,.28)';g.shadowBlur=palmPx*.3;g.shadowOffsetY=palmPx*.08;
  g.fillStyle=line;g.strokeStyle=line;g.lineWidth=finger*.9+edge*2;palmPath();g.fill();g.stroke();
  g.lineWidth=finger+edge*2;for(const c of BONES){fingerPath(c);g.stroke()}
  g.shadowColor='transparent';
  // 2) paper fill: palm, then each finger, outer fingers first so neighbours keep a thin pencil line between them
  g.fillStyle=fill;g.strokeStyle=fill;g.lineWidth=finger*.9;palmPath();g.fill();g.stroke();
  for(const c of [BONES[4],BONES[3],BONES[2],BONES[1],BONES[0]]){
    g.strokeStyle=line;g.lineWidth=finger+edge*.9;fingerPath(c);g.stroke();
    g.strokeStyle=fill;g.lineWidth=finger;fingerPath(c);g.stroke();
  }
  // the base of each finger blends back into the palm
  g.fillStyle=fill;for(const i of [5,9,13,17,2]){g.beginPath();g.arc(pts[i].x,pts[i].y,finger*.48,0,Math.PI*2);g.fill()}
  if(o.tips){ // thumb + index highlighted for the giant stage
    const a=pts[4],b=pts[8];
    g.setLineDash([palmPx*.1,palmPx*.09]);g.strokeStyle=o.tipLine||'#f49aaa';g.lineWidth=Math.max(2,palmPx*.05);
    g.beginPath();g.moveTo(a.x,a.y);g.lineTo(b.x,b.y);g.stroke();g.setLineDash([]);
    for(const p of [a,b]){g.fillStyle='#f49aaa';g.strokeStyle='#fff';g.lineWidth=edge*.9;g.beginPath();g.arc(p.x,p.y,finger*.36,0,Math.PI*2);g.fill();g.stroke()}
  }
  g.restore();
}
function posePoints(pose,cx,cy,palmPx){return pose.map(p=>({x:cx+p.x*palmPx,y:cy+p.y*palmPx}))}
function sparkle(g,x,y,r,alpha,color='#fff'){
  g.save();g.globalAlpha=alpha;g.strokeStyle=color;g.lineWidth=2.5;
  for(let k=0;k<7;k++){const a=k/7*Math.PI*2,d=r*(1+.5*(1-alpha));g.beginPath();g.arc(x+Math.cos(a)*d,y+Math.sin(a)*d,r*.13,0,Math.PI*2);g.stroke()}
  g.restore();
}
// Example animations: 'pinch' to pop/click, 'spread' to grow; no other gesture required.
function drawDemo(g,kind,t,cx,cy,palmPx){
  if(kind==='pinch'){
    const k=pingPong(t+.3,2.2),r=palmPx*.95;
    if(k<.60)drawBubble({x:cx,y:cy-palmPx*.15,r,color:state.selectedColor,kind:'target'},g);
    else sparkle(g,cx,cy-palmPx*.15,r,clamp((1-k)*2.8+.3,0,1),'#5ab9f2');
    drawHandShape(g,posePoints(lerpPose(POSES.open,POSES.pinch,k),cx,cy+palmPx*.15,palmPx),palmPx,
      {fill:k>.62?'#fbd5de':'#fffdf8',tips:true});
  }else if(kind==='spread'){
    const k=pingPong(t,2.4),grow=1-k; // pinch (k=1) → spread (k=0)
    drawBubble({x:cx+palmPx*1.25,y:cy-palmPx*.75,r:palmPx*(.32+grow*.42),color:state.selectedColor,kind:'giant'},g);
    drawHandShape(g,posePoints(lerpPose(POSES.open,POSES.pinch,k),cx-palmPx*.45,cy+palmPx*.35,palmPx),palmPx,{tips:true});
  }
}
function drawGiantSteps(){
  const r=clamp(Math.min(W,H)*.026,13,22),gap=r*2.9,y=r+26,x0=W/2-gap*2;
  ctx.save();ctx.fillStyle='rgba(246,250,255,.93)';ctx.strokeStyle='#2b2828';ctx.lineWidth=2.5;
  ctx.beginPath();if(ctx.roundRect)ctx.roundRect(x0-r*1.8,y-r*1.55,gap*4+r*3.6,r*3.1,24);else ctx.rect(x0-r*1.8,y-r*1.55,gap*4+r*3.6,r*3.1);ctx.fill();ctx.stroke();ctx.restore();
  for(let i=0;i<5;i++){
    const x=x0+i*gap;
    if(i<state.giantStep)drawBubble({x,y,r:r*.85,color:state.selectedColor,kind:'giant'});
    else{ctx.save();ctx.setLineDash([4,4]);ctx.strokeStyle='#8fb7d3';ctx.lineWidth=2;ctx.beginPath();ctx.arc(x,y,r*.85,0,Math.PI*2);ctx.stroke();ctx.restore()}
  }
}
// Navigation tutorial: the fingertip remains still while a quarter-second
// circular progress stroke completes around it (no bend or tap gesture).
function drawIndexTapDemo(g,t){
  const w=g.canvas.width,h=g.canvas.height,cycle=(t%2.2);
  const progress=clamp((cycle-.35)/.25,0,1);
  g.clearRect(0,0,w,h);
  g.save();g.translate(w*.5,h*.5);
  g.fillStyle='#f6faff';g.strokeStyle='#2b2828';g.lineWidth=3.5;
  g.beginPath();if(g.roundRect)g.roundRect(-86,-55,174,59,[18,14,17,15]);else g.rect(-86,-55,174,59);g.fill();g.stroke();
  g.font='700 26px Gaegu, sans-serif';g.textAlign='center';g.fillStyle='#1c669e';
  g.fillText('다음 단계',0,-18);
  const tipY=-28;
  g.strokeStyle='#2b2828';g.lineCap='round';g.lineWidth=27;
  g.beginPath();g.moveTo(7,88);g.quadraticCurveTo(10,47,7,tipY);g.stroke();
  g.strokeStyle='#fffdf8';g.lineWidth=22;g.beginPath();g.moveTo(7,88);g.quadraticCurveTo(10,47,7,tipY);g.stroke();
  g.fillStyle='#f49aaa';g.strokeStyle='#fff';g.lineWidth=3;
  g.beginPath();g.arc(7,tipY,9,0,Math.PI*2);g.fill();g.stroke();
  if(progress>0){g.strokeStyle='#f49aaa';g.lineWidth=4;g.lineCap='round';
    g.beginPath();g.arc(7,tipY,17,-Math.PI/2,-Math.PI/2+progress*Math.PI*2);g.stroke()}
  if(progress>=1){g.fillStyle='#1c669e';g.font='700 19px Gaegu, sans-serif';g.fillText('클릭!',0,38)}
  g.restore();
}
const demoCanvas=$('gestureDemo'),demoCtx=demoCanvas.getContext('2d');
const guidePinchCanvas=$('guidePinch'),guidePinchCtx=guidePinchCanvas.getContext('2d');
const navDemoCanvas=$('navGuideDemo'),navDemoCtx=navDemoCanvas.getContext('2d');
function render(now){
  ctx.clearRect(0,0,W,H);
  if(['my','reverse'].includes(state.phase)){
    state.balls.filter(b=>b.settled).forEach(b=>drawBubble(b));
    state.balls.filter(b=>!b.settled).forEach(b=>drawBubble(b));
  }
  if(state.phase==='giant'){
    const r=giantRadius();drawBubble({x:W*.5,y:H*.43,r,color:state.selectedColor,kind:'giant'});
    drawGiantSteps();
  }
  if(['soap','soap-vanish','my','reverse','giant','burst','result','message'].includes(state.phase))state.particles.forEach(drawParticle);
  if(state.guideUntil&&!$('gestureGuide').hidden){
      const progress=clamp(1-state.guideUntil/3500,0,1);
    $('guideProgress').style.width=(progress*100).toFixed(1)+'%';
    guidePinchCtx.clearRect(0,0,guidePinchCanvas.width,guidePinchCanvas.height);
    drawDemo(guidePinchCtx,'pinch',now/1000,guidePinchCanvas.width/2,guidePinchCanvas.height*.60,guidePinchCanvas.height*.27);
  }
  if(!demoCanvas.hidden&&!$('messageScreen').hidden&&state.demo){
    demoCtx.clearRect(0,0,demoCanvas.width,demoCanvas.height);
    if(state.demo==='random-reveal')demoCtx.drawImage(bubbleSprite(state.selectedColor),110,35,180,180);
    else drawDemo(demoCtx,state.demo,now/1000,demoCanvas.width/2,demoCanvas.height*.56,demoCanvas.height*.3);
  }
  if(!$('navigationScreen').hidden){
    navDemoCtx.clearRect(0,0,navDemoCanvas.width,navDemoCanvas.height);
    drawIndexTapDemo(navDemoCtx,now/1000);
  }
}
function animation(now){
  const rawDt=lastFrame?Math.max(0,(now-lastFrame)/1000):0;
  const dt=clamp(rawDt,0,.05);lastFrame=now;
  if(state.camera)detectHand(now);
  smoothHand(dt);
  if(!state.paused)gameVisualSeconds+=dt;
  updateFingertipDots();
  updateHandHover();
  // Navigation sensor uses 250ms index dwell; gameplay sensor exclusively handles pinch actions.
  selectViaIndexDwell(now);
  update(dt,now,rawDt);
  // Expire gesture edges that arrived during transitions/timers.
  if(handInput.pinchAt&&now-handInput.pinchAt>390)handInput.pinchAt=0;
  if(handInput.releaseAt&&now-handInput.releaseAt>390)handInput.releaseAt=0;
  render(now);requestAnimationFrame(animation);
}
requestAnimationFrame(animation);

/* ---------- BUBBLE-ONLY FINAL RESULT ---------- */
$('goHome').addEventListener('click',()=>{
  showBubbleTransition('다시 놀 준비를 하고 있어요...',replayFromSoap);
});
$('restartAll').addEventListener('click',()=>{
  showBubbleTransition('처음부터 시작하고 있어요...',resetToNavigationGuide);
});
window.addEventListener('pagehide',()=>{stream?.getTracks().forEach(track=>track.stop())});
