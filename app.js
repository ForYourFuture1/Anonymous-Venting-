/* ============ تهيئة Firebase ============ */
firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();

/* مسار وثيقة حالة الفعالية الحالية (جولة واحدة فعّالة في كل مرة) */
const stateRef = db.collection('meta').doc('event_state');
const participantsRef = db.collection('participants');
const selectionsRef = db.collection('selections');

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
