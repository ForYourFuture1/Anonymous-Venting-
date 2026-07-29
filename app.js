/* ============ تهيئة Firebase ============ */
firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();

/* ============ هيكلة الفعاليات المتعددة ============
   كل فعالية لها معرّف خاص، وكل بياناتها (مسجّلون/جولات/حالة/اختيارات)
   محفوظة تحت events/{eventId}/... منفصلة تمامًا عن أي فعالية أخرى.
   meta/active_event يحدد أي فعالية تستقبل التسجيلات الجديدة الآن.
   profiles/{phone} يحفظ بيانات المشارك الدائمة (اسم/جنس/تفضيل) عبر كل الفعاليات،
   حتى ما يحتاج يعيد تعبئتها كل مرة — بس يدخل جواله. */
const eventsRef = db.collection('events');
const activeEventPointerRef = db.collection('meta').doc('active_event');
const profilesRef = db.collection('profiles');

function eventRefs(eventId){
  const evDoc = eventsRef.doc(eventId);
  return {
    eventDoc: evDoc,
    participantsRef: evDoc.collection('participants'),
    selectionsRef: evDoc.collection('selections'),
    stateRef: evDoc.collection('meta').doc('event_state'),
    scheduleDocRef: evDoc.collection('meta').doc('schedule')
  };
}

/* يرجع معرّف الفعالية النشطة حاليًا، وينشئ فعالية أولى تلقائيًا إن لم توجد */
async function getOrCreateActiveEventId(){
  const doc = await activeEventPointerRef.get();
  if(doc.exists && doc.data().eventId) return doc.data().eventId;
  const newEv = await eventsRef.add({name:'الفعالية الأولى', createdAt: firebase.firestore.FieldValue.serverTimestamp()});
  await activeEventPointerRef.set({eventId:newEv.id});
  return newEv.id;
}

/* ينشئ فعالية جديدة فارغة ويجعلها النشطة (تستقبل التسجيلات الجديدة)،
   دون حذف أي بيانات من الفعاليات السابقة */
async function createNewEvent(name){
  const newEv = await eventsRef.add({
    name: name && name.trim() ? name.trim() : ('فعالية ' + new Date().toLocaleDateString('ar')),
    createdAt: firebase.firestore.FieldValue.serverTimestamp()
  });
  await activeEventPointerRef.set({eventId:newEv.id});
  return newEv.id;
}

/* ============ ملف المشارك الدائم (لتسريع التسجيل المتكرر) ============ */
function phoneKey(phone){
  return (phone||'').replace(/[^0-9]/g,'');
}

/* ============ مولّد الأسماء الوهمية ============
   يختار كلمة واحدة ذات معنى (أثر، فلك، شمس...) بدل اسم مركّب،
   باستخدام بصمة من وصف المستخدم لتفادي التكرار. */
/* عبارات وكلمات محايدة مبتكرة (مفاهيم، مو أسماء أعلام) تصلح للجنسين */
const NICK_NEUTRAL = [
  "رسالة مهمة","مستقبل","حياة","شعاع","هدوء","أمل جديد","لحظة صدق",
  "خطوة أولى","نقطة تحوّل","صوت داخلي","أثر باقٍ","طريق مختلف",
  "فكرة جديدة","نجم بعيد","طاقة إيجابية","بداية جديدة","أفق","درب",
  "فلك","شمس","قمر","سكون","صفاء","سلام","بحر","نسيم"
];
/* شخصيات علمية وثقافية معروفة وغير خلافية — مفصولة حسب الجنس لتفادي تعارض ملحوظ */
const NICK_MASC = ["أينشتاين","نيوتن","ابن سينا","الخوارزمي","ابن رشد","دافنشي","أرسطو","سقراط","بدر","هلال"];
const NICK_FEM  = ["مدام كوري","فيروز","أم كلثوم","رابعة العدوية","مي زيادة","ياسمين","ريم","سنا","ندى","منار"];

function hashText(str){
  let h = 0;
  for(let i=0;i<str.length;i++){
    h = (h*31 + str.charCodeAt(i)) >>> 0;
  }
  return h;
}

function generateNickname(description, usedNicknames, gender){
  const genderWords = gender === 'أنثى' ? NICK_FEM : NICK_MASC;
  const pool = [...NICK_NEUTRAL, ...genderWords];
  const seedBase = hashText(description || Math.random().toString());
  for(let attempt=0; attempt<pool.length; attempt++){
    const seed = seedBase + attempt*97;
    const word = pool[seed % pool.length];
    if(!usedNicknames.has(word)) return word;
  }
  // إذا انتهت الكلمات المتاحة (فعالية كبيرة جدًا)، أعد الاختيار عشوائيًا من نفس القائمة
  return pool[Math.floor(Math.random()*pool.length)];
}


/* ============ خوارزمية توزيع الجولات ============
   participants: [{id, gender: 'ذكر'|'أنثى', prefer: 'ذكر'|'أنثى'|'الجميع', goal: 'vent'|'meet'|'listen'}]
   rounds: عدد الجولات
   ترجع: [ [ [id,id], [id,id,id]... ], ... ] بطول = rounds
*/
function compatible(a, b){
  const aOk = a.prefer === 'الجميع' || a.prefer === b.gender;
  const bOk = b.prefer === 'الجميع' || b.prefer === a.gender;
  return aOk && bOk;
}

/* تقييم جودة تطابق الهدف بين شخصين: فضفضة+مستمع أو تعارف+تعارف = الأفضل،
   مستمع+مستمع = الأضعف (نتفاداه ما أمكن)، وباقي التوليفات متوسطة */
function goalScore(a, b){
  const idealVentListen = (a.goal==='vent' && b.goal==='listen') || (a.goal==='listen' && b.goal==='vent');
  const bothMeet = a.goal==='meet' && b.goal==='meet';
  if(idealVentListen || bothMeet) return 3;
  const bothListen = a.goal==='listen' && b.goal==='listen';
  if(bothListen) return 1;
  const meetMismatch = (a.goal==='meet') !== (b.goal==='meet');
  if(meetMismatch) return 1;
  return 2;
}

function shuffle(arr){
  const a = arr.slice();
  for(let i=a.length-1;i>0;i--){
    const j = Math.floor(Math.random()*(i+1));
    [a[i],a[j]] = [a[j],a[i]];
  }
  return a;
}

function buildRound(participants, metPairs, avoidPairs){
  avoidPairs = avoidPairs || new Set();
  const pool = shuffle(participants);
  const used = new Set();
  const groups = [];

  // يبحث عن أفضل شريك متاح حسب تطابق الهدف؛ allowRepeat=false يستبعد من قابله من قبل.
  // avoidPairs (شركاء الجولة الفائتة مباشرة) مستبعدة دائمًا مهما حصل — لا تكرار جولتين متتاليتين أبدًا.
  function pairPass(allowRepeat){
    for(const p of pool){
      if(used.has(p.id)) continue;
      let best = null, bestScore = -1;
      for(const q of pool){
        if(q.id === p.id || used.has(q.id)) continue;
        if(!compatible(p,q)) continue;
        const key = [p.id,q.id].sort().join('|');
        if(avoidPairs.has(key)) continue;
        if(!allowRepeat && metPairs.has(key)) continue;
        const score = goalScore(p,q);
        if(score > bestScore){ bestScore = score; best = q; }
      }
      if(best){
        used.add(p.id); used.add(best.id);
        groups.push([p.id, best.id]);
        metPairs.add([p.id,best.id].sort().join('|'));
      }
    }
  }

  pairPass(false); // المحاولة الأساسية: أفضل تطابق هدف بدون تكرار شريك سابق
  pairPass(true);  // تمرير أخير: يسمح بتكرار شريك من جولة أقدم (لا الجولة الفائتة) لتفادي جلوس أي شخص بمفرده

  // من تبقّى (نادرًا) بلا أي شريك متاح إطلاقًا: يبقى بمفرده هذه الجولة
  const leftovers = pool.filter(p=>!used.has(p.id));
  for(const p of leftovers){
    groups.push([p.id]); // بلا شريك متاح هذه الجولة
    used.add(p.id);
  }
  return groups;
}

function generateSchedule(participants, rounds=3){
  const metPairs = new Set();
  const allRounds = [];
  let lastRoundPairs = new Set();
  for(let r=0;r<rounds;r++){
    const round = buildRound(participants, metPairs, lastRoundPairs);
    allRounds.push(round);
    // سجّل أزواج هذه الجولة بالذات فقط، لمنع تكرارها بالجولة التالية مباشرة
    lastRoundPairs = new Set();
    round.forEach(group=>{
      if(group.length===2) lastRoundPairs.add([group[0],group[1]].sort().join('|'));
    });
  }
  return allRounds;
}

/* ============ تحويل التوزيع لصيغة يقبلها Firestore ============
   Firestore لا يقبل تخزين مصفوفة داخل مصفوفة مباشرة (rounds[round][group]
   كانت array of array of array وتفشل الكتابة بصمت)، فنغلّف كل مستوى
   بكائن (map) بدل مصفوفة خام قبل الحفظ، ونعكس التحويل عند القراءة. */
function scheduleToFirestore(rounds){
  return rounds.map(round => ({ groups: round.map(group => ({ members: group })) }));
}
function scheduleFromFirestore(rounds){
  if(!rounds) return [];
  return rounds.map(r => (r.groups||[]).map(g => g.members||[]));
}

/* ============ أدوات مساعدة عامة ============ */
function fmtClock(totalSeconds){
  const s = Math.max(0, Math.round(totalSeconds));
  const m = Math.floor(s/60);
  const sec = s%60;
  return `${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
}

function goalLabel(g){
  return {vent:'فضفضة', meet:'تعارف', listen:'مستمع/نصائح'}[g] || g;
}

/* ============ خيارات نوع الفضفضة / تخصص المستمع ============ */
const VENT_CATEGORIES = [
  'فضفضة عن علاقة عاطفية أو صداقة',
  'فضفضة عن العمل',
  'فضفضة عن مشاكل الذات',
  'فضفضة أخرى'
];
const LISTEN_CATEGORIES = [
  'مستمع لمشاكل العلاقات',
  'مستمع لمشاكل العمل',
  'مستمع لمشاكل الذات',
  'مستمع لأي مشكلة بهدف الاستماع والتخفيف'
];

/* يرجع أعضاء المجموعة (بدون الشخص نفسه) لجولة معيّنة من جدول محوّل بالفعل (plain rounds) */
function groupmatesFor(rounds, roundIndex, myId){
  const round = (rounds && rounds[roundIndex]) || [];
  for(const group of round){
    if(group.includes(myId)) return group.filter(id=>id!==myId);
  }
  return [];
}

