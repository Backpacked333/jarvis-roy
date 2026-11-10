(()=>{"use strict";
const AURAMotion=(()=>{
/**
 * AURA / facial performance director.
 * Pure JS, no rendering or DOM dependency. Times are seconds from performance.now().
 * The rig uses ARKit blendshape names, with angles in radians.
 *
 * Character timing is not phonetic alignment. The English grapheme-to-viseme
 * rules below are an explicit approximation; supply timed phonemes with
 * setPhonemes() when a phoneme aligner is available. ElevenLabs playback-aligned
 * character data fixes the transport timing while these rules choose the pose.
 */
const clamp = (v, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, Number.isFinite(v) ? v : lo));
const mix = (a, b, t) => a + (b - a) * t;
const smooth = v => { const t = clamp(v); return t * t * (3 - 2 * t); };
const clock = () => globalThis.performance?.now() / 1000 || 0;
const fade = (a, b, dt, rate) => mix(a, b, 1 - Math.exp(-dt * rate));

const BLENDSHAPES = Object.freeze([
  'eyeBlinkLeft','eyeBlinkRight','eyeLookDownLeft','eyeLookDownRight',
  'eyeLookInLeft','eyeLookInRight','eyeLookOutLeft','eyeLookOutRight',
  'eyeLookUpLeft','eyeLookUpRight','eyeSquintLeft','eyeSquintRight','eyeWideLeft','eyeWideRight',
  'jawForward','jawLeft','jawRight','jawOpen','mouthClose','mouthFunnel','mouthPucker',
  'mouthLeft','mouthRight','mouthSmileLeft','mouthSmileRight','mouthFrownLeft','mouthFrownRight',
  'mouthDimpleLeft','mouthDimpleRight','mouthStretchLeft','mouthStretchRight','mouthRollLower',
  'mouthRollUpper','mouthShrugLower','mouthShrugUpper','mouthPressLeft','mouthPressRight',
  'mouthLowerDownLeft','mouthLowerDownRight','mouthUpperUpLeft','mouthUpperUpRight',
  'browDownLeft','browDownRight','browInnerUp','browOuterUpLeft','browOuterUpRight',
  'cheekPuff','cheekSquintLeft','cheekSquintRight','noseSneerLeft','noseSneerRight','tongueOut'
]);
const emptyPose = () => Object.fromEntries(BLENDSHAPES.map(k => [k, 0]));

// Deliberately independent lip, jaw, cheek and tongue actions. A vowel does not
// just scale a single jaw-open target, and the lips close for bilabial consonants.
const POSES = Object.freeze({
  rest: {},
  MBP: { jawOpen:.025,mouthClose:.50,mouthPressLeft:.25,mouthPressRight:.25,mouthRollUpper:.10,mouthRollLower:.07 },
  FV: { jawOpen:.10,mouthRollLower:.46,mouthUpperUpLeft:.16,mouthUpperUpRight:.16,mouthStretchLeft:.10,mouthStretchRight:.10 },
  TH: { jawOpen:.18,mouthLowerDownLeft:.15,mouthLowerDownRight:.15,tongueOut:.24 },
  L: { jawOpen:.21,mouthLowerDownLeft:.12,mouthLowerDownRight:.12,tongueOut:.12 },
  S: { jawOpen:.095,mouthStretchLeft:.28,mouthStretchRight:.28,mouthUpperUpLeft:.15,mouthUpperUpRight:.15 },
  CH: { jawOpen:.15,mouthFunnel:.40,mouthPucker:.14,mouthUpperUpLeft:.13,mouthUpperUpRight:.13 },
  KG: { jawOpen:.23,mouthStretchLeft:.08,mouthStretchRight:.08 },
  R: { jawOpen:.16,mouthFunnel:.25,mouthPucker:.24 },
  AA: { jawOpen:.53,mouthLowerDownLeft:.25,mouthLowerDownRight:.25,mouthUpperUpLeft:.12,mouthUpperUpRight:.12 },
  E: { jawOpen:.27,mouthStretchLeft:.38,mouthStretchRight:.38,mouthUpperUpLeft:.11,mouthUpperUpRight:.11 },
  I: { jawOpen:.18,mouthStretchLeft:.46,mouthStretchRight:.46,mouthSmileLeft:.08,mouthSmileRight:.08 },
  O: { jawOpen:.35,mouthFunnel:.62,mouthPucker:.24,mouthLowerDownLeft:.09,mouthLowerDownRight:.09 },
  U: { jawOpen:.14,mouthFunnel:.22,mouthPucker:.70 },
  W: { jawOpen:.10,mouthPucker:.62,mouthFunnel:.12 },
  N: { jawOpen:.12,mouthStretchLeft:.10,mouthStretchRight:.10 },
  H: { jawOpen:.30,mouthLowerDownLeft:.08,mouthLowerDownRight:.08 }
});
const PHONEMES = {
  AA:'AA', AE:'AA', AH:'AA', AO:'O', AW:'O', AY:'E', EH:'E', ER:'R', EY:'E', IH:'I', IY:'I', OW:'O', OY:'O', UH:'U', UW:'U',
  B:'MBP', P:'MBP', M:'MBP', F:'FV', V:'FV', TH:'TH', DH:'TH', T:'L', D:'L', L:'L', N:'N', NG:'N', K:'KG', G:'KG',
  S:'S', Z:'S', SH:'CH', ZH:'CH', CH:'CH', JH:'CH', R:'R', W:'W', Y:'I', HH:'H', SIL:'rest', SP:'rest', PAU:'rest',
  'ɑ':'AA','æ':'AA','ʌ':'AA','ɐ':'AA','ə':'AA','ɛ':'E','ɪ':'I','i':'I','o':'O','ɔ':'O','u':'U','ʊ':'U','ɜ':'R','ɹ':'R',
  'p':'MBP','b':'MBP','m':'MBP','f':'FV','v':'FV','θ':'TH','ð':'TH','t':'L','d':'L','l':'L','n':'N','ŋ':'N','k':'KG','g':'KG','s':'S','z':'S','ʃ':'CH','ʒ':'CH','r':'R','w':'W','j':'I','h':'H'
};
const PRONUNCIATIONS = {
  aura:['O','R','AA'], hello:['H','E','L','O'], hi:['H','AA','I'], 'i':['AA','I'], "i'm":['AA','I','MBP'],
  the:['TH','AA'], this:['TH','I','S'], that:['TH','AA','L'], these:['TH','I','S'], those:['TH','O','S'],
  you:['I','U'], your:['I','O','R'], "you're":['I','U','R'], are:['AA','R'], our:['AA','U','R'],
  one:['W','AA','N'], two:['L','U'], three:['TH','R','I'], to:['L','U'], of:['AA','FV'],
  have:['H','AA','FV'], every:['E','FV','R','I'], eyes:['AA','I','S'], eye:['AA','I'],
  words:['W','R','L','S'], word:['W','R','L'], voice:['FV','O','I','S'], voices:['FV','O','I','S','I','S'],
  my:['MBP','AA','I'], me:['MBP','I'], made:['MBP','E','L'], move:['MBP','U','FV'],
  movement:['MBP','U','FV','MBP','E','N','L'], moves:['MBP','U','FV','S'],
  face:['FV','E','S'], same:['S','E','MBP'], first:['FV','R','S','L'],
  each:['I','CH'], head:['H','E','L'], how:['H','AA','U'], now:['N','AA','U'],
  watch:['W','AA','CH'], small:['S','MBP','O','L'], with:['W','I','TH'],
  natural:['N','AA','CH','R','AA','L'], real:['R','I','L'], really:['R','I','L','I'],
  listen:['L','I','S','AA','N'], listening:['L','I','S','AA','N','I','N'],
  living:['L','I','FV','I','N'], human:['H','I','U','MBP','AA','N'],
  something:['S','AA','MBP','TH','I','N'], particles:['MBP','AA','R','L','I','KG','AA','L','S'],
  can:['KG','AA','N'], "let's":['L','E','L','S'], think:['TH','I','N','KG']
};
const VOWELS = new Set(['AA','E','I','O','U']);

/** Convert English text to viseme segments while retaining UTF-16 text indices. */
function textToVisemes(text) {
  const events = [];
  const parts = String(text).matchAll(/\[[^\]\r\n]*\]|[a-zA-Z]+(?:['’][a-zA-Z]+)?|[^a-zA-Z]/g);
  for (const match of parts) {
    const raw = match[0], index = match.index;
    // Expressive TTS tags are instructions, not spoken words. Preserve their
    // original indices for provider alignment without articulating tag names.
    if(raw.startsWith('[')&&raw.endsWith(']')){
      events.push({name:'rest',index,length:raw.length,weight:0,phrase:false});
      continue;
    }
    const word = raw.toLowerCase().replace(/’/g,"'");
    if (!/[a-z]/.test(word)) {
      events.push({ name:'rest', index, length:raw.length, weight:/[.!?]/.test(raw)?.30:/[,;:]/.test(raw)?.15:/\s/.test(raw)?.055:.025, phrase:/[.!?]/.test(raw) });
      continue;
    }
    const special = PRONUNCIATIONS[word];
    if (special) {
      special.forEach((name,i) => events.push({ name, index:index+i*raw.length/special.length, length:raw.length/special.length, weight:VOWELS.has(name)?.115:.075 }));
      continue;
    }
    let i=0;
    while(i<word.length) {
      const rest=word.slice(i); let n=1, name='AA';
      if (/^(sh|ch|zh|ti(?=on)|ci(?=ous))/.test(rest)){n=2;name='CH';}
      else if(rest.startsWith('th')){n=2;name='TH';}
      else if(rest.startsWith('ph')){n=2;name='FV';}
      else if(/^(ee|ea|ie)/.test(rest)){n=2;name='I';}
      else if(/^(oo|ou(?=ld))/.test(rest)){n=2;name='U';}
      else if(/^(oa|ow)/.test(rest)){n=2;name='O';}
      else if(/^(ai|ay|ei|ey)/.test(rest)){n=2;name='E';}
      else if(rest.startsWith('ng')){n=2;name='N';}
      else if(rest.startsWith('qu')){n=2;name='W';}
      else {
        const c=rest[0];
        if(c==='e'&&i===word.length-1&&word.length>3){i++;continue;}
        if(c==="'"){i++;continue;}
        name=({p:'MBP',b:'MBP',m:'MBP',f:'FV',v:'FV',t:'L',d:'L',l:'L',n:'N',s:'S',z:'S',c:/^[ei]/.test(rest.slice(1))?'S':'KG',k:'KG',g:'KG',q:'KG',x:'S',r:'R',w:'W',y:'I',j:'CH',h:'H',a:'AA',e:'E',i:'I',o:'O',u:'U'})[c]||'AA';
      }
      events.push({name,index:index+i,length:n,weight:VOWELS.has(name)?.115:name==='MBP'?.060:.073});
      i+=n;
      // Repeated spelling does not usually mean two separate mouth closures.
      while(i<word.length&&word[i]===word[i-1]&&!/[aeiou]/.test(word[i]))i++;
    }
  }
  return events;
}

/** Parse ElevenLabs' documented timing format, and common TTS alignment aliases. */
function alignmentToSegments(payload, startTime=0) {
  const a=payload?.alignment||payload;
  if(!a || !Array.isArray(a.chars||a.characters))return [];
  const chars=a.chars||a.characters;
  const starts=a.char_start_times_ms||a.charStartTimesMs||a.character_start_times_seconds;
  const durations=a.char_durations_ms||a.charDurationsMs;
  const ends=a.character_end_times_seconds;
  const scale=a.character_start_times_seconds?1:0.001;
  if(!Array.isArray(starts)||starts.length!==chars.length)return [];
  const text=chars.join(''), charTimes=[];
  for(let i=0;i<chars.length;i++) {
    const st=Number(starts[i])*scale;
    const en=ends?Number(ends[i]):durations?st+Number(durations[i])*0.001:i+1<chars.length?Number(starts[i+1])*scale:st+.065;
    if(!Number.isFinite(st)||!Number.isFinite(en)||st<0||en<st)return [];
    for(let j=0;j<String(chars[i]).length;j++)charTimes.push({start:st,end:Math.max(st+.006,en)});
  }
  if(!charTimes.length)return [];
  const timeAt=(value,end=false)=>{
    const id=Math.min(charTimes.length-1,Math.floor(Math.max(0,value)));
    const v=charTimes[id];return end?v.end:mix(v.start,v.end,value-id);
  };
  return textToVisemes(text).map(e=>({ ...e,start:startTime+timeAt(e.index),end:startTime+timeAt(e.index+Math.max(.01,e.length)-.001,true),source:'aligned' }));
}

// Closed-form critically damped spring: stable at different frame rates and no
// overshoot. Tracking targets do not make the head wobble like an oscillator.
class Spring {
  constructor(x=0){this.x=x;this.v=0;}
  update(target,dt,frequency){
    const omega=2*Math.PI*frequency, offset=this.x-target, c=this.v+omega*offset, decay=Math.exp(-omega*dt);
    this.x=target+(offset+c*dt)*decay;this.v=(this.v-omega*c*dt)*decay;return this.x;
  }
}

class MotionDirector {
  constructor({reducedMotion=false, seed=412981, now=clock}={}) {
    this.now=now;this.mode='idle';this.reducedMotion=reducedMotion;this.intensity=.75;
    this.seed=seed>>>0;this.started=this.now();this.time=this.started;
    this.pose=emptyPose();this.expression='neutral';this.expressionMix={warm:0,curious:0,focused:0};
    this.speech=[];this.speechText='';this.speechTiming='none';this.speechSource='none';this.previewing=false;
    this.audio={energy:0,low:0,mid:0,high:0,at:-Infinity};this.energy=0;this.prevEnergy=0;
    this.pointer={x:0,y:0,active:false};this.gaze={x:0,y:0};this.gazeTarget={x:0,y:0};
    this.nextSaccade=this.time+1.2;this.nextBlink=this.time+2.1;this.blinkStart=-Infinity;this.doubleBlink=Infinity;
    this.blinkSkew=.006;this.blinkDuration=.225;this.headYaw=new Spring();this.headPitch=new Spring();this.headRoll=new Spring();
    this.gestures=[];this.lastAccent=-Infinity;this.lastWordIndex=-1;
    this.output={...this.pose,yaw:0,pitch:0,roll:0,gazeX:0,gazeY:0,breath:0,energy:0,viseme:'rest',mode:'idle'};
  }
  random(){let x=this.seed;x^=x<<13;x^=x>>>17;x^=x<<5;this.seed=x>>>0;return this.seed/4294967296;}
  setIntensity(v){this.intensity=clamp(v);}
  setReducedMotion(v){this.reducedMotion=!!v;}
  setPointer(x,y,active=true){this.pointer={x:clamp(x,-1,1),y:clamp(y,-1,1),active:!!active};}
  setExpression(expression){this.expression=['neutral','warm','curious','focused'].includes(expression)?expression:'neutral';}
  setMode(mode){
    if(!['idle','listening','thinking','speaking','connecting'].includes(mode))return;
    const old=this.mode;this.mode=mode;
    if(old===mode)return;
    if(mode==='listening'){this.gestures.push({start:this.time+.12,duration:.8,amount:.017,type:'nod'});this.nextBlink=Math.min(this.nextBlink,this.time+.4+this.random()*.5);}
    if(mode==='thinking'){this.nextSaccade=this.time+.10;}
    if(mode==='speaking'){this.nextSaccade=this.time+.2;}
    if(old==='speaking'&&mode!=='speaking')this.clearSpeech(false);
  }
  setAudioFeatures({energy=0,low=0,mid=0,high=0}={},now=this.now()) {
    this.audio={energy:clamp(energy),low:clamp(low),mid:clamp(mid),high:clamp(high),at:now};
  }
  beginUtterance(text,{rate=1,now=this.now(),source='demo'}={}) {
    this.clearSpeech(false);this.speechText=String(text);this.speechSource=source;this.speechTiming='estimated';this.mode='speaking';
    let t=now+.035;
    for(const token of textToVisemes(text)){
      const duration=token.weight/clamp(rate,.45,2);
      const event={...token,start:t,end:t+duration,source:'estimated'};this.speech.push(event);
      if(token.phrase)this.gestures.push({start:t-.05,duration:.65,amount:.014,type:'nod',source:'speech'});
      t+=duration;
    }
    return t-now;
  }
  /** Correct the estimated text timeline using a real browser speech boundary. */
  alignWord(index,length=0,now=this.now()) {
    if(!this.speech.length||index<this.lastWordIndex)return;
    this.lastWordIndex=index;
    const event=this.speech.find(e=>e.index+e.length>index&&e.name!=='rest');
    if(!event)return;
    const boundaryStart=event.start,offset=now-boundaryStart;
    for(const e of this.speech){if(e.end>=boundaryStart-.001){e.start+=offset;e.end+=offset;}}
    this.speechTiming='word-boundaries';
  }
  /** Call ONLY when the corresponding audio starts playback, not on receipt. */
  addAlignment(payload,now=this.now()) {
    const events=alignmentToSegments(payload,now);
    if(!events.length)return false;
    this.speech=this.speech.filter(e=>e.end>now-.15&&e.source==='aligned');
    this.speech.push(...events);this.speech.sort((a,b)=>a.start-b.start);
    this.speechTiming='playback-aligned';this.speechSource='live';this.mode='speaking';
    for(const e of events)if(e.phrase)this.gestures.push({start:e.start,duration:.65,amount:.014,type:'nod',source:'speech'});
    return true;
  }
  /** Precise external aligners can bypass the grapheme approximation entirely. */
  setPhonemes(phonemes,startTime=this.now()) {
    this.speech=(phonemes||[]).filter(p=>Number.isFinite(p.start)&&Number.isFinite(p.end)&&p.end>=p.start).map(p=>({
      name:POSES[p.name]?p.name:PHONEMES[String(p.name).replace(/[012]$/,'')]||'rest',
      start:startTime+p.start,end:startTime+p.end,index:0,length:1,source:'phonemes'
    }));
    this.speechTiming='phonemes';this.speechSource='external';this.mode='speaking';
  }
  clearSpeech(resetMode=true){
    this.speech=[];this.speechText='';this.speechTiming='none';this.speechSource='none';this.lastWordIndex=-1;
    // Cancel emphasis for unsaid words, while retaining manual/listening cues.
    this.gestures=this.gestures.filter(g=>g.source!=='speech');
    this.audio={energy:0,low:0,mid:0,high:0,at:-Infinity};this.previewing=false;
    if(resetMode&&this.mode==='speaking')this.mode='idle';
  }
  preview(mode='talk',text="Hello. I'm Aura. Watch how my lips form each word. My eyes find you first, then my head follows.") {
    this.clearSpeech();
    if(mode==='talk'){const duration=this.beginUtterance(text,{source:'preview'});this.previewing=true;return duration;}
    this.setMode(mode==='listen'?'listening':'idle');return 0;
  }
  nod(amount=.025){this.gestures.push({start:this.time,duration:.75,amount:clamp(amount,-.06,.06),type:'nod'});}
  blink(now=this.now()){this.blinkStart=now;}
  blinkValue(now,offset=0){
    const t=now-this.blinkStart-offset;
    if(t<0||t>this.blinkDuration)return 0;
    if(t<.065)return smooth(t/.065);
    if(t<.086)return 1;
    return 1-smooth((t-.086)/(this.blinkDuration-.086));
  }
  sampleSpeech(now) {
    const pose=emptyPose();let total=0,winning=0,name='rest';
    // Coarticulation: anticipate a rounded vowel / closure, then release into
    // the next sound. Lips and jaw never teleport at character boundaries.
    this.speech=this.speech.filter(e=>e.end>now-.22);
    for(const e of this.speech){
      if(e.start>now+.12)break;
      if(e.name==='rest')continue;
      const attack=e.name==='MBP'?.035:.055,release=e.name==='MBP'?.025:.075;
      if(now<e.start-attack||now>e.end+release)continue;
      let weight=1;
      if(now<e.start)weight=smooth((now-(e.start-attack))/attack);
      else if(now>e.end)weight=1-smooth((now-e.end)/release);
      // Brief consonants stay intelligible even between two open vowels.
      if(e.name==='MBP')weight*=1.35;
      const p=POSES[e.name]||POSES.rest;
      for(const key of Object.keys(p))pose[key]+=p[key]*weight;
      total+=weight;
      if(weight>winning){winning=weight;name=e.name;}
    }
    if(total>.001)for(const key of BLENDSHAPES)pose[key]/=Math.max(1,total);
    return {pose,name,active:clamp(total)};
  }
  update(dt,now=this.now()) {
    dt=clamp(dt,0,.1);this.time=now;
    const local=now-this.started, speaking=this.mode==='speaking',listen=this.mode==='listening';
    const strength=this.intensity, physical=this.reducedMotion?0:strength;
    const sample=speaking?this.sampleSpeech(now):{pose:emptyPose(),name:'rest',active:0};
    const actualAudio=now-this.audio.at<.24;
    const expectedEnergy=sample.active*(sample.name==='MBP'?.08:VOWELS.has(sample.name)?.68:.32);
    const targetEnergy=speaking?(actualAudio?this.audio.energy:expectedEnergy):0;
    this.energy=fade(this.energy,targetEnergy,dt,targetEnergy>this.energy?23:13);

    // Mouth fallback uses three spectral regions, rather than a sine wave.
    if(speaking&&!sample.active&&actualAudio&&this.energy>.035){
      const total=this.audio.low+this.audio.mid+this.audio.high+.001;
      const rounded=clamp((this.audio.low/total-.38)*2.4);
      const narrow=clamp((this.audio.high/total-.25)*1.6);
      sample.pose.jawOpen=clamp(this.energy*.60,.0,.46);
      sample.pose.mouthFunnel=rounded*this.energy*.5;
      sample.pose.mouthPucker=rounded*this.energy*.30;
      sample.pose.mouthStretchLeft=sample.pose.mouthStretchRight=narrow*this.energy*.25;
      sample.name='audio';
    }
    const speechGain=actualAudio?clamp(this.energy*2.7,.10,1.1):1;
    if(speaking){
      for(const key of Object.keys(sample.pose))sample.pose[key]*=speechGain;
      if(sample.name==='MBP')sample.pose.jawOpen*=.35;
    }

    for(const e of Object.keys(this.expressionMix))this.expressionMix[e]=fade(this.expressionMix[e],this.expression===e?1:0,dt,3.2);
    const warm=this.expressionMix.warm,curious=this.expressionMix.curious,focused=this.expressionMix.focused;
    const target=sample.pose;
    target.mouthSmileLeft+=warm*.24+(listen?.028:.01);
    target.mouthSmileRight+=warm*.22+(listen?.025:.01);
    target.cheekSquintLeft+=warm*.105;
    target.cheekSquintRight+=warm*.10;
    target.browInnerUp+=curious*.26+(this.mode==='thinking'?.085:0)+(listen?.045:0);
    target.browOuterUpLeft+=curious*.14;
    target.browOuterUpRight+=curious*.10;
    target.browDownLeft+=focused*.16;
    target.browDownRight+=focused*.13;
    target.eyeSquintLeft+=.035+focused*.06;
    target.eyeSquintRight+=.030+focused*.06;

    if(!this.reducedMotion&&now>=this.nextSaccade){
      const scale=this.mode==='thinking'?.48:speaking?.12:listen?.08:.17;
      this.gazeTarget.x=(this.random()-.5)*scale;
      this.gazeTarget.y=(this.random()-.5)*scale*.52+(this.mode==='thinking'?.10:0);
      this.nextSaccade=now+1.1+this.random()*2.7;
      if(this.random()<.22)this.nextBlink=Math.min(this.nextBlink,now+.10);
    }
    const gazeX=this.pointer.active?this.pointer.x*.48:this.gazeTarget.x;
    const gazeY=this.pointer.active?-this.pointer.y*.26:this.gazeTarget.y;
    this.gaze.x=fade(this.gaze.x,this.reducedMotion?0:gazeX,dt,25);
    this.gaze.y=fade(this.gaze.y,this.reducedMotion?0:gazeY,dt,22);
    target.eyeLookOutLeft=target.eyeLookInRight=clamp(-this.gaze.x);
    target.eyeLookInLeft=target.eyeLookOutRight=clamp(this.gaze.x);
    target.eyeLookUpLeft=target.eyeLookUpRight=clamp(this.gaze.y);
    target.eyeLookDownLeft=target.eyeLookDownRight=clamp(-this.gaze.y);
    target.eyeWideLeft=target.eyeWideRight=clamp(this.gaze.y)*.15;

    if(!this.reducedMotion&&now>=this.nextBlink){
      this.blinkStart=now;this.blinkDuration=.19+this.random()*.07;this.blinkSkew=.004+this.random()*.007;
      this.nextBlink=now+(listen?3.1:3.6)+this.random()*3.2;
      if(this.random()<.08)this.doubleBlink=now+.29;
    }
    if(now>=this.doubleBlink){this.blinkStart=now;this.doubleBlink=Infinity;}
    target.eyeBlinkLeft=this.reducedMotion?0:this.blinkValue(now);
    target.eyeBlinkRight=this.reducedMotion?0:this.blinkValue(now,this.blinkSkew);

    // Discourse gestures are sparse events. They are driven by turn transitions,
    // punctuation and vocal emphasis, not a continuously bobbing head loop.
    if(speaking&&actualAudio&&this.energy-this.prevEnergy>.10&&now-this.lastAccent>1.45){
      this.lastAccent=now;this.gestures.push({start:now,duration:.62,amount:.011+this.energy*.012,type:'accent',source:'speech'});
    }
    this.prevEnergy=this.energy;
    this.gestures=this.gestures.filter(g=>now-g.start<g.duration);
    let nod=0,accent=0;
    for(const gesture of this.gestures){
      const t=(now-gesture.start)/gesture.duration;
      if(t<0||t>1)continue;
      const value=Math.sin(Math.PI*t)**2*Math.sin(Math.PI*t*2)*gesture.amount;
      nod+=value;
      if(gesture.type==='accent')accent+=Math.sin(Math.PI*t)**2;
    }
    target.browInnerUp+=accent*.07;
    target.browOuterUpLeft+=accent*.025;
    const idleYaw=(Math.sin(local*.31)*.008+Math.sin(local*.13+1)*.005)*physical;
    const idlePitch=Math.sin(local*.23+.7)*.006*physical;
    const headX=(this.gaze.x*.20+idleYaw)*physical;
    const headY=(-this.gaze.y*.14+idlePitch+nod)*physical;
    const headZ=(this.gaze.x*-.045+Math.sin(local*.17)*.004)*physical;
    const yaw=this.headYaw.update(headX,dt,1.05);
    const pitch=this.headPitch.update(headY,dt,1.05);
    const roll=this.headRoll.update(headZ,dt,.85);
    for(const key of BLENDSHAPES){
      const speed=key.startsWith('eyeBlink')?60:key.startsWith('eyeLook')?27:key.startsWith('mouth')||key==='jawOpen'?29:7;
      this.pose[key]=clamp(fade(this.pose[key],clamp(target[key]),dt,speed));
    }
    Object.assign(this.output,this.pose,{yaw,pitch,roll,gazeX:this.gaze.x,gazeY:this.gaze.y,
      breath:this.reducedMotion?0:Math.sin(local*1.40)*.0035,
      energy:this.energy,viseme:speaking?sample.name:'rest',mode:this.mode,timing:this.speechTiming,
      jaw:this.pose.jawOpen,blinkL:this.pose.eyeBlinkLeft,blinkR:this.pose.eyeBlinkRight,
      smile:(this.pose.mouthSmileLeft+this.pose.mouthSmileRight)*.5,
      pucker:this.pose.mouthPucker,funnel:this.pose.mouthFunnel
    });
    return this.output;
  }
}

return {MotionDirector,BLENDSHAPES,textToVisemes,alignmentToSegments};})();
const AURARenderer=(()=>{
/**
 * AURA surface renderer — WebGL 2, no rendering dependency.
 * 52 anatomically authored blendshapes deform a subdivided head. Particles
 * retain their barycentric attachment to the skin as it moves. A depth pass
 * hides the far side, eye sockets and mouth interior correctly.
 */
const clamp = (x,a=0,b=1)=>Math.max(a,Math.min(b,x));
const types={Float32Array,Uint32Array,Uint16Array};
function matrixMultiply(a,b){const out=new Float32Array(16);for(let col=0;col<4;col++)for(let row=0;row<4;row++)for(let k=0;k<4;k++)out[col*4+row]+=a[k*4+row]*b[col*4+k];return out;}
function perspective(fov,aspect,near,far){const f=1/Math.tan(fov/2),nf=1/(near-far);return new Float32Array([f/aspect,0,0,0,0,f,0,0,0,0,(far+near)*nf,-1,0,0,2*far*near*nf,0]);}
function modelMatrix(yaw,pitch,roll,breath){
  const cy=Math.cos(yaw),sy=Math.sin(yaw),cx=Math.cos(pitch),sx=Math.sin(pitch),cz=Math.cos(roll),sz=Math.sin(roll);
  const y=new Float32Array([cy,0,-sy,0,0,1,0,0,sy,0,cy,0,0,0,0,1]);
  const x=new Float32Array([1,0,0,0,0,cx,sx,0,0,-sx,cx,0,0,0,0,1]);
  const z=new Float32Array([cz,sz,0,0,-sz,cz,0,0,0,0,1,0,0,0,0,1]);
  const m=matrixMultiply(z,matrixMultiply(y,x));
  // Pivot at the top of the neck, not in the middle of the nose.
  const py=-.77,pz=-.48;m[12]=-m[4]*py-m[8]*pz;m[13]=py-m[5]*py-m[9]*pz+breath;m[14]=pz-m[6]*py-m[10]*pz;
  return m;
}
const TRANSFORM=`
uniform mat4 uModel,uViewProjection;
uniform float uKind;
vec3 worldPoint(vec3 p){
  vec3 rotated=(uModel*vec4(p,1.)).xyz;
  if(uKind>2.5)rotated=mix(p,rotated,smoothstep(-1.75,-.72,p.y));
  rotated.x*=1.05;
  return rotated;
}`;
const DEPTH_VS=`#version 300 es
precision highp float;
layout(location=0)in vec3 position;
${TRANSFORM}
void main(){gl_Position=uViewProjection*vec4(worldPoint(position),1.);}`;
const DEPTH_FS=`#version 300 es
precision highp float;
out vec4 color;
void main(){color=vec4(0.,0.,0.,1.);}`;
const POINT_VS=`#version 300 es
precision highp float;
precision highp int;
layout(location=0)in uvec3 ids;
layout(location=1)in vec3 bary;
layout(location=2)in vec2 uv;
uniform sampler2D uPosition,uNormal;
uniform float uTime,uFlow,uScatter,uDissolve,uPointSize,uPixelRatio,uViewportHeight,uSeed;
${TRANSFORM}
out vec3 vNormal,vWorld,vLocal;
out float vAlpha,vKind,vSeed;
vec3 fetchVertex(sampler2D t,uint id){return texelFetch(t,ivec2(int(id)%256,int(id)/256),0).xyz;}
float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
void main(){
  vec3 a=fetchVertex(uPosition,ids.x),b=fetchVertex(uPosition,ids.y),c=fetchVertex(uPosition,ids.z);
  vec3 na=fetchVertex(uNormal,ids.x),nb=fetchVertex(uNormal,ids.y),nc=fetchVertex(uNormal,ids.z);
  float seed=hash(uv+vec2(float(ids.x)*.00013,uSeed));
  // Sculpt keeps an ordered lattice. Drift moves each dot locally along its
  // own triangle; the dot never teleports to a disconnected piece of skin.
  vec3 weights=bary;
  vec3 shuffled=vec3(hash(uv+2.1),hash(uv+5.8),hash(uv+9.3));shuffled/=dot(shuffled,vec3(1.));
  weights=mix(weights,shuffled,uScatter*.66);
  float flow=uFlow*(.14+.13*uScatter);
  vec3 wave=vec3(sin(uTime*.48+seed*19.),sin(uTime*.39+seed*31.),sin(uTime*.43+seed*43.));
  weights=max(vec3(.0001),weights+wave*flow*.12);weights/=dot(weights,vec3(1.));
  vec3 p=a*weights.x+b*weights.y+c*weights.z;
  vec3 n=normalize(na*weights.x+nb*weights.y+nc*weights.z);
  float faceMask=1.-smoothstep(.13,.38,abs(p.y-.26));
  float drift=(.002+uScatter*.008)*uFlow*(1.-faceMask*.72);
  p+=n*(.0028+drift*sin(uTime*.71+p.y*5.+seed*5.));
  // Reversible dispersal has stable per-dot destinations, no frame jitter.
  vec3 direction=normalize(n+vec3(sin(seed*152.),cos(seed*109.),sin(seed*87.))*.65);
  p+=direction*uDissolve*(.38+seed*.80);
  p.y+=uDissolve*.12*sin(seed*62.+uTime*.8);
  vec3 world=worldPoint(p);
  gl_Position=uViewProjection*vec4(world,1.);
  float scale=uViewportHeight/900.;
  float worldPerspective=6.6/max(2.6,gl_Position.w);
  float size=uPointSize*uPixelRatio*scale*worldPerspective*(.82+.30*seed);
  gl_PointSize=clamp(size,.7,7.5);
  vAlpha=(1.-uDissolve*.36)*(uKind>2.5?smoothstep(-1.85,-.9,p.y):1.);
  vNormal=normalize(mat3(uModel)*n);vWorld=world;vLocal=p;vKind=uKind;vSeed=seed;
}`;
const POINT_FS=`#version 300 es
precision highp float;
in vec3 vNormal,vWorld,vLocal;
in float vAlpha,vKind,vSeed;
uniform float uBrightness,uTime,uScatter;
uniform vec3 uEyeCenter,uEyeFront,uTint;
out vec4 color;
void main(){
  vec2 q=gl_PointCoord-.5;float distanceToCenter=length(q);
  float aa=max(fwidth(distanceToCenter),.045);
  float coverage=1.-smoothstep(.37-aa,.47+aa,distanceToCenter);
  if(coverage<.015||vAlpha<.008)discard;
  vec3 n=normalize(vNormal),view=normalize(vec3(0.,.12,6.6)-vWorld);
  float facing=dot(n,view);
  if(facing<-.08)discard;
  vec3 key=normalize(vec3(-.55,1.1,1.65)),fill=normalize(vec3(.8,.15,1.1));
  float light=.09+.70*pow(max(0.,dot(n,key)),.80)+.19*max(0.,dot(n,fill));
  light+=.25*pow(1.-max(0.,facing),2.)*max(.0,dot(n,normalize(vec3(.9,.4,-.1))));
  light*=.91+.09*vSeed;
  if(vKind>.5&&vKind<1.5){
    vec3 eyeN=normalize(vLocal-uEyeCenter);
    float r=acos(clamp(dot(eyeN,normalize(uEyeFront)),-1.,1.));
    float iris=1.-smoothstep(.32,.36,r),pupil=1.-smoothstep(.12,.16,r);
    light*=mix(.47,.23,iris);light*=1.-.96*pupil;
    light+=.19*exp(-pow((r-.32)/.02,2.));
    float glint=pow(max(0.,dot(eyeN,normalize(vec3(-.12,.22,1.)))),190.);
    light+=glint*.47;
  }
  if(vKind>1.5&&vKind<2.5)light*=.42;
  if(vKind>2.5)light*=.55;
  light*=uBrightness;
  float shimmer=1.+uScatter*.045*sin(vLocal.y*12.-uTime*.8+vSeed);
  vec3 tone=uTint*min(1.5,light*shimmer);
  color=vec4(tone,coverage*vAlpha*smoothstep(-.08,.10,facing));
}`;
function shader(gl,type,code){const s=gl.createShader(type);gl.shaderSource(s,code);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw new Error(gl.getShaderInfoLog(s));return s;}
function program(gl,vs,fs){const p=gl.createProgram(),v=shader(gl,gl.VERTEX_SHADER,vs),f=shader(gl,gl.FRAGMENT_SHADER,fs);gl.attachShader(p,v);gl.attachShader(p,f);gl.linkProgram(p);if(!gl.getProgramParameter(p,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(p));gl.deleteShader(v);gl.deleteShader(f);return p;}
function makeTexture(gl,height){const t=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,t);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA32F,256,height,0,gl.RGBA,gl.FLOAT,null);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);return t;}
function makeNeck(){
  const rows=88,columns=160,p=[],n=[],tri=[],pi=[],pw=[],uv=[];
  for(let row=0;row<=rows;row++){
    const t=row/rows,y=-.72-t*1.25,r=.43+.13*t+.25*Math.pow(Math.max(0,t-.62)/.38,2);
    for(let col=0;col<=columns;col++){
      const a=col/columns*Math.PI*2,cs=Math.cos(a),sn=Math.sin(a);
      p.push(cs*r,y,-.55+sn*(.39+.06*t));n.push(cs,.10,sn);
      if(row<rows&&col<columns){const v=row*(columns+1)+col;tri.push(v,v+columns+1,v+1,v+1,v+columns+1,v+columns+2);pi.push(v,v+1,v+columns+1);pw.push(1,0,0);uv.push(col/columns,t);}
    }
  }
  return {name:'neck',vertexCount:p.length/3,particleCount:pi.length/3,targetNames:[],center:[0,-1.3,-.55],arrays:{positions:new Float32Array(p),normals:new Float32Array(n),triangles:new Uint32Array(tri),deltas:new Float32Array(),normalDeltas:new Float32Array(),particleIndices:new Uint32Array(pi),particleWeights:new Float32Array(pw),particleUVs:new Float32Array(uv)}};
}
async function getAsset(name){
  if(globalThis.AURA_ASSETS?.[name]){
    const asset=globalThis.AURA_ASSETS[name];
    const binary=atob(typeof asset==='string'?asset:asset.data),bytes=new Uint8Array(binary.length);
    for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);
    if(asset.compression==='gzip'){
      if(typeof DecompressionStream==='undefined')throw new Error('This standalone demo needs a current browser. You can also run the complete project with npm start.');
      return new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
    }
    return bytes.buffer;
  }
  const response=await fetch(`./geometry/${name}`);if(!response.ok)throw new Error(`Could not load facial geometry (${response.status}).`);return response.arrayBuffer();
}
class ParticleFace {
  constructor(canvas,{onProgress=()=>{},onContextLost=()=>{}}={}){
    this.canvas=canvas;this.onProgress=onProgress;this.gl=canvas.getContext('webgl2',{alpha:true,antialias:true,powerPreference:'high-performance',preserveDrawingBuffer:false});
    if(!this.gl)throw new Error('AURA needs WebGL 2. Enable graphics acceleration in your browser, then reload.');
    this.controls={flow:.40,scatter:0,dissolve:0,density:1,pointSize:1.9,brightness:1.40,yaw:0,pitch:0,zoom:1,tint:[1,1,1]};
    this.smooth={scatter:0,dissolve:0,yaw:0,pitch:0,zoom:1};this.meshes=[];this.ready=false;this.disposed=false;
    const gl=this.gl;this.depthProgram=program(gl,DEPTH_VS,DEPTH_FS);this.pointProgram=program(gl,POINT_VS,POINT_FS);this.uniformCache=new Map();
    this.handleContextLoss=e=>{e.preventDefault();this.ready=false;onContextLost();};canvas.addEventListener('webglcontextlost',this.handleContextLoss);
    this.resizeObserver=new ResizeObserver(()=>this.resize());this.resizeObserver.observe(canvas);this.resize();
  }
  async load(){
    let manifest=globalThis.AURA_MANIFEST;
    if(!manifest){const r=await fetch('./geometry/head.json');if(!r.ok)throw new Error('The face data could not be loaded. Open the included standalone demo or run npm start.');manifest=await r.json();}
    this.manifest=manifest;const names=['head','eyeLeft','eyeRight','teeth'];
    for(let i=0;i<names.length;i++){
      const name=names[i],info=manifest.meshes[name],buffer=await getAsset(info.file),arrays={};
      if(buffer.byteLength!==info.byteLength)throw new Error(`Incomplete geometry: ${name}`);
      for(const [key,item] of Object.entries(info.layout))arrays[key]=new types[item.type](buffer,item.byteOffset,item.length);
      this.meshes.push(this.buildMesh({name,...info,arrays}));this.onProgress((i+1)/5);
    }
    this.meshes.push(this.buildMesh(makeNeck()));this.ready=true;this.onProgress(1);return this;
  }
  buildMesh(info){
    const gl=this.gl,a=info.arrays;
    const mesh={...info,kind:info.name==='head'?0:info.name.startsWith('eye')?1:info.name==='teeth'?2:3,
      positions:new Float32Array(a.positions),normals:new Float32Array(a.normals),lastWeights:new Float32Array(info.targetNames.length).fill(-1),
      keys:info.targetNames.map(name=>name.replace(/_L$/,'Left').replace(/_R$/,'Right')),
      height:Math.ceil(info.vertexCount/256),first:true,lastGaze:[NaN,NaN]};
    mesh.positionPixels=new Float32Array(mesh.height*256*4);mesh.normalPixels=new Float32Array(mesh.height*256*4);
    mesh.positionTexture=makeTexture(gl,mesh.height);mesh.normalTexture=makeTexture(gl,mesh.height);
    mesh.depthVAO=gl.createVertexArray();gl.bindVertexArray(mesh.depthVAO);
    mesh.positionBuffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,mesh.positionBuffer);gl.bufferData(gl.ARRAY_BUFFER,mesh.positions,gl.DYNAMIC_DRAW);gl.enableVertexAttribArray(0);gl.vertexAttribPointer(0,3,gl.FLOAT,false,0,0);
    mesh.indexBuffer=gl.createBuffer();gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,mesh.indexBuffer);gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,a.triangles,gl.STATIC_DRAW);
    mesh.pointVAO=gl.createVertexArray();gl.bindVertexArray(mesh.pointVAO);mesh.pointBuffers=[];
    for(const [loc,array,size,integer] of [[0,a.particleIndices,3,true],[1,a.particleWeights,3,false],[2,a.particleUVs,2,false]]){
      const b=gl.createBuffer();mesh.pointBuffers.push(b);gl.bindBuffer(gl.ARRAY_BUFFER,b);gl.bufferData(gl.ARRAY_BUFFER,array,gl.STATIC_DRAW);gl.enableVertexAttribArray(loc);
      if(integer)gl.vertexAttribIPointer(loc,size,gl.UNSIGNED_INT,0,0);else gl.vertexAttribPointer(loc,size,gl.FLOAT,false,0,0);
    }
    gl.bindVertexArray(null);this.uploadMesh(mesh);return mesh;
  }
  uploadMesh(mesh){
    const gl=this.gl;
    for(let i=0,j=0,k=0;i<mesh.vertexCount;i++,j+=3,k+=4){
      mesh.positionPixels[k]=mesh.positions[j];mesh.positionPixels[k+1]=mesh.positions[j+1];mesh.positionPixels[k+2]=mesh.positions[j+2];
      const nx=mesh.normals[j],ny=mesh.normals[j+1],nz=mesh.normals[j+2],length=Math.hypot(nx,ny,nz)||1;
      mesh.normalPixels[k]=nx/length;mesh.normalPixels[k+1]=ny/length;mesh.normalPixels[k+2]=nz/length;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER,mesh.positionBuffer);gl.bufferSubData(gl.ARRAY_BUFFER,0,mesh.positions);
    gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,mesh.positionTexture);gl.texSubImage2D(gl.TEXTURE_2D,0,0,0,256,mesh.height,gl.RGBA,gl.FLOAT,mesh.positionPixels);
    gl.activeTexture(gl.TEXTURE1);gl.bindTexture(gl.TEXTURE_2D,mesh.normalTexture);gl.texSubImage2D(gl.TEXTURE_2D,0,0,0,256,mesh.height,gl.RGBA,gl.FLOAT,mesh.normalPixels);
  }
  deform(mesh,frame){
    if(mesh.kind===0){
      let changed=mesh.first;const weights=mesh.keys.map((key,i)=>{
        let w=frame[key]||0;
        // A slightly relaxed resting eyelid avoids a permanently startled look.
        if(key==='eyeBlinkLeft'||key==='eyeBlinkRight')w=.07+w*.93;
        if(Math.abs(w-mesh.lastWeights[i])>.00025)changed=true;return w;
      });
      if(!changed)return;mesh.first=false;mesh.positions.set(mesh.arrays.positions);mesh.normals.set(mesh.arrays.normals);
      const length=mesh.positions.length;
      for(let k=0;k<weights.length;k++){
        const w=weights[k];mesh.lastWeights[k]=w;if(w<.0001)continue;const offset=k*length;
        for(let j=0;j<length;j++){mesh.positions[j]+=mesh.arrays.deltas[offset+j]*w;mesh.normals[j]+=mesh.arrays.normalDeltas[offset+j]*w;}
      }
      this.uploadMesh(mesh);
    }else if(mesh.kind===1){
      const gx=(frame.gazeX||0)*.47,gy=(frame.gazeY||0)*.47;
      if(!mesh.first&&Math.abs(gx-mesh.lastGaze[0])<.0002&&Math.abs(gy-mesh.lastGaze[1])<.0002)return;
      mesh.first=false;mesh.lastGaze=[gx,gy];const cx=Math.cos(gy),sx=Math.sin(gy),cy=Math.cos(gx),sy=Math.sin(gx),center=mesh.center;
      for(let j=0;j<mesh.positions.length;j+=3){
        const x=mesh.arrays.positions[j]-center[0],y=mesh.arrays.positions[j+1]-center[1],z=mesh.arrays.positions[j+2]-center[2];
        const yy=y*cx+z*sx,zz=z*cx-y*sx;
        mesh.positions[j]=x*cy+zz*sy+center[0];mesh.positions[j+1]=yy+center[1];mesh.positions[j+2]=zz*cy-x*sy+center[2];
        const nx=mesh.arrays.normals[j],ny=mesh.arrays.normals[j+1],nz=mesh.arrays.normals[j+2],nny=ny*cx+nz*sx,nnz=nz*cx-ny*sx;
        mesh.normals[j]=nx*cy+nnz*sy;mesh.normals[j+1]=nny;mesh.normals[j+2]=nnz*cy-nx*sy;
      }
      mesh.eyeFront=[sy*cx,sx,cy*cx];this.uploadMesh(mesh);
    }
  }
  resize(){
    const r=this.canvas.getBoundingClientRect();this.width=Math.max(1,r.width);this.height=Math.max(1,r.height);this.pixelRatio=Math.min(devicePixelRatio||1,2);
    const w=Math.round(this.width*this.pixelRatio),h=Math.round(this.height*this.pixelRatio);
    if(this.canvas.width!==w||this.canvas.height!==h){this.canvas.width=w;this.canvas.height=h;this.gl.viewport(0,0,w,h);}
  }
  uniform(p,key,type,value){
    let cache=this.uniformCache.get(p);if(!cache){cache={};this.uniformCache.set(p,cache);}let loc=cache[key];if(loc===undefined){loc=this.gl.getUniformLocation(p,key);cache[key]=loc;}if(loc===null)return;
    const gl=this.gl;if(type==='m')gl.uniformMatrix4fv(loc,false,value);else if(type==='3')gl.uniform3fv(loc,value);else if(type==='i')gl.uniform1i(loc,value);else gl.uniform1f(loc,value);
  }
  frame(frame,time,dt){
    if(!this.ready||this.disposed)return;
    const gl=this.gl,c=this.controls,s=this.smooth,blend=1-Math.exp(-dt*5);
    for(const key of ['scatter','dissolve','yaw','pitch','zoom'])s[key]+=(c[key]-s[key])*blend;
    for(const mesh of this.meshes)this.deform(mesh,frame);
    const model=modelMatrix((frame.yaw||0)+s.yaw-.035,(frame.pitch||0)+s.pitch-.055,frame.roll||0,frame.breath||0);
    // Vertical FOV adapts on narrow displays, preserving the complete face.
    const aspect=this.width/this.height,fov=(aspect<.8?37.5:29)*Math.PI/180;
    const proj=perspective(fov/s.zoom,aspect,.1,30);
    const view=new Float32Array([1,0,0,0,0,1,0,0,0,0,1,0,0,-.05,-6.6,1]);
    const vp=matrixMultiply(proj,view);
    gl.clearColor(0,0,0,0);gl.clearDepth(1);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);gl.depthFunc(gl.LEQUAL);gl.disable(gl.CULL_FACE);
    // Hidden solid geometry is used solely for visibility, not visible skin.
    gl.disable(gl.BLEND);gl.depthMask(true);gl.colorMask(false,false,false,false);gl.enable(gl.POLYGON_OFFSET_FILL);gl.polygonOffset(1,1);
    gl.useProgram(this.depthProgram);this.uniform(this.depthProgram,'uModel','m',model);this.uniform(this.depthProgram,'uViewProjection','m',vp);
    if(s.dissolve<.35){for(const mesh of this.meshes){this.uniform(this.depthProgram,'uKind','f',mesh.kind);gl.bindVertexArray(mesh.depthVAO);gl.drawElements(gl.TRIANGLES,mesh.arrays.triangles.length,gl.UNSIGNED_INT,0);}}
    gl.disable(gl.POLYGON_OFFSET_FILL);gl.colorMask(true,true,true,true);gl.depthMask(false);gl.enable(gl.BLEND);gl.blendFuncSeparate(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA,gl.ONE,gl.ONE_MINUS_SRC_ALPHA);
    const p=this.pointProgram;gl.useProgram(p);
    this.uniform(p,'uModel','m',model);this.uniform(p,'uViewProjection','m',vp);
    for(const [key,value] of Object.entries({uTime:time,uFlow:c.flow,uScatter:s.scatter,uDissolve:s.dissolve,uPointSize:c.pointSize,uPixelRatio:this.pixelRatio,uViewportHeight:this.height,uBrightness:c.brightness}))this.uniform(p,key,'f',value);
    this.uniform(p,'uPosition','i',0);this.uniform(p,'uNormal','i',1);this.uniform(p,'uTint','3',c.tint);
    for(const mesh of this.meshes){
      this.uniform(p,'uKind','f',mesh.kind);this.uniform(p,'uSeed','f',mesh.kind*5.7);this.uniform(p,'uEyeCenter','3',mesh.center);this.uniform(p,'uEyeFront','3',mesh.eyeFront||[0,0,1]);
      gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,mesh.positionTexture);gl.activeTexture(gl.TEXTURE1);gl.bindTexture(gl.TEXTURE_2D,mesh.normalTexture);gl.bindVertexArray(mesh.pointVAO);
      const fraction=clamp(c.density*(mesh.kind===0?1:mesh.kind===1?.9:.8),.15,1);gl.drawArrays(gl.POINTS,0,Math.floor(mesh.particleCount*fraction));
    }
    gl.bindVertexArray(null);gl.depthMask(true);
  }
  get particleCount(){return this.meshes.reduce((sum,m)=>sum+Math.floor(m.particleCount*clamp(this.controls.density*(m.kind===0?1:m.kind===1?.9:.8),.15,1)),0);}
  dispose(){this.disposed=true;this.resizeObserver.disconnect();this.canvas.removeEventListener('webglcontextlost',this.handleContextLoss);const gl=this.gl;for(const mesh of this.meshes){gl.deleteTexture(mesh.positionTexture);gl.deleteTexture(mesh.normalTexture);gl.deleteVertexArray(mesh.depthVAO);gl.deleteVertexArray(mesh.pointVAO);for(const buffer of [mesh.positionBuffer,mesh.indexBuffer,...mesh.pointBuffers])gl.deleteBuffer(buffer);}gl.deleteProgram(this.depthProgram);gl.deleteProgram(this.pointProgram);}
}

return {ParticleFace};})();
// Jarvis presence driver. The face shows only what the app tells it: the real voice
// state and the measured audio levels. It never opens a microphone, a socket or a URL.
const {MotionDirector}=AURAMotion;
const {ParticleFace}=AURARenderer;
const canvas=document.getElementById('face');
const reducedMotion=matchMedia('(prefers-reduced-motion: reduce)').matches;
const motion=new MotionDirector({reducedMotion});
const MODES={idle:'idle',connecting:'connecting',listening:'listening',thinking:'thinking',speaking:'speaking'};
const state={mode:'idle',input:0,output:0,paused:false,still:reducedMotion,tint:[.90,.99,.99],brightness:1.6,zoom:1.2};
let renderer=null,last=performance.now()/1000,lastDraw=0,drewStill=false;
const report=(event,detail)=>{try{window.webkit?.messageHandlers?.presence?.postMessage({event,detail:detail===undefined?null:String(detail).slice(0,300)});}catch(_){}};
const unit=v=>Math.max(0,Math.min(1,Number.isFinite(+v)?+v:0));
window.jarvisPresence={
  ready:false,
  /** mode: idle|connecting|listening|thinking|speaking. input/output: measured RMS levels, 0…1. */
  set(next={}){
    if(typeof next.mode==='string'&&MODES[next.mode]&&state.mode!==next.mode){state.mode=next.mode;motion.setMode(next.mode);drewStill=false;}
    if(next.input!==undefined)state.input=unit(next.input);
    if(next.output!==undefined)state.output=unit(next.output);
    if(next.paused!==undefined){state.paused=!!next.paused;if(!state.paused)last=performance.now()/1000;}
    if(next.still!==undefined){state.still=!!next.still||reducedMotion;motion.setReducedMotion(state.still);drewStill=false;}
    if(Array.isArray(next.tint)&&next.tint.length===3){state.tint=next.tint.map(unit);drewStill=false;}
    if(next.brightness!==undefined){state.brightness=.4+unit(next.brightness/2)*2;drewStill=false;}
    if(next.zoom!==undefined){state.zoom=Math.max(.8,Math.min(1.8,+next.zoom||1));drewStill=false;}
    if(renderer){renderer.controls.tint=state.tint;renderer.controls.brightness=state.brightness;renderer.controls.zoom=state.zoom;}
  },
};
function animate(ms){
  requestAnimationFrame(animate);
  if(!renderer||state.paused)return;
  const now=ms/1000;
  // Thirty frames a second is plenty for a face and halves the work of a display-rate loop.
  if(now-lastDraw<1/31)return;
  if(state.still&&drewStill)return;
  const dt=Math.min(.1,Math.max(0,now-last));last=now;lastDraw=now;
  if(state.mode==='speaking'){
    // Only a single measured level is available, so it is split across the bands in fixed proportion.
    const energy=state.output;
    motion.setAudioFeatures({energy,low:energy*.45,mid:energy*.35,high:energy*.20},now);
  }
  const pose=motion.update(dt,now);
  renderer.frame(pose,now,dt);
  drewStill=true;
}
(async()=>{
  try{
    renderer=new ParticleFace(canvas,{onContextLost:()=>report('lost')});
    renderer.controls.tint=state.tint;renderer.controls.brightness=state.brightness;renderer.controls.zoom=state.zoom;renderer.smooth.zoom=state.zoom;
    await renderer.load();
    window.jarvisPresence.ready=true;report('ready',renderer.particleCount);
  }catch(error){report('failed',error&&error.message);}
})();
requestAnimationFrame(animate);

})();
