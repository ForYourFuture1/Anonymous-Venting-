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
  "فلك","شمس","سكون","سلام","بحر"
];
/* شخصيات علمية وثقافية معروفة وغير خلافية — مفصولة حسب الجنس لتفادي تعارض ملحوظ */
const NICK_MASC = ["أينشتاين","نيوتن","ابن سينا","الخوارزمي","ابن رشد","دافنشي","أرسطو","سقراط","بدر","هلال","نسيم"];
const NICK_FEM  = ["مدام كوري","فيروز","أم كلثوم","رابعة العدوية","مي زيادة","ياسمين","ريم","سنا","ندى","منار","قمر","صفاء"];

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
   بكائن (map) بدل مصفوفة خام قبل الحفظ، ونعكس التحويل عند القراءة.
   topicsMap (اختياري): topicsMap[roundIndex][groupIndex] = [مفتاح1,مفتاح2,مفتاح3] أو null */
function scheduleToFirestore(rounds, topicsMap){
  return rounds.map((round, ri) => ({
    groups: round.map((group, gi) => ({
      members: group,
      topics: (topicsMap && topicsMap[ri] && topicsMap[ri][gi]) || null
    }))
  }));
}
function scheduleFromFirestore(rounds){
  if(!rounds) return [];
  return rounds.map(r => (r.groups||[]).map(g => g.members||[]));
}
/* يرجع فقط توزيع الفقرات (بدون الأعضاء) بنفس ترتيب الجولات/المجموعات */
function scheduleTopicsFromFirestore(rounds){
  if(!rounds) return [];
  return rounds.map(r => (r.groups||[]).map(g => g.topics || null));
}

/* ============ فضفضة + مستمع: تعارف قصير ثم كشف موضوع الفضفضة للمستمع ============ */
const VENT_REMINDER = 'الفضفضة وإسداء النصائح من شخص غريب ليست حلاً ولا تغني عن مشاورة أهل الخبرة، المستمع فقط للتخفيف، وأخذ آرائه من عدمها مسؤولية صاحب المشكلة.';
const ICEBREAKER_QUESTIONS = [
  'وش أكثر شي يوصفك بكلمة وحدة؟',
  'ليش قررت تحضر هذي الفعالية بالذات؟',
  'وش آخر شي خلاك تضحك اليوم؟'
];

/* يحدد دور كل طرف إن كانت المجموعة "فضفضة + مستمع" بالضبط، ويرجع null غير ذلك */
function getVentListenInfo(me, mate){
  if(me.goal==='vent' && mate.goal==='listen') return {role:'vent', subCategory: me.subCategory};
  if(me.goal==='listen' && mate.goal==='vent') return {role:'listen', subCategory: mate.subCategory};
  return null;
}


/* ============ بنك فقرات "تعارف" التفاعلية ============
   لكل زوج اختار الطرفان "تعارف": أول 4 دقائق تعارف حر، ثم 3 فقرات (٥:٢٠ لكل وحدة)
   بموضوع واحد يظهر للطرفين، وسؤال/سيناريو جدلي مختلف حسب الجنس (أو حسب الطرف
   في حال تطابق الجنسين) لإظهار اختلاف وجهات النظر. */
const MEET_INTRO_SECONDS = 240;      // 4 دقائق تعارف حر
const MEET_SEGMENT_SECONDS = 320;    // 5:20 لكل فقرة × 3 = 16 دقيقة، + 4 = 20

const MIXED_TOPICS = [
  {key:'marriage', label:'الزواج',
    male:['لو تزوجت، هل تتوقع من زوجتك توقف طموحها المهني عشان البيت والأطفال؟ ليه؟',
          'هل ترضى إن تكون زوجتك هي المعيل الأساسي للبيت؟'],
    female:['لو تزوجتِ، هل توافقين تتنازلين عن طموحك المهني عشان البيت والأطفال؟',
            'هل ترضين إن يكون بيتك المستقبلي أبعد عن أهلك بسبب شغل زوجك؟']},
  {key:'travel', label:'السفر',
    male:['هل ترتاح إذا سافرت شريكتك المستقبلية وحدها مع صديقاتها بدون ما تعرف كل التفاصيل؟',
          'وش أطول مدة ترتاح تكون فيها شريكتك مسافرة بعيد عنك؟'],
    female:['هل ترتاحين إذا سافر شريكك المستقبلي وحده مع أصحابه بدون ما يخبرك بكل التفاصيل؟',
            'تفضّلين السفر مع شريكك دائمًا، أو يكون لك رحلاتك الخاصة أيضًا؟']},
  {key:'opp_friend', label:'صداقة الجنسين',
    male:['هل تقبل إن شريكتك المستقبلية تحتفظ بصداقة قوية مع رجل من ماضيها؟',
          'هل يضايقك إن شريكتك تتكلم بخصوصية مع صديق مقرب أكثر منك ببعض المواضيع؟'],
    female:['هل تقبلين إن شريكك المستقبلي يحتفظ بصداقة قوية مع امرأة من ماضيه؟',
            'هل تقبلين إن شريكك يخرج بمفرده مع صديقة قديمة لتناول القهوة؟']},
  {key:'toxic', label:'العلاقات السامة',
    male:['وش أكثر تصرف من المرأة تعتبره "تسميم" للعلاقة؟',
          'وش الحد الفاصل بين الغيرة الطبيعية والتحكم الزائد من وجهة نظرك؟'],
    female:['وش أكثر تصرف من الرجل تعتبرينه "تسميم" للعلاقة؟',
            'متى تحسّين إن السكوت المستمر من الطرف الثاني يتحول لتجاهل مؤذٍ؟']},
  {key:'money', label:'الصرف والمال',
    male:['هل تتوقع إن المرأة تشارك في مصاريف البيت حتى لو راتبها أعلى منك؟',
          'هل ترتاح لو شريكتك تدير الميزانية الكاملة للمنزل؟'],
    female:['هل تتوقعين إن الرجل يتحمل كل المصاريف حتى لو راتبك أعلى منه؟',
            'تفضّلين حساب بنكي مشترك بالكامل، أو تحتفظين باستقلالك المالي؟']},
  {key:'family_vs_partner', label:'العائلة مقابل الشريك',
    male:['لو صار خلاف بين أمك وزوجتك، مع مين بتقف ولماذا؟',
          'كيف توازن بين طلبات أمك وقرارات زوجتك في تربية الأطفال مستقبلاً؟'],
    female:['لو صار خلاف بين أهلك وزوجك، مع مين بتقفين ولماذا؟',
            'هل تشعرين إنه من حق أهلك التدخل في قرارات بيتك الزوجي؟']},
  {key:'change', label:'التغيير في العلاقة',
    male:['هل تتوقع من شريكتك المستقبلية تغيّر بعض عاداتها الشخصية عشانك بعد الارتباط؟',
          'وش أكثر عادة عندك ما تتوقع تتغيّر حتى بعد الزواج؟'],
    female:['هل تتوقعين من شريكك المستقبلي يغيّر بعض عاداته الشخصية عشانك بعد الارتباط؟',
            'هل جربتِ تتنازلين عن شيء يهمك عشان ترضين شريك بعلاقة سابقة؟']},
  {key:'double_standard', label:'معايير مزدوجة',
    male:['اذكر موقف تشوف فيه إن المجتمع يسامح الرجل على شيء ما يسامح فيه المرأة.',
          'ليش برأيك بعض الرجال يرفضون نفس التصرف اللي يسمحون فيه لأنفسهم؟'],
    female:['اذكري موقف تشوفين فيه إن المجتمع يسامح المرأة على شيء ما يسامح فيه الرجل.',
            'هل تشوفين إن المرأة أحيانًا تفرض معايير مزدوجة على نفسها بدون ضغط خارجي؟']},
  {key:'jealousy', label:'الغيرة',
    male:['متى تعتبر غيرة شريكتك عليك شيء جميل، ومتى تشوفها مبالغة؟',
          'هل سبق واتخذت قرار غيّرت فيه خطتك بسبب غيرتك على شريكتك؟'],
    female:['متى تعتبرين غيرة شريكك عليكِ شيء جميل، ومتى تشوفينها مبالغة؟',
            'كيف تتعاملين لو شعرتِ بالغيرة من شخص من ماضي شريكك؟']}
];

const SAME_TOPICS = [
  {key:'friendship', label:'الصداقة',
    a:['الصراحة الكاملة بين الأصدقاء تقوّي الصداقة أو تكسرها؟',
       'هل ممكن نفقد صداقة قوية بسبب سوء فهم بسيط؟'],
    b:['وش أكثر شيء يفقد الثقة بصديق مقرب؟',
       'كم عدد الأصدقاء المقربين اللي تعتبرهم كافين بحياتك؟']},
  {key:'family', label:'العائلة',
    a:['هل توافق على قرار عائلي حتى لو مو مقتنع فيه؟',
       'هل الصدق الكامل مع العائلة دايمًا الخيار الأفضل؟'],
    b:['متى يكون رفض رأي العائلة قرار صح؟',
       'هل تشوف إن حرية القرار الشخصي تتأثر بتوقعات العائلة؟']},
  {key:'ambition', label:'الطموح والعمل',
    a:['الاستقرار الوظيفي أهم ولا الشغف حتى لو الدخل أقل؟',
       'هل تضحي براحتك الشخصية عشان تحقق طموح مهني؟'],
    b:['هل نجاح شخص مقرب منك ممكن يسبب لك ضغط أو مقارنة؟',
       'هل الطموح الزائد ممكن يأثر على علاقاتك الاجتماعية؟']},
  {key:'independence', label:'الاستقلال المالي',
    a:['الاستقلال المالي الكامل يغيّر شكل العلاقات المستقبلية؟',
       'هل تشوف الاستقلال المالي مرتبط بالاستقلال العاطفي؟'],
    b:['هل من الصح مشاركة تفاصيل الوضع المالي مع أقرب الناس؟',
       'متى تشوف إن طلب المساعدة المالية من مقرب أمر طبيعي؟']},
  {key:'confidence', label:'الثقة بالنفس',
    a:['وش أكثر شيء يقلل من ثقة الشخص بنفسه؟',
       'هل تجارب الفشل السابقة أثرت على ثقتك بنفسك؟'],
    b:['هل الدفاع عن رأيك قدام ناس ما توافقك أمر سهل أو صعب؟',
       'كيف تتعامل مع النقد اللي يوجّه لك من شخص تحترمه؟']},
  {key:'friend_circle', label:'دائرة الأصدقاء',
    a:['دائرة صداقات صغيرة ومقربة أفضل، ولا واسعة ومتنوعة؟',
       'هل تفضّل صداقات طويلة الأمد حتى لو فيها ملل أحيانًا؟'],
    b:['قطع علاقة صداقة طويلة بسبب خلاف بسيط، تصرف صح أو متسرع؟',
       'هل تغيير دائرة الأصدقاء بمرحلة عمرية معينة أمر طبيعي؟']},
  {key:'privacy', label:'الخصوصية',
    a:['فيه أشياء ما يصح تنشارك حتى مع أقرب الناس؟',
       'هل شاركت يومًا سر ندمت على مشاركته لاحقًا؟'],
    b:['أقرب صديق لازم يعرف كل تفاصيل حياتك ولا فيه حدود؟',
       'هل الخصوصية بالعلاقات تقل كل ما زادت المقربية؟']},
  {key:'self_realization', label:'تحقيق الذات',
    a:['لو تقدر تغيّر قرار مهم بالماضي، وش يكون ولماذا؟',
       'وش أكبر خوف يمنعك عن اتخاذ قرار مهم؟'],
    b:['وش أكثر شيء يوقف الناس عن ملاحقة حلم يهمهم؟',
       'هل قارنت نفسك يومًا بشخص حقق ما تتمناه؟']},
  {key:'time_management', label:'إدارة الوقت',
    a:['التوازن بين الشغل والحياة الشخصية ممكن فعلاً ولا وهم؟',
       'هل الراحة النفسية تستاهل التضحية بجزء من الإنتاجية؟'],
    b:['أول شيء يُضحّى فيه لما يزيد الضغط، صح أو غلط؟',
       'كيف توازن بين التزاماتك ووقتك الشخصي بأيام الضغط؟']}
];

/* يحسب فقرات نقاش لكل الجولات: تُطبَّق على أي زوج إلا "فضفضة+مستمع" (له مساره
   الخاص الأهم). يضمن عدم تكرار نفس الموضوع لنفس الشخص عبر جولاته الثلاث،
   ويختار البنك المناسب (مختلط/نفس الجنس) لكل زوج — هذا يحل مشكلة الأزواج
   بتركيبة غير مثالية (مثل تعارف+مستمع) اللي ما كانوا يحصلون على أي محتوى. */
function computeMeetTopics(rounds, byId){
  const usedByPerson = {};
  function usedSet(id){
    if(!usedByPerson[id]) usedByPerson[id] = new Set();
    return usedByPerson[id];
  }
  return rounds.map(round => round.map(group => {
    if(group.length !== 2) return null;
    const a = byId[group[0]], b = byId[group[1]];
    if(!a || !b) return null;
    if(getVentListenInfo(a,b)) return null; // فضفضة+مستمع له محتواه الخاص، لا فقرات هنا

    const pool = (a.gender === b.gender) ? SAME_TOPICS : MIXED_TOPICS;
    const avoid = new Set([...usedSet(group[0]), ...usedSet(group[1])]);
    let available = pool.filter(t => !avoid.has(t.key));
    if(available.length < 3) available = pool.slice(); // احتياط: أعد تدوير البنك لو نفدت المواضيع الجديدة
    const chosen = shuffle(available).slice(0,3).map(t=>t.key);
    chosen.forEach(k=>{ usedSet(group[0]).add(k); usedSet(group[1]).add(k); });
    return chosen;
  }));
}

/* يرجع محتوى فقرة معيّنة مناسب للشخص الحالي: اسم الموضوع + قائمة أسئلة مساعدة
   (لا سؤال واحد ثابت) — حسب جنسه إن كانت مختلطة، أو حسب ترتيبه الثابت داخل
   الزوج إن كانت نفس الجنس، لضمان اختلاف الأسئلة بين الطرفين */
function getTopicPrompt(topicKey, me, mateId){
  const mt = MIXED_TOPICS.find(t=>t.key===topicKey);
  if(mt) return {label: mt.label, questions: me.gender==='أنثى' ? mt.female : mt.male};
  const st = SAME_TOPICS.find(t=>t.key===topicKey);
  if(st){
    const variant = (me.id < mateId) ? 'a' : 'b';
    return {label: st.label, questions: variant==='a' ? st.a : st.b};
  }
  return null;
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

