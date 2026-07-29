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
const NICK_WORDS = [
  "أثر","فلك","شمس","قمر","نجم","سنا","ضياء","وهج","شفق","غسق",
  "فجر","ندى","غيم","برق","رعد","ظل","صدى","سكون","همس","وله",
  "شغف","أمل","صفاء","رضا","سلام","طيف","رمل","بحر","موج","نسيم",
  "ياسمين","ريم","عنبر","مسك","سراج","بدر","هلال","درب","أفق","منار"
];

function hashText(str){
  let h = 0;
  for(let i=0;i<str.length;i++){
    h = (h*31 + str.charCodeAt(i)) >>> 0;
  }
  return h;
}

function generateNickname(description, usedNicknames){
  const seedBase = hashText(description || Math.random().toString());
  for(let attempt=0; attempt<NICK_WORDS.length; attempt++){
    const seed = seedBase + attempt*97;
    const word = NICK_WORDS[seed % NICK_WORDS.length];
    if(!usedNicknames.has(word)) return word;
  }
  // إذا انتهت الكلمات المتاحة (فعالية كبيرة جدًا)، أعد الاختيار عشوائيًا من نفس القائمة
  return NICK_WORDS[Math.floor(Math.random()*NICK_WORDS.length)];
}


/* ============ خوارزمية توزيع الجولات ============
   participants: [{id, gender: 'ذكر'|'أنثى', prefer: 'ذكر'|'أنثى'|'الجميع'}]
   rounds: عدد الجولات
   ترجع: [ [ [id,id], [id,id,id]... ], ... ] بطول = rounds
*/
function compatible(a, b){
  const aOk = a.prefer === 'الجميع' || a.prefer === b.gender;
  const bOk = b.prefer === 'الجميع' || b.prefer === a.gender;
  return aOk && bOk;
}

function shuffle(arr){
  const a = arr.slice();
  for(let i=a.length-1;i>0;i--){
    const j = Math.floor(Math.random()*(i+1));
    [a[i],a[j]] = [a[j],a[i]];
  }
  return a;
}

function buildRound(participants, metPairs){
  const pool = shuffle(participants);
  const used = new Set();
  const groups = [];

  for(const p of pool){
    if(used.has(p.id)) continue;
    // ابحث عن شريك متوافق لم يُقابله من قبل
    let partner = null;
    for(const q of pool){
      if(q.id === p.id || used.has(q.id)) continue;
      const key = [p.id,q.id].sort().join('|');
      if(metPairs.has(key)) continue;
      if(!compatible(p,q)) continue;
      partner = q;
      break;
    }
    if(partner){
      used.add(p.id); used.add(partner.id);
      groups.push([p.id, partner.id]);
      metPairs.add([p.id,partner.id].sort().join('|'));
    }
  }
  // من تبقّى بلا شريك: أضفه لأقرب مجموعة متوافقة معه (يصبح ثلاثيًا) وإلا يبقى منفردًا هذه الجولة
  const leftovers = pool.filter(p=>!used.has(p.id));
  for(const p of leftovers){
    let placed = false;
    for(const g of groups){
      if(g.length>=3) continue;
      const gp = participants.filter(x=>g.includes(x.id));
      if(gp.every(m=>compatible(p,m))){
        g.push(p.id);
        used.add(p.id);
        placed = true;
        break;
      }
    }
    if(!placed){
      groups.push([p.id]); // بلا شريك متاح هذه الجولة
      used.add(p.id);
    }
  }
  return groups;
}

function generateSchedule(participants, rounds=3){
  const metPairs = new Set();
  const allRounds = [];
  for(let r=0;r<rounds;r++){
    allRounds.push(buildRound(participants, metPairs));
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

