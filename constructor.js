/*
 * Конструктор тренировок — порт логики из «Мышцы и категории.html» (см.
 * Актуальное/Логика конструктора тренировок.md). Работает поверх базы «Атлас»:
 * тренируем выбранные ДВИЖЕНИЯ (по умолчанию «База»), баланс подходов, fractional-объём
 * по мышцам, сборка по дням bin-packing'ом, предупреждения, оборудование.
 *
 * Изолирован в IIFE; наружу — window.CONSTRUCTOR = { init }. Использует глобали
 * app.js (DATA, $, escHtml, showToast, goToScreen, SyncQueue) в рантайме.
 */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const esc = (s) => (window.escHtml ? window.escHtml(s) : String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"));

  /* ── Константы метода (гл. 6.1 учебника) ─────────────────────────────────── */
  const READINESS = {
    "низкая":  { effective: 3, target: 2, range: "1–2", rpe: "4–6",  character: "локальные" },
    "средняя": { effective: 6, target: 4, range: "2–4", rpe: "7–8",  character: "региональные" },
    "высокая": { effective: 9, target: 5, range: "4–6", rpe: "9–10", character: "глобальные" },
  };
  const OVERLOAD_OK = ["Разгибание в ТБС (ягодичные)", "Разгибание позвоночника"];
  const VOL_WARN = 20, VOL_MAX = 22, VOL_ALERT = 26, OVERTRAIN_FRAC = 9;
  const ERECTOR = "Мышца, выпрямляющая позвоночник";
  const CHAR = { "локальные": "loc", "региональные": "reg", "глобальные": "glob" };
  const CHAR_W = {
    "низкая":  { loc: 8, reg: 3, glob: 1 },
    "средняя": { loc: 3, reg: 5, glob: 3 },
    "высокая": { loc: 1, reg: 3, glob: 8 },
  };
  const LEVEL_RU = { global: "глобальные", regional: "региональные", local: "локальные",
    "глобальные": "глобальные", "региональные": "региональные", "локальные": "локальные" };
  const DAY_LETTERS = ["A", "Б", "В", "Г", "Д", "Е"];
  const WK_TRASH = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/></svg>`;

  // оборудование: свободный текст базы → один основной тег (приоритет сверху вниз)
  const EQUIP_RULES = [
    { tag: "Смита",         kw: /смита/i },
    { tag: "Блок/трос",     kw: /блочн|кроссовер|трос|(^|\W)блок/i },
    { tag: "Турник/брусья", kw: /перекладин|турник|брусь/i },
    { tag: "Тренажёр",      kw: /тренажер/i },
    { tag: "Штанги",        kw: /штанга|т-гриф|ez|диск|отягощ/i },
    { tag: "Гантели",       kw: /гантел/i },
    { tag: "Свой вес",      kw: /собственн/i },
    { tag: "Скамья",        kw: /скамья|скамь|римский|скотта/i },
  ];
  const EQUIP_TAGS = ["Штанги", "Гантели", "Блок/трос", "Тренажёр", "Смита", "Турник/брусья", "Свой вес", "Скамья", "Прочее"];
  const JOINT_HIGH = [
    { kw: /к подбородку|протяжк/i, zone: "плечо" },
    { kw: /брусь/i, zone: "плечо" },
    { kw: /доброе утро|гуд.?морнинг/i, zone: "поясница" },
    { kw: /наклон.{0,20}со штанг/i, zone: "поясница" },
  ];

  /* ── Данные (адаптер: база «Атлас» → форма генератора) ───────────────────── */
  let exercises = [], categories = [], muscles = [], workout = null, draftContext=null;
  let _cEdit = false;   // режим правки плана (покачивание + перетаскивание), как в упражнениях
  let _step = "parameters", _coverageLevel = 1, _selectedMovement = 0, _keepVolume = false;
  let _hasPlan = false, _resultSnapshot = null, _sessionActive = false, _sessionRevision = 0;
  let _cDrag = null;    // активное перетаскивание карточки

  function loadData() {
    const uid = DATA.getCurrentUser();
    categories = DATA.atlasMovements();  // {name, group, type}
    muscles = DATA.atlasMuscles();       // {name, group, visible, bundles}
    // Личные упражнения без atlas доступны вручную; подбор требует совпадения движения.
    exercises = DATA.getVisibleExercises(uid).filter(e => e.type !== "run" && !DATA.isHidden(uid, e.id)).map(e => ({
      id: e.id,
      name: e.name,
      equipment: e.atlas?.equipment || "",
      level: LEVEL_RU[e.atlas?.level] || "",
      categories: e.atlas?.categories || [],
      muscles: {
        target: e.atlas?.target || [],
        synergist: e.atlas?.synergist || [],
        stabilizer: e.atlas?.stabilizer || [],
      },
    }));
  }

  function defaultWorkout() {
    return {
      readiness: "средняя", target: READINESS["средняя"].target, reps: "10",
      priority: [], priorityBonus: 2, restrictions: [], settingsOpen: true,
      splitDays: 1, equipOff: [], pins: {}, movements: baseCats().map(c => c.name), manual: false, splitFromSingle: false,
      days: [{ name: "Тренировка 1", items: [] }], active: 0,
    };
  }
  function persist() {
    try {
      if(!draftContext||draftContext.owner!==Auth.userId()||draftContext.profile!==DATA.getCurrentUser())throw Error('Контекст изменился');
      localStorage.setItem('train_constructor_draft_'+JSON.stringify([draftContext.owner,draftContext.profile]),JSON.stringify(workout));
    }catch{showToast('Не удалось сохранить черновик конструктора. Не закрывайте страницу.');}
  }
  function loadWorkout() {
    try {
      let r = localStorage.getItem('train_constructor_draft_'+JSON.stringify([draftContext.owner,draftContext.profile]));
      const legacy=localStorage.getItem(`train_constructor_${draftContext.profile}`);
      if(!r&&legacy&&confirm('Есть старый план конструктора без отметки аккаунта. Это ваш план? Скопировать его в текущий аккаунт? Исходник сохранится.'))r=legacy;
      if (r) { const d = JSON.parse(r); if (d && Array.isArray(d.days) && d.days.length) {
        d.priority = d.priority || []; d.restrictions = d.restrictions || []; d.equipOff = d.equipOff || []; d.pins = d.pins || {};
        return d;
      } }
    } catch (e) {}
    return defaultWorkout();
  }

  /* ── Хелперы таксономии ──────────────────────────────────────────────────── */
  function baseCats() { return categories.filter(c => c.type === "База"); }
  function goalCats() { const names = workout.movements || baseCats().map(c => c.name); return categories.filter(c => names.includes(c.name)); }
  function exGoalCats(e) { return (e.categories || []).filter(n => goalCats().some(c => c.name === n)); }
  function activeDay() { if (workout.active === "all") return workout.days[0] || { items: [] }; if (workout.active >= workout.days.length) workout.active = workout.days.length - 1; return workout.days[workout.active]; }
  function totalVolume() { return workout.days.reduce((s, d) => s + dayVolume(d), 0); }
  function exById(id) { return exercises.find(e => e.id === id); }
  function exBaseCats(e) { return (e.categories || []).filter(cn => { const c = categories.find(x => x.name === cn); return c && c.type === "База"; }); }
  function exOptCats(e) { return (e.categories || []).filter(cn => { const c = categories.find(x => x.name === cn); return c && c.type === "Опция"; }); }
  function exCharacter(e) {
    if (e.level === "глобальные" || e.level === "региональные" || e.level === "локальные") return e.level;
    const b = exBaseCats(e).length;
    const t = (e.muscles.target || []).length, mus = t + (e.muscles.synergist || []).length;
    if (b >= 2 || mus >= 4) return "глобальные";
    if (b <= 1 && t <= 1 && mus <= 2) return "локальные";
    return "региональные";
  }
  function targetFor(name) { let t = +workout.target || 0; if (workout.priority.includes(name)) t += (+workout.priorityBonus || 0); return t; }

  /* ── Оборудование ────────────────────────────────────────────────────────── */
  function equipTag(e) { const s = (e && e.equipment) || ""; for (const r of EQUIP_RULES) if (r.kw.test(s)) return r.tag; return "Прочее"; }
  function equipAllowed(e) { const off = workout.equipOff || []; return !off.length || !off.includes(equipTag(e)); }
  function jointLoad(e) { const n = (e && e.name) || ""; for (const r of JOINT_HIGH) if (r.kw.test(n)) return r.zone; return null; }

  /* ── Нагрузка по пучкам (цель ×1.0, синергист ×0.5) ──────────────────────── */
  function loadKeys(e) {
    const out = [];
    const add = (o, w) => {
      const mm = muscles.find(x => x.name === o.muscle);
      if (o.bundle) out.push({ key: o.muscle + "|" + o.bundle, w });
      else if (mm && mm.bundles && mm.bundles.length) mm.bundles.forEach(b => out.push({ key: o.muscle + "|" + b, w }));
      else out.push({ key: o.muscle + "|", w });
    };
    (e.muscles.target || []).forEach(o => add(o, 1));
    (e.muscles.synergist || []).forEach(o => add(o, 0.5));
    return out;
  }
  function coverage(cov0) {
    const cov = cov0 || {}; categories.forEach(c => { if (!(c.name in cov)) cov[c.name] = 0; });
    activeDay().items.forEach(it => { const e = exById(it.exId); if (!e) return; (e.categories || []).forEach(cn => { if (cn in cov) cov[cn] += (+it.sets || 0); }); });
    return cov;
  }
  function microCoverage() {
    const cov = {}; categories.forEach(c => cov[c.name] = 0);
    workout.days.forEach(d => d.items.forEach(it => { const e = exById(it.exId); if (!e) return; (e.categories || []).forEach(cn => { if (cn in cov) cov[cn] += (+it.sets || 0); }); }));
    return cov;
  }
  function dayVolume(d) { return d.items.reduce((s, it) => s + (+it.sets || 0), 0); }
  function muscleStats() {
    const st = {};
    activeDay().items.forEach(it => { const e = exById(it.exId); if (!e) return; const s = +it.sets || 0;
      (e.muscles.target || []).forEach(o => { const x = st[o.muscle] = st[o.muscle] || { frac: 0, prim: 0, sec: 0 }; x.frac += s; x.prim++; });
      (e.muscles.synergist || []).forEach(o => { const x = st[o.muscle] = st[o.muscle] || { frac: 0, prim: 0, sec: 0 }; x.frac += s * 0.5; x.sec++; });
    });
    return st;
  }

  /* ── Генератор ───────────────────────────────────────────────────────────── */
  const randPick = (a) => a[Math.floor(Math.random() * a.length)];
  function compoundProb() { return ({ "низкая": 0.15, "средняя": 0.35, "высокая": 0.6 })[workout.readiness] || 0.4; }
  function charWeight(e) { const w = CHAR_W[workout.readiness] || { loc: 1, reg: 1, glob: 1 }; return Math.max(1, w[CHAR[exCharacter(e)]] || 1); }
  function weightedPick(list) {
    const ws = list.map(charWeight); let sum = ws.reduce((a, b) => a + b, 0), r = Math.random() * sum;
    for (let i = 0; i < list.length; i++) { r -= ws[i]; if (r <= 0) return list[i]; }
    return list[list.length - 1];
  }
  function pickForGen(list, load) {
    const ws = list.map(e => {
      let p = 0; loadKeys(e).forEach(x => { p += (load[x.key] || 0) * x.w; });
      const over = Math.max(0, (exBaseCats(e).length + exOptCats(e).length) - 2);
      return Math.max(0.05, charWeight(e)) / ((1 + p) * (1 + over));
    });
    let sum = ws.reduce((a, b) => a + b, 0), r = Math.random() * sum;
    for (let i = 0; i < list.length; i++) { r -= ws[i]; if (r <= 0) return list[i]; }
    return list[list.length - 1];
  }
  function exSig(e) { return exGoalCats(e).slice().sort().join(" | "); }
  function alternatives(e) { const sig = exSig(e); return exercises.filter(x => x.id !== e.id && exSig(x) === sig); }
  function replaceOptions(e) { const sig = exSig(e); return exercises.filter(x => exSig(x) === sig); }
  function setsForEx(e) { let s = 0; exGoalCats(e).forEach(c => { s = Math.max(s, targetFor(c)); }); return s || (+workout.target || 3); }

  function generateInto(movements) {
    const set = new Set(movements);
    const pool = exercises.filter(e => { const bc = exGoalCats(e); return bc.some(c => set.has(c)) && available(e); });
    const preserved = workout.days.flatMap(d => d.items).filter(it => it.locked && exById(it.exId) && available(exById(it.exId)) && exGoalCats(exById(it.exId)).some(c => set.has(c)));
    const uncovered = new Set(movements), usedIds = new Set(), chosen = preserved.map(it => ({ ...it })), load = {};
    chosen.forEach(it => {
      const e = exById(it.exId); usedIds.add(it.exId);
      exGoalCats(e).forEach(c => uncovered.delete(c));
      loadKeys(e).forEach(x => { load[x.key] = (load[x.key] || 0) + it.sets * x.w; });
    });
    if (workout.readiness !== "низкая") {
      const K = (workout.readiness === "высокая" ? 2 : 1) * Math.max(1, +workout.splitDays || 1);
      let seeded = 0, sg = 0;
      while (seeded < K && uncovered.size && sg++ < 50) {
        const gp = pool.filter(e => !usedIds.has(e.id) && exCharacter(e) === "глобальные" && exGoalCats(e).some(c => uncovered.has(c)));
        if (!gp.length) break;
        const e = pickForGen(gp, load);
        usedIds.add(e.id); const s = setsForEx(e);
        chosen.push({ exId: e.id, sets: s, reps: workout.reps || "8–12", rpe: READINESS[workout.readiness].rpe });
        exGoalCats(e).forEach(c => uncovered.delete(c));
        loadKeys(e).forEach(x => { load[x.key] = (load[x.key] || 0) + s * x.w; });
        seeded++;
      }
    }
    let guard = 0;
    while (uncovered.size && guard++ < 400) {
      const m = randPick([...uncovered]);
      let cands = pool.filter(e => !usedIds.has(e.id) && exGoalCats(e).includes(m));
      if (!cands.length) { uncovered.delete(m); continue; }
      const nonRed = cands.filter(e => exGoalCats(e).every(c => uncovered.has(c)));
      if (nonRed.length) cands = nonRed;
      const multi = cands.filter(e => exGoalCats(e).filter(c => uncovered.has(c)).length >= 2);
      const bucket = (multi.length && Math.random() < compoundProb()) ? multi : cands;
      const e = pickForGen(bucket, load);
      usedIds.add(e.id);
      const sets = setsForEx(e);
      chosen.push({ exId: e.id, sets, reps: workout.reps || "8–12", rpe: READINESS[workout.readiness].rpe });
      exGoalCats(e).forEach(c => uncovered.delete(c));
      loadKeys(e).forEach(x => { load[x.key] = (load[x.key] || 0) + sets * x.w; });
    }
    const rank = { glob: 0, reg: 1, loc: 2 };
    chosen.sort((a, b) => { const ea = exById(a.exId), eb = exById(b.exId); return (rank[CHAR[exCharacter(ea)]] - rank[CHAR[exCharacter(eb)]]) || (exGoalCats(eb).length - exGoalCats(ea).length); });
    return chosen;
  }
  function exConflicts(e) {
    return {
      fwd: (e.categories || []).includes("Движение рук вперёд"),
      up: (e.categories || []).includes("Движение рук вверх"),
      erector: ["target", "synergist", "stabilizer"].some(r => (e.muscles[r] || []).some(o => o.muscle === ERECTOR)),
      joint: jointLoad(e),
    };
  }
  function generate() {
    if (!exercises.length) { showToast("В базе нет упражнений для генерации"); return; }
    const N = Math.max(1, Math.min(6, +workout.splitDays || 1));
    const restricted = new Set(workout.restrictions);
    const baseNames = goalCats().map(c => c.name).filter(n => !restricted.has(n));
    if (!baseNames.length) { showToast("Выбери хотя бы одно движение"); return; }
    const all = generateInto(baseNames);
    if (N === 1) { workout.days = [{ name: "Тренировка 1", items: all }]; }
    else {
      const days = DAY_LETTERS.slice(0, N).map(n => ({ name: n, items: [], vol: 0, fwd: false, up: false, erector: 0, joints: {} }));
      const pins = workout.pins || {};
      all.slice().sort((a, b) => (+b.sets || 0) - (+a.sets || 0)).forEach(it => {
        const e = exById(it.exId); if (!e) return; const c = exConflicts(e); const s = +it.sets || 0;
        let forced = null;
        for (const mv of exBaseCats(e)) { const p = pins[mv]; if (p != null && p !== "" && days[+p]) { forced = +p; break; } }
        let best;
        if (forced != null) { best = days[forced]; }
        else {
          best = days[0]; let bestScore = Infinity;
          days.forEach(d => {
            let score = d.vol + Math.random() * 0.5;
            if (c.fwd && d.up) score += 100;
            if (c.up && d.fwd) score += 100;
            if (c.erector && d.erector >= 2) score += 100;
            if (c.joint && d.joints[c.joint]) score += 80;
            if (score < bestScore) { bestScore = score; best = d; }
          });
        }
        best.items.push(it); best.vol += s;
        if (c.fwd) best.fwd = true; if (c.up) best.up = true; if (c.erector) best.erector++;
        if (c.joint) best.joints[c.joint] = (best.joints[c.joint] || 0) + 1;
      });
      const rank = { glob: 0, reg: 1, loc: 2 };
      days.forEach(d => d.items.sort((a, b) => { const ea = exById(a.exId), eb = exById(b.exId); return (rank[CHAR[exCharacter(ea)]] - rank[CHAR[exCharacter(eb)]]) || (exBaseCats(eb).length - exBaseCats(ea).length); }));
      workout.days = days.map(d => ({ name: d.name, items: d.items }));
    }
    workout.active = 0; workout.manual = false; workout.splitFromSingle = false; _sessionActive = true; _hasPlan = true; _step = "result"; _keepVolume = false;
    const rows = coverageRows();
    _selectedMovement = (rows.find(r => r.bad) || rows.find(r => r.priority && !r.excluded) || rows[0])?.i || 0;
    render(); $("constructor-scroll").scrollTop = 0;
  }
  function fillDay() {
    if (!exercises.length) { showToast("В базе нет упражнений"); return; }
    const day = activeDay(), activeIdx = workout.active;
    const restricted = new Set(workout.restrictions), pins = workout.pins || {};
    const micro = microCoverage();
    const inDay = new Set(); day.items.forEach(it => { const e = exById(it.exId); if (e) exGoalCats(e).forEach(c => inDay.add(c)); });
    const targets = goalCats().map(c => c.name).filter(name => {
      if (restricted.has(name)) return false;
      if (inDay.has(name)) return false;
      if ((micro[name] || 0) >= targetFor(name)) return false;
      const p = pins[name]; if (p != null && p !== "" && +p !== activeIdx) return false;
      return true;
    });
    if (!targets.length) { showToast("Дополнять нечего — недостающих движений нет"); return; }
    const load = {}; day.items.forEach(it => { const e = exById(it.exId); if (!e) return; const s = +it.sets || 0; loadKeys(e).forEach(x => load[x.key] = (load[x.key] || 0) + s * x.w); });
    const dayZones = {}; day.items.forEach(it => { const z = jointLoad(exById(it.exId)); if (z) dayZones[z] = (dayZones[z] || 0) + 1; });
    const usedIds = new Set(); workout.days.forEach(d => d.items.forEach(it => usedIds.add(it.exId)));
    const set = new Set(targets);
    const pool = exercises.filter(e => { const bc = exGoalCats(e); return bc.length && bc.every(c => set.has(c)) && available(e); });
    const uncovered = new Set(targets), added = []; let guard = 0, addVol = 0;
    while (uncovered.size && guard++ < 400) {
      if (dayVolume(day) + addVol >= VOL_WARN) break;
      const m = randPick([...uncovered]);
      let cands = pool.filter(e => !usedIds.has(e.id) && exGoalCats(e).includes(m));
      if (!cands.length) { uncovered.delete(m); continue; }
      const jointOk = cands.filter(e => { const z = jointLoad(e); return !z || !dayZones[z]; });
      if (jointOk.length) cands = jointOk;
      const nonRed = cands.filter(e => exGoalCats(e).every(c => uncovered.has(c)));
      if (nonRed.length) cands = nonRed;
      const multi = cands.filter(e => exGoalCats(e).filter(c => uncovered.has(c)).length >= 2);
      const bucket = (multi.length && Math.random() < compoundProb()) ? multi : cands;
      const e = pickForGen(bucket, load);
      usedIds.add(e.id);
      const sets = setsForEx(e);
      added.push({ exId: e.id, sets, reps: workout.reps || "8–12", rpe: READINESS[workout.readiness].rpe }); addVol += sets;
      exGoalCats(e).forEach(c => uncovered.delete(c));
      loadKeys(e).forEach(x => load[x.key] = (load[x.key] || 0) + sets * x.w);
      const z = jointLoad(e); if (z) dayZones[z] = (dayZones[z] || 0) + 1;
    }
    if (!added.length) { showToast("Лимит занятия достигнут — убери лишнее или добавь день"); return; }
    day.items = day.items.concat(added);
    const rank = { glob: 0, reg: 1, loc: 2 };
    day.items.sort((a, b) => { const ea = exById(a.exId), eb = exById(b.exId); return (rank[CHAR[exCharacter(ea)]] - rank[CHAR[exCharacter(eb)]]) || (exGoalCats(eb).length - exGoalCats(ea).length); });
    render();
  }
  function removeItem(di, i) { const d = workout.days[+di]; if (!d) return; d.items.splice(i, 1); render(); }
  // Перенос упражнения в другой день (кнопкой-выбором дня в карточке).
  function moveToDay(di, i, target) { const src = workout.days[+di], dst = workout.days[+target]; if (!src || !dst || +di === +target) return; const it = src.items.splice(i, 1)[0]; if (it) dst.items.push(it); render(); showToast("Перенесено в «" + dst.name + "»"); }

  /* ── Предупреждения ──────────────────────────────────────────────────────── */
  function warnings() {
    const multi = workout.days.length > 1;
    const cov = multi ? microCoverage() : coverage();
    const base = baseCats().filter(c => !workout.restrictions.includes(c.name));
    const warns = []; const sfx = multi ? " за микроцикл" : "";
    const notClosed = base.filter(c => (cov[c.name] || 0) === 0).map(c => c.name);
    if (notClosed.length) {
      warns.push({ t: "danger", m: "Не закрыты движения" + sfx + " (" + notClosed.length + "): " + notClosed.join(", ") + "." });
      const restrSet = new Set(workout.restrictions);
      const noEx = notClosed.filter(n => !exercises.some(e => exBaseCats(e).includes(n)));
      const blocked = notClosed.filter(n => !noEx.includes(n) && !exercises.some(e => { const bc = exBaseCats(e); return bc.includes(n) && bc.every(c => !restrSet.has(c)); }));
      if (noEx.length) warns.push({ t: "note", m: "Причина: в базе нет упражнений на — " + noEx.join(", ") + "." });
      if (blocked.length) warns.push({ t: "note", m: "Причина: " + blocked.join(", ") + " закрываются только через ограниченные движения — ослабь ограничения." });
    }
    const imbalances = coverageRows().filter(r => r.bad && r.value > 0);
    if (imbalances.length) warns.push({ t: "warn", m: "Отклонения от ориентира" + sfx + ": " + imbalances.map(r => r.name + " (" + r.value + "/" + r.target + ")").join(", ") + "." });
    if (multi) {
      const over = [], high = [];
      workout.days.forEach(d => { const v = dayVolume(d); if (v > VOL_MAX) over.push("«" + d.name + "» " + v); else if (v > VOL_WARN) high.push("«" + d.name + "» " + v); });
      if (over.length) warns.push({ t: "danger", m: "Перегруз занятия (>" + VOL_MAX + " подх.): " + over.join(", ") + "." });
      if (high.length) warns.push({ t: "warn", m: "Высокий объём (>" + VOL_WARN + "): " + high.join(", ") + "." });
      const vols = workout.days.map(dayVolume); const spread = Math.max(...vols) - Math.min(...vols);
      if (spread > 6) warns.push({ t: "warn", m: "Дни неравны по объёму (разброс " + spread + "): " + workout.days.map(d => d.name + " " + dayVolume(d) + "п").join(", ") + "." });
    } else {
      const tot = dayVolume(activeDay());
      if (tot > VOL_MAX) warns.push({ t: "danger", m: "Слишком большой объём: " + tot + " подходов (предел ~" + VOL_MAX + "). Разбей на дни." });
      else if (tot > VOL_WARN) warns.push({ t: "warn", m: "Объём высокий: " + tot + " подходов (ориентир до " + VOL_WARN + " за занятие)." });
    }
    const dn = multi ? " (день «" + activeDay().name + "»)" : "";
    const st = muscleStats();
    const risk = Object.keys(st).map(m => ({ m, ...st[m] }))
      .filter(x => x.frac >= OVERTRAIN_FRAC || x.prim >= 3 || x.sec >= 4)
      .sort((a, b) => b.frac - a.frac)
      .map(x => x.m + " (" + (Number.isInteger(x.frac) ? x.frac : x.frac.toFixed(1)) + " усл.)");
    if (risk.length) warns.push({ t: "warn", m: "Риск перетренированности" + dn + ": " + risk.join("; ") + "." });
    const zones = {};
    activeDay().items.forEach(it => { const e = exById(it.exId); if (!e) return; const z = jointLoad(e); if (z) (zones[z] = zones[z] || []).push(e.name); });
    Object.keys(zones).forEach(z => { if (zones[z].length >= 2) warns.push({ t: "warn", m: "Перегруз сустава (" + z + ")" + dn + ": " + zones[z].join(", ") + "." }); });
    if (workout.readiness !== "низкая") {
      const noGlob = workout.days.filter(d => d.items.length && !d.items.some(it => { const e = exById(it.exId); return e && exCharacter(e) === "глобальные"; })).map(d => d.name);
      if (noGlob.length) warns.push({ t: "note", m: "Нет глобального (базового) упражнения в дне: " + noGlob.join(", ") + "." });
    }
    return warns;
  }

  /* ── Экспорт готового плана в шаблоны приложения ─────────────────────────── */
  function repsToNum(reps) { const m = String(reps || "").match(/\d+/); return m ? +m[0] : 10; }
  function saveAsTemplates() {
    const uid = DATA.getCurrentUser();
    const filled = workout.days.filter(d => d.items.length);
    if (!filled.length) { showToast("План пуст — добавь упражнения"); return; }
    const single = filled.length === 1;
    let n = 0;
    filled.forEach(d => {
      const name = single ? "Тренировка (конструктор)" : "День " + d.name;
      const tpl = DATA.createBlankTemplate(uid, name);
      const exList = d.items.map(it => ({
        exerciseId: it.exId,
        sets: Array.from({ length: Math.max(1, +it.sets || 1) }, () => ({ weight: "", reps: repsToNum(it.reps) })),
      }));
      DATA.updateTemplateExercises(uid, tpl.id, exList);
      if (window.SyncQueue) SyncQueue.push("template:create", { templateId: tpl.id });
      n++;
    });
    endSession();
    showToast(single ? "Шаблон сохранён" : n + " шаблона сохранено");
    goToScreen("templates");
  }

  /* ── Генератор: параметры → готовый план ───────────────────────────────── */
  const READY_DETAILS = {
    "низкая": ["Стаж тренировок меньше 3 месяцев", "Меньше 2 занятий в неделю", "Значительные ограничения, связанные с физическим состоянием", "Нет условий для полного восстановления после нагрузок"],
    "средняя": ["Стаж тренировок 3–6 месяцев", "2–3 занятия в неделю", "Незначительные ограничения, связанные с физическим состоянием", "Ограниченное восстановление после нагрузок"],
    "высокая": ["Стаж тренировок больше 6 месяцев", "3 и более занятий в неделю", "Нет ограничений, связанных с физическим состоянием", "Есть все условия для восстановления после нагрузок"],
  };
  const ICONS = {
    spark: '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z"/><path d="M20 2v4m-2-2h4"/>',
    circleCheck: '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
    bulb: '<path d="M9 18h6m-5 3h4M8.5 15.5a6 6 0 1 1 7 0c-.9.7-1.5 1.2-1.5 2.5h-4c0-1.3-.6-1.8-1.5-2.5Z"/>',
    plus: '<path d="M12 5v14M5 12h14"/>', minus: '<path d="M5 12h14"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>', check: '<path d="m5 12 4 4L19 6"/>',
    star: '<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9Z"/>',
    ban: '<circle cx="12" cy="12" r="9"/><path d="m6 6 12 12"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    calendar: '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M7 3v4m10-4v4M3 11h18m-13 4h2m4 0h2"/>',
    heart: '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z"/>',
    bed: '<path d="M3 18V6m0 8h18v7m-18-3h18M7 14V9h10a4 4 0 0 1 4 4v1M3 21v-3"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v.1"/>',
    right: '<path d="M5 12h14m-6-6 6 6-6 6"/>', up: '<path d="m6 15 6-6 6 6"/>', down: '<path d="m6 9 6 6 6-6"/>',
    refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8M21 3v5h-5M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16M8 16H3v5"/>',
    swap: '<path d="M4 7h16m-4-4 4 4-4 4M20 17H4m4-4-4 4 4 4"/>',
    lock: '<rect x="5" y="10" width="14" height="11" rx="3"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2"/>',
    unlock: '<rect x="5" y="10" width="14" height="11" rx="3"/><path d="M8 10V7a4 4 0 0 1 7.5-2m-3.5 10v2"/>',
    target: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/><path d="M12 2v3m0 14v3M2 12h3m14 0h3"/>',
    list: '<path d="M9 5h11M9 12h11M9 19h11M4 5h.1M4 12h.1M4 19h.1"/>',
  };
  const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ICONS.info}</svg>`;
  const plural = n => n % 10 === 1 && n % 100 !== 11 ? "подход" : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? "подхода" : "подходов";
  const movementHint = c => c.group || "";
  const available = e => equipAllowed(e) && !(e.categories || []).some(n => workout.restrictions.includes(n));

  function volumeStatus(value) {
    if (value <= VOL_MAX) return { icon: 'circleCheck', text: 'Объём в норме', severe: false };
    if (value <= VOL_ALERT) return { icon: 'bulb', text: 'Чуть выше рекомендации, но это не критично', severe: false };
    return { icon: 'bulb', text: 'Больше рекомендованного: восстановиться будет сложнее', severe: true };
  }
  function normalizeReps(value) { return Math.max(1, Math.min(30, repsToNum(value))); }
  function ring(value, size = 60) {
    const r = size / 2 - 5, circumference = 2 * Math.PI * r;
    const max = Math.max(VOL_MAX, value), normal = value <= VOL_ALERT ? Math.min(1, value / VOL_MAX) : VOL_MAX / max;
    return `<svg class="sg-ring" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img" aria-label="${value} ${plural(value)}"><circle cx="${size/2}" cy="${size/2}" r="${r}" fill="none" stroke="#ffffff14" stroke-width="6"/><circle cx="${size/2}" cy="${size/2}" r="${r}" fill="none" stroke="#8b7cf6" stroke-width="6" stroke-dasharray="${normal*circumference} ${circumference}" transform="rotate(-90 ${size/2} ${size/2})"/>${value > VOL_ALERT ? `<circle cx="${size/2}" cy="${size/2}" r="${r}" fill="none" stroke="#fb7185" stroke-width="6" stroke-dasharray="${(1-normal)*circumference} ${circumference}" stroke-dashoffset="${-normal*circumference}" transform="rotate(-90 ${size/2} ${size/2})"/>` : ""}<text x="50%" y="50%" dy=".35em" text-anchor="middle" fill="currentColor" font-size="${size > 70 ? 28 : 17}">${value}</text></svg>`;
  }
  function choiceChips(kind, summary = false) {
    const values = kind === "priority" ? workout.priority : workout.restrictions;
    return values.map(n => `<button type="button" class="sg-chip ${kind}" ${summary ? 'data-parameters' : `data-remove="${kind}" data-name="${esc(n)}"`} aria-label="${summary ? 'Изменить' : 'Убрать'}: ${esc(n)}">${icon(kind === "priority" ? "star" : "ban")}<span>${esc(n)}</span>${summary ? "" : icon("close")}</button>`).join("") + (summary ? "" : `<button type="button" class="sg-chip ghost sg-choice-add" data-sheet="${kind}">${icon("plus")}Из списка</button>`);
  }
  function parameterHtml() {
    const levels = Object.keys(READINESS), details = READY_DETAILS[workout.readiness];
    const total = goalCats().filter(c => !workout.restrictions.includes(c.name)).reduce((s,c) => s + targetFor(c.name), 0);
    const perDay = Math.ceil(total / workout.splitDays), suggestion = Math.min(4, Math.ceil(total / VOL_MAX));
    const status = volumeStatus(perDay);
    const ticks = Math.min(48, perDay), color = perDay <= VOL_MAX ? "var(--sg-green)" : "var(--sg-yellow)";
    const stepper = (field, label, value, min, max) => `<div><label class="sg-label" for="sg-${field}">${label}</label><div class="sg-stepper"><button type="button" data-step="${field}" data-delta="-1" aria-label="Уменьшить: ${label}" ${+value <= min ? 'disabled' : ''}>${icon("minus")}</button><input id="sg-${field}" data-number="${field}" aria-label="${label}" inputmode="numeric" type="number" min="${min}" max="${max}" step="1" value="${esc(value)}"><button type="button" data-step="${field}" data-delta="1" aria-label="Увеличить: ${label}" ${+value >= max ? 'disabled' : ''}>${icon("plus")}</button></div></div>`;
    return `<div class="sg-card"><div class="sg-label">Готовность</div><div class="sg-levels">${levels.map((n,i) => `<button type="button" data-readiness="${n}" aria-pressed="${n === workout.readiness}" class="${n === workout.readiness ? 'selected' : ''}"><span class="sg-bars" aria-hidden="true">${[0,1,2].map(j => `<i class="${j <= i ? 'lit' : ''}"></i>`).join("")}</span>${n[0].toUpperCase()+n.slice(1)}</button>`).join("")}</div><div class="sg-details">${details.map((d,i) => `<div>${icon(["clock","calendar","heart","bed"][i])}<span>${d}</span></div>`).join("")}</div></div>
      <div class="sg-card sg-prescription"><div class="sg-two">${stepper("target", "Подходов", workout.target, 1, 10)}${stepper("reps", "Повторов", workout.reps, 1, 30)}</div><p class="sg-note">${icon("info")}<span>Для выбранной готовности эффективно до ${READINESS[workout.readiness].effective} подходов на мышечную группу</span></p></div>
      <div class="sg-card"><div class="sg-label"><span>Дней в сплите</span><span>${workout.splitDays === 1 ? 'Fullbody' : workout.splitDays + ' тренировки'}</span></div><div class="sg-days-select">${[1,2,3,4].map(n => `<button type="button" data-split="${n}" class="${n === workout.splitDays ? 'selected' : ''}" aria-pressed="${n === workout.splitDays}">${n}</button>`).join("")}</div></div>
      <div class="sg-card"><div class="sg-label"><span>Движения в плане</span><span>${goalCats().filter(c => !workout.restrictions.includes(c.name)).length} выбрано</span></div><button type="button" class="sg-movement-select" data-sheet="movements">${icon('target')}<span>Выбрать базовые и дополнительные</span>${icon('down')}</button></div>
      <div class="sg-card"><div class="sg-label"><span>Приоритет</span><span>+${workout.priorityBonus} подхода</span></div><div class="sg-chips">${choiceChips("priority")}</div></div>
      <div class="sg-card"><div class="sg-label"><span>Ограничения</span><span>исключаем из плана</span></div><div class="sg-chips">${choiceChips("restrictions")}</div></div>
      <div class="sg-card"><div class="sg-row sg-between sg-volume-heading"><div class="sg-row"><b class="sg-big" style="color:${color}">${perDay}</b><span class="sg-muted">${plural(perDay)}<br>на тренировку</span></div><span class="sg-muted sg-volume-guide">рекомендуем до ${VOL_MAX}</span></div><div class="sg-ticks" aria-hidden="true">${Array.from({length:Math.max(26,ticks)},(_,i) => `<i style="${i < ticks ? 'background:'+(i < VOL_MAX ? '#a99cff' : '#f5c542') : ''}"></i>`).join("")}</div><div class="sg-volume-note" style="color:${color}">${icon(status.icon)}<span>${status.text}</span>${status.severe && suggestion !== workout.splitDays ? `<button type="button" class="sg-action-button" data-split="${suggestion}">Разделить на ${suggestion} дн.</button>` : ''}</div></div>`;
  }
  function coverageRows() {
    const cov = microCoverage();
    return goalCats().map((c,i) => {
      const excluded = workout.restrictions.includes(c.name), priority = workout.priority.includes(c.name);
      const value = cov[c.name] || 0, target = targetFor(c.name), delta = value-target;
      const relaxed = OVERLOAD_OK.includes(c.name) || /зад бедра/.test(c.name);
      const bad = !excluded && (value === 0 || delta < -1 || delta > (relaxed ? 2 : 1));
      return { ...c, i, value, target, excluded, priority, bad, color: excluded ? '#53536a' : bad ? delta < 0 ? '#fb7185' : '#f5c542' : priority ? '#a99cff' : '#4ade9b', status: excluded ? 'исключено из плана' : bad ? `на ${Math.abs(delta)} ${delta < 0 ? 'меньше' : 'больше'} ориентира` : priority ? `приоритет, ориентир +${workout.priorityBonus}` : 'в пределах ориентира' };
    });
  }
  function coverageListHtml(rows) {
    const max = Math.max(10, ...rows.map(r => Math.max(r.value, r.target)));
    return `<div class="sg-coverage-list">${rows.map(r => `<div class="sg-coverage-row ${r.excluded ? 'excluded' : ''}"><span class="sg-number">${r.i+1}</span><${workout.manual && !r.excluded ? 'button type="button" data-find-movement="'+esc(r.name)+'"' : 'span'} class="sg-coverage-name">${esc(r.name)}</${workout.manual && !r.excluded ? 'button' : 'span'}>${r.excluded ? `<span class="sg-coverage-value">${icon('ban')}</span>` : `<span class="sg-coverage-bar" role="meter" aria-label="${esc(r.name)}" aria-valuemin="0" aria-valuemax="${max}" aria-valuenow="${r.value}" aria-valuetext="${r.value} из ${r.target} подходов"><i style="width:${r.value/max*100}%;background:${r.color}"></i><b style="left:${r.target/max*100}%"></b></span><span class="sg-coverage-value" style="color:${r.color}">${r.value}/${r.target}</span>`}</div>`).join('')}</div>`;
  }
  function manualCoverageHtml(rows) {
    const active = rows.filter(r => !r.excluded), pending = active.filter(r => r.value === 0);
    return `<div class="sg-card sg-manual-coverage"><div class="sg-label">Движения в плане · весь сплит</div><div class="sg-manual-count">Покрыто ${active.length-pending.length} из ${active.length}</div><p class="sg-muted">${!active.length ? 'Выбери движения в параметрах, чтобы видеть покрытие' : pending.length ? 'Добавь упражнение на нужное движение' : 'Все выбранные движения есть в плане'}</p><div class="sg-chips">${pending.slice(0,3).map(r => `<button type="button" class="sg-chip ghost" data-find-movement="${esc(r.name)}">${icon('plus')}${esc(r.name)}</button>`).join('')}</div>${_coverageLevel === 2 ? coverageListHtml(rows) : ''}<button type="button" class="sg-more" data-coverage="${_coverageLevel === 2 ? 1 : 2}">${_coverageLevel === 2 ? 'Свернуть движения' : 'Все движения и подходы'}${icon(_coverageLevel === 2 ? 'up' : 'down')}</button></div>`;
  }
  function coverageHtml() {
    const rows = coverageRows(), active = rows.filter(r => !r.excluded), bad = rows.filter(r => r.bad), covered = active.filter(r => r.value > 0).length;
    if (workout.manual) return manualCoverageHtml(rows);
    const summary = bad.length ? `Обрати внимание: ${bad[0].name} — ${bad[0].status}${bad.length > 1 ? ', и ещё '+(bad.length-1) : ''}` : `${covered} из ${active.length} движений в норме`;
    if (!_coverageLevel) return `<div class="sg-card"><button type="button" class="sg-coverage-summary" data-coverage="1">${icon(bad.length ? "info" : "check")}<span><small class="sg-muted">Покрытие${workout.days.length > 1 ? ' за весь сплит' : ''}</small><br>${esc(summary)}</span>${icon("down")}</button></div>`;
    const selected = rows[_selectedMovement] || rows[0];
    if (!selected) return '';
    const max = Math.max(workout.target + 4, ...rows.map(r => Math.max(r.value,r.target))), count = rows.length;
    const point = (i, radius) => { const a = (-90+i*360/count)*Math.PI/180; return [150+radius*Math.cos(a),138+radius*Math.sin(a)]; };
    const points = rows.map(r => point(r.i,r.excluded ? 6 : r.value/max*96).join(',')).join(' ');
    const targetPoints = rows.map(r => point(r.i,r.excluded ? 6 : r.target/max*96).join(',')).join(' ');
    const radar = `<svg class="sg-radar" viewBox="0 0 300 276" role="group" aria-label="Баланс по ${count} движениям"><circle cx="150" cy="138" r="96"/><circle cx="150" cy="138" r="48"/>${rows.map(r => {const [x,y] = point(r.i,96); return `<path d="M150 138L${x} ${y}"/>`;}).join('')}<polygon class="sg-radar-target" points="${targetPoints}"/><polygon class="sg-radar-area" points="${points}"/>${rows.map(r => {const [x,y] = point(r.i,r.excluded ? 6 : r.value/max*96), [lx,ly] = point(r.i,115); return `<circle cx="${x}" cy="${y}" r="${selected.i === r.i ? 6 : 4.5}" style="fill:${r.color};stroke:${selected.i === r.i ? '#fff' : '#0b0b14'}"/><g tabindex="0" role="button" aria-label="${esc(r.name)}: ${r.excluded ? 'исключено' : r.value+' подходов'}" aria-pressed="${selected.i === r.i}" data-movement="${r.i}"><circle cx="${lx}" cy="${ly}" r="12" style="fill:${selected.i === r.i ? '#7b6ee6' : '#ffffff0a'};stroke:none"/><text x="${lx}" y="${ly}" dy=".35em" text-anchor="middle" fill="${selected.i === r.i ? '#fff' : '#8b8ba3'}">${r.i+1}</text></g>`;}).join('')}</svg>`;
    return `<div class="sg-card"><div class="sg-row sg-between"><div class="sg-row"><b class="sg-big">${covered}</b><span class="sg-muted">из ${active.length} движений<br>${workout.days.length > 1 ? 'за весь сплит' : 'в плане'}</span></div><div class="sg-row"><span class="sg-status ${bad.length ? 'warn' : ''}">${bad.length ? 'перекос: '+bad.length : 'баланс в норме'}</span><button type="button" class="sg-icon-button" data-coverage="0" aria-label="Свернуть покрытие">${icon("up")}</button></div></div>${radar}<div class="sg-caption"><span class="sg-number selected">${selected.i+1}</span><div><div>${esc(selected.name)}</div></div><b style="color:${selected.color}">${selected.excluded ? '–' : selected.value+'/'+selected.target}</b></div><div class="sg-legend">${[['#4ade9b','в норме'],['#a99cff','приоритет'],['#f5c542','больше'],['#fb7185','меньше']].map(([color,label]) => `<span><i style="background:${color}"></i>${label}</span>`).join('')}<span><i class="dashed"></i>ориентир</span></div><p class="sg-muted sg-radar-help">Нажми на номер, чтобы посмотреть движение.</p>${_coverageLevel === 2 ? coverageListHtml(rows) : ''}<button type="button" class="sg-more" data-coverage="${_coverageLevel === 2 ? 1 : 2}">${_coverageLevel === 2 ? 'Свернуть список' : 'Показать списком'}${icon(_coverageLevel === 2 ? 'up' : 'down')}</button></div>`;
  }
  function volumeHtml() {
    const multi = workout.days.length > 1, value = dayVolume(activeDay());
    if (multi) return `<div class="sg-card sg-row sg-between"><span>${workout.days.length} дня · ${totalVolume()} ${plural(totalVolume())}</span>${workout.splitFromSingle ? '<button type="button" class="sg-action-button" data-resplit="1">Вернуть в одну</button>' : ''}</div>`;
    const split = Math.min(4, Math.max(2, Math.ceil(value / VOL_MAX)));
    if (value > VOL_ALERT && !_keepVolume) return `<div class="sg-card sg-overload"><div class="sg-row">${ring(value,92)}<div><b>${value} ${plural(value)} — многовато для одного дня</b><p>Для восстановления ориентируйся на ${VOL_MAX} подхода за тренировку.</p></div></div><div class="sg-row sg-advice-actions"><button type="button" class="sg-primary" data-resplit="${split}">Разделить на ${split} дня</button><button type="button" class="sg-link" data-keep-volume>Оставить как есть</button></div></div>`;
    return `<div class="sg-card sg-row sg-between"><div class="sg-row">${ring(value)}<div>Одна тренировка<small class="sg-muted sg-block">${value} ${plural(value)}</small></div></div>${value > VOL_ALERT ? `<button type="button" class="sg-action-button" data-resplit="${split}">Разделить</button>` : ''}</div>`;
  }
  function dayTabsHtml() {
    const rows = coverageRows().filter(r => !r.excluded), covered = rows.filter(r => r.value > 0).length;
    return `<div class="sg-plan-nav">${workout.manual ? `<div class="sg-manual-progress"><span>Покрыто движений</span><b>${covered}/${rows.length}</b><progress max="${Math.max(1,rows.length)}" value="${covered}"></progress></div>` : ''}${workout.days.length > 1 ? `<div class="sg-day-tabs">${workout.days.map((d,i) => `<button type="button" class="sg-day-tab ${workout.active === i ? 'selected' : ''}" data-day="${i}" aria-pressed="${workout.active === i}"><span>День ${i+1}<small>${dayVolume(d)} ${plural(dayVolume(d))}</small></span></button>`).join('')}</div>` : ''}</div>`;
  }
  function updateItemSets(index, value) {
    const item = activeDay().items[index]; if (!item) return;
    item.sets = Math.max(1, Math.min(30, Math.round(Number(value)) || 1));
    render();
  }
  function itemHtml(it,di,i) {
    const e = exById(it.exId), groups = e ? [...new Set(exBaseCats(e).map(n => categories.find(c => c.name === n)?.group).filter(Boolean))] : [];
    return `<div class="wk-item-wrap" data-di="${di}" data-i="${i}"><div class="wk-item-del">${WK_TRASH}Удалить</div><div class="wk-item sg-exercise"><div class="sg-grow"><button type="button" class="sg-exercise-name" data-exercise-detail="${esc(it.exId)}">${esc(e?.name || 'Упражнение недоступно')}</button><div class="sg-exercise-meta">${groups.map(n => `<span class="sg-tag">${esc(n)}</span>`).join('')}</div><div class="sg-movements">${e ? exGoalCats(e).map(n => `<span>${icon('target')}${esc(n)}</span>`).join('') : ''}</div><div class="sg-item-prescription"><span>Подходы</span><div class="sg-item-stepper"><button type="button" data-item-step="${i}" data-delta="-1" aria-label="Уменьшить подходы: ${esc(e?.name)}" ${it.sets <= 1 ? 'disabled' : ''}>${icon('minus')}</button><input type="number" min="1" max="30" inputmode="numeric" value="${it.sets}" data-item-sets="${i}" aria-label="Подходы: ${esc(e?.name)}"><button type="button" data-item-step="${i}" data-delta="1" aria-label="Увеличить подходы: ${esc(e?.name)}" ${it.sets >= 30 ? 'disabled' : ''}>${icon('plus')}</button></div></div>${_cEdit && workout.days.length > 1 ? `<div class="wk-item-days">${workout.days.map((d,dj) => `<button class="wk-item-day${dj === di ? ' cur' : ''}" data-moveto="${dj}" data-di="${di}" data-i="${i}">День ${dj+1}</button>`).join('')}</div>` : ''}</div><div class="sg-exercise-actions"><button type="button" class="sg-icon-button ${it.locked ? 'selected' : ''}" data-lock="${i}" aria-pressed="${!!it.locked}" aria-label="${it.locked ? 'Открепить' : 'Закрепить'} упражнение">${icon(it.locked ? 'lock' : 'unlock')}</button><button type="button" class="sg-icon-button" data-replace="${i}" aria-label="Заменить упражнение" ${it.locked ? 'disabled' : ''}>${icon('swap')}</button></div></div></div>`;
  }
  function render() {
    const el = $('constructor-scroll'); if (!el) return;
    const root = $('screen-constructor')?.closest('.app');
    if (root) root.scrollTop = 0;
    const result = _step === 'result';
    $('constructor-title').textContent = result ? (workout.manual ? 'Сборка плана' : 'Готовый план') : 'Параметры';
    $('constructor-step').innerHTML = `<span>Шаг ${result ? 2 : 1} из 2</span><div class="sg-step-track"><i class="selected"></i><i class="${result ? 'selected' : ''}"></i></div>`;
    if (!result) el.innerHTML = parameterHtml();
    else {
      const items = activeDay().items;
      el.innerHTML = `<div class="sg-summary">${choiceChips('priority',true)}${choiceChips('restrictions',true)}</div>${volumeHtml()}${coverageHtml()}${dayTabsHtml()}${workout.days.length > 1 && dayVolume(activeDay()) > VOL_ALERT ? `<div class="sg-day-warning sg-muted">${icon('bulb')}Больше рекомендованного: восстановиться будет сложнее</div>` : ''}<div class="sg-row sg-between sg-exercises-heading"><span>${workout.days.length > 1 ? 'День '+(workout.active+1) : 'Упражнения'} ${workout.days.length > 1 ? '' : `<small class="sg-muted">· ${items.length}</small>`}</span><button type="button" class="sg-chip ghost" data-sheet="add">${icon('plus')}Добавить</button></div><div class="sg-card sg-plan wk-plan${_cEdit ? ' wk-editing' : ''}" data-di="${workout.active}">${items.length ? items.map((it,i) => itemHtml(it,workout.active,i)).join('') : '<p class="sg-muted sg-empty">День пуст. Добавь упражнение из базы или дополни день.</p>'}</div>`;
    }
    $('constructor-footer').classList.toggle('sg-footer-parameters', !result && !_cEdit);
    $('constructor-footer').innerHTML = _cEdit ? '<button type="button" class="sg-primary" id="wk-edit-done">Готово</button>' : result ? `<button type="button" class="sg-primary" id="wk-save" ${!workout.days.some(d => d.items.length) ? 'disabled' : ''}>Сохранить ${workout.days.filter(d => d.items.length).length > 1 ? 'шаблоны' : 'шаблон'}</button>${workout.manual ? '' : `<button type="button" class="sg-refresh" id="wk-generate" aria-label="Сгенерировать заново, сохранив закреплённые упражнения">${icon('refresh')}</button>`}` : _hasPlan ? `<button type="button" class="sg-primary" id="wk-resume">К готовому плану${icon('right')}</button><button type="button" class="sg-secondary" id="wk-generate">${icon('refresh')}Сгенерировать заново</button>` : `<button type="button" class="sg-primary" id="wk-generate">${icon('spark')}Сгенерировать</button><button type="button" class="sg-secondary" id="wk-manual">${icon('plus')}Собрать вручную</button>`;
    wire(); persist();
  }
  function setParameters() { if (_hasPlan) _resultSnapshot = JSON.parse(JSON.stringify(workout)); _step = 'parameters'; _cEdit = false; render(); $('constructor-scroll').scrollTop = 0; }
  function resumePlan() {
    if (!_hasPlan || !_resultSnapshot) return;
    workout = JSON.parse(JSON.stringify(_resultSnapshot)); _step = 'result'; render();
    $('constructor-scroll').scrollTop = 0;
  }
  function startManual() {
    workout.days = Array.from({length:workout.splitDays},(_,i) => ({name: DAY_LETTERS[i], items:[]}));
    workout.active = 0; workout.manual = true; workout.splitFromSingle = false;
    _sessionActive = true; _hasPlan = true; _step = 'result'; _coverageLevel = 1; render(); $('constructor-scroll').scrollTop = 0;
  }
  function endSession() { _sessionRevision++; _hasPlan = false; _resultSnapshot = null; _sessionActive = false; }
  function resplit(n) {
    if (workout.days.length === 1 && n > 1) workout.splitFromSingle = true;
    if (n === 1) workout.splitFromSingle = false;
    const all = workout.days.flatMap(d => d.items);
    const days = Array.from({length:n},(_,i) => ({ name: n === 1 ? 'Тренировка 1' : DAY_LETTERS[i], items: [] }));
    all.slice().sort((a,b) => b.sets-a.sets).forEach(it => { const day = days.reduce((a,b) => dayVolume(a) <= dayVolume(b) ? a : b); day.items.push(it); });
    workout.days = days; workout.splitDays = n; workout.active = 0; _keepVolume = false; render();
  }
  function toggleChoice(kind,name) {
    if (kind === 'movements') { const names = workout.movements; const i = names.indexOf(name); if (i < 0) names.push(name); else { names.splice(i,1); workout.priority = workout.priority.filter(n => n !== name); } return; }
    if (kind === 'priority' && workout.restrictions.includes(name)) return;
    const arr = workout[kind], i = arr.indexOf(name); if (i < 0) arr.push(name); else arr.splice(i,1);
    if (kind === 'restrictions' && i < 0) workout.priority = workout.priority.filter(n => n !== name);
  }
  function openSheet(kind, index) {
    const dlg = document.createElement('dialog'); dlg.className = 'sg sg-sheet';
    const source = document.activeElement;
    let closing = false;
    const close = after => {
      if (closing) return; closing = true;
      const finish = () => { dlg.close(); if (typeof after === 'function') after(); };
      if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) { finish(); return; }
      dlg.style.transition = 'transform .22s ease'; dlg.style.transform = 'translateY(100%)';
      setTimeout(finish, 220);
    };
    dlg.addEventListener('cancel', e => { e.preventDefault(); close(); });
    dlg.addEventListener('close', () => { dlg.remove(); if (source?.isConnected) source.focus({preventScroll:true}); });
    dlg.addEventListener('click', e => { if (e.target === dlg) { const r = dlg.getBoundingClientRect(); if (e.clientY < r.top || e.clientY > r.bottom || e.clientX < r.left || e.clientX > r.right) close(); } });
    function draw() {
      const choosing = kind === 'priority' || kind === 'restrictions' || kind === 'movements';
      let content = '', title = '';
      if (choosing) {
        title = kind === 'movements' ? 'Движения в плане' : kind === 'priority' ? 'Приоритет' : 'Ограничения';
        content = `<p class="sg-muted">${kind === 'movements' ? 'Выбери цели плана. Для полного исключения движения используй ограничения.' : kind === 'priority' ? 'Добавим +'+workout.priorityBonus+' подхода на выбранные движения' : 'Выбранные движения исключим из плана'}</p>${(kind === 'priority' ? goalCats() : categories).map(c => `<button type="button" class="sg-choice" data-choice="${esc(c.name)}" aria-pressed="${workout[kind].includes(c.name)}" ${kind === 'priority' && workout.restrictions.includes(c.name) ? 'disabled' : ''}><span class="sg-checkbox ${workout[kind].includes(c.name) ? kind === 'restrictions' ? kind : 'priority' : ''}">${workout[kind].includes(c.name) ? icon('check') : ''}</span><span>${esc(c.name)}<small class="sg-muted sg-block">${esc(kind === 'movements' ? (c.type === 'База' ? 'Базовое' : 'Дополнительное')+' · '+movementHint(c) : movementHint(c))}</small></span></button>`).join('')}<button type="button" class="sg-primary sg-sheet-done" data-close>Готово</button>`;
      } else if (kind === 'add') {
        title = 'Добавить в план';
        content = `<button class="sg-alt" data-add-manual>${icon('list')}Выбрать из базы упражнений</button><button class="sg-alt" data-fill>${icon('spark')}<span>Дополнить день<small class="sg-muted sg-block">Подберём недостающие движения</small></span></button><button class="sg-alt sg-danger" data-clear>${WK_TRASH}Очистить день</button>`;
      } else {
        title = 'Заменить упражнение';
        const item = activeDay().items[index], e = exById(item?.exId);
        if (!e || item.locked) return close();
        const used = new Set(activeDay().items.map(it => it.exId));
        const options = exercises.filter(x => x.id !== e.id && !used.has(x.id) && available(x) && exGoalCats(x).some(n => exGoalCats(e).includes(n))).sort((a,b) => Number(exSig(b) === exSig(e))-Number(exSig(a) === exSig(e)) || a.name.localeCompare(b.name,'ru'));
        content = `<p class="sg-sheet-name">${esc(e.name)}</p><p class="sg-muted">Похожие по покрытию движений</p>${options.map(x => `<button type="button" class="sg-alt" data-alternative="${esc(x.id)}"><span>${esc(x.name)}</span><small class="sg-badge ${exSig(x) === exSig(e) ? '' : 'different'}">${exSig(x) === exSig(e) ? 'Аналог' : 'Другое покрытие'}</small></button>`).join('') || '<p class="sg-empty sg-muted">Нет доступных замен с учётом ограничений и оборудования.</p>'}`;
      }
      dlg.innerHTML = `<div class="sg-sheet-drag"><div class="sg-grab"></div><h2 id="sg-sheet-title">${title}</h2></div><div class="sg-sheet-body">${content}</div>`;
      window.wireSheetDragClose(dlg, dlg.querySelector('.sg-sheet-drag'), close);
      dlg.setAttribute('aria-labelledby','sg-sheet-title');
      dlg.querySelectorAll('[data-close]').forEach(b => b.onclick = close);
      dlg.querySelectorAll('[data-choice]').forEach(b => b.onclick = () => { const y = dlg.querySelector('.sg-sheet-body').scrollTop, name = b.dataset.choice; toggleChoice(kind,name); render(); draw(); dlg.querySelector('.sg-sheet-body').scrollTop = y; [...dlg.querySelectorAll('[data-choice]')].find(n => n.dataset.choice === name)?.focus({preventScroll:true}); });
      dlg.querySelector('[data-add-manual]')?.addEventListener('click', () => close(openExercisePicker));
      dlg.querySelector('[data-fill]')?.addEventListener('click', () => close(fillDay));
      dlg.querySelector('[data-clear]')?.addEventListener('click', () => close(() => { activeDay().items = []; render(); }));
      dlg.querySelectorAll('[data-alternative]').forEach(b => b.onclick = () => close(() => { activeDay().items[index].exId = b.dataset.alternative; render(); }));
    }
    document.body.appendChild(dlg); draw(); if (dlg.isConnected) { dlg.showModal(); if (!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) dlg.animate([{transform:'translateY(100%)'},{transform:'translateY(0)'}],{duration:220,easing:'ease-out'}); }
  }
  function wire() {
    const el = $('constructor-scroll');
    const on = (sel,fn) => el.querySelectorAll(sel).forEach(n => n.addEventListener('click', () => fn(n)));
    on('[data-readiness]', n => { workout.readiness = n.dataset.readiness; render(); });
    on('[data-split]', n => { workout.splitDays = +n.dataset.split; render(); });

    on('[data-remove]', n => { toggleChoice(n.dataset.remove,n.dataset.name); render(); });
    on('[data-sheet]', n => openSheet(n.dataset.sheet));
    on('[data-parameters]', setParameters);
    on('[data-find-movement]', n => openExercisePicker(n.dataset.findMovement));
    on('[data-exercise-detail]', n => window.openExerciseDetail(n.dataset.exerciseDetail, 'constructor'));
    on('[data-item-step]', n => updateItemSets(+n.dataset.itemStep, +activeDay().items[+n.dataset.itemStep].sets + +n.dataset.delta));
    el.querySelectorAll('[data-item-sets]').forEach(n => n.addEventListener('change', () => updateItemSets(+n.dataset.itemSets, n.value)));
    $('wk-resume')?.addEventListener('click', resumePlan);
    $('wk-manual')?.addEventListener('click', startManual);
    on('[data-day]', n => { workout.active = +n.dataset.day; render(); });
    on('[data-resplit]', n => resplit(+n.dataset.resplit));
    on('[data-keep-volume]', () => { _keepVolume = true; render(); });
    on('[data-coverage]', n => { _coverageLevel = +n.dataset.coverage; render(); });
    const selectMovement = n => { _selectedMovement = +n.dataset.movement; render(); };
    on('[data-movement]', selectMovement);
    el.querySelectorAll('[data-movement]').forEach(n => n.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); const index = n.dataset.movement; selectMovement(n); el.querySelector(`[data-movement="${index}"]`)?.focus({preventScroll:true}); } }));
    on('[data-lock]', n => { const it = activeDay().items[+n.dataset.lock]; it.locked = !it.locked; render(); });
    on('[data-replace]', n => openSheet('replace',+n.dataset.replace));
    on('[data-moveto]', n => moveToDay(n.dataset.di,+n.dataset.i,+n.dataset.moveto));
    on('[data-step]', n => { const field = n.dataset.step; workout[field] = Math.max(1,Math.min(field === 'target' ? 10 : 30,repsToNum(workout[field]) + +n.dataset.delta)); render(); });
    el.querySelectorAll('[data-number]').forEach(n => n.addEventListener('change', () => {
      const field = n.dataset.number;
      workout[field] = field === 'target' ? Math.max(1, Math.min(10, Math.round(+n.value) || 1)) : normalizeReps(n.value);
      render();
    }));
    el.querySelectorAll('.wk-item-wrap').forEach(w => { wireItemSwipe(w); wireItemGesture(w); });
    $('wk-edit-done')?.addEventListener('click',exitCEdit);
    $('wk-generate')?.addEventListener('click',generate);
    $('wk-save')?.addEventListener('click',saveAsTemplates);
  }

  // Свайп влево по карточке плана → удалить (порог 80px).
  function wireItemSwipe(wrap) {
    const row = wrap.querySelector(".wk-item");
    if (!row) return;
    let sx = 0, sy = 0, dx = 0, active = false, decided = false, horiz = false, swiped = false;
    const MAX = 96, DEL = 80;
    row.addEventListener("pointerdown", e => {
      if (e.target.closest("button, input")) return;
      sx = e.clientX; sy = e.clientY; dx = 0; active = true; decided = false; horiz = false; swiped = false;
      row.style.transition = "";
    });
    row.addEventListener("pointermove", e => {
      if (!active || wrap.classList.contains("wk-dragging")) return;
      const mx = e.clientX - sx, my = e.clientY - sy;
      if (!decided) {
        if (Math.abs(mx) < 8 && Math.abs(my) < 8) return;
        decided = true; horiz = mx < 0 && Math.abs(mx) > Math.abs(my);
        if (!horiz) { active = false; return; }
        wrap.classList.add("swiping");
        try { row.setPointerCapture(e.pointerId); } catch {}
      }
      if (!horiz) return;
      dx = Math.max(-MAX, Math.min(0, mx)); if (dx < -4) swiped = true;
      row.style.transform = `translateX(${dx}px)`;
      wrap.classList.toggle("will-delete", dx <= -DEL);
    });
    row.addEventListener("touchmove", e => { if (active && horiz && e.cancelable) e.preventDefault(); }, { passive: false });
    const settle = () => {
      if (!active) return; active = false;
      if (!horiz) return;
      if (dx <= -DEL) {
        row.style.transition = "transform 0.16s ease"; row.style.transform = "translateX(-110%)";
        wrap.style.height = wrap.offsetHeight + "px";
        requestAnimationFrame(() => { wrap.style.transition = "height 0.16s ease, opacity 0.16s ease"; wrap.style.height = "0"; wrap.style.opacity = "0"; });
        setTimeout(() => removeItem(wrap.dataset.di, +wrap.dataset.i), 170);
      } else {
        row.style.transition = "transform 0.18s ease"; row.style.transform = "";
        wrap.classList.remove("will-delete");
        setTimeout(() => wrap.classList.remove("swiping"), 200);
      }
    };
    row.addEventListener("pointerup", settle);
    row.addEventListener("pointercancel", settle);
    row.addEventListener("click", e => { if (swiped) { e.stopPropagation(); e.preventDefault(); swiped = false; } }, true);
  }

  // Режим правки плана (как в списке упражнений): долгое удержание входит в него
  // (карточки покачиваются, снизу «Готово»), внутри — удержание+тянуть = порядок,
  // а на «Целой» перетаскивание карточки в секцию другого дня переносит туда.
  function enterCEdit() { if (_cEdit) return; _cEdit = true; if (window.haptic) try { haptic(22); } catch {} render(); }
  function exitCEdit() { if (!_cEdit) return; _cEdit = false; render(); }

  function wireItemGesture(wrap) {
    const row = wrap.querySelector(".wk-item");
    if (!row) return;
    let holdTimer = null, sx = 0, sy = 0, moved = false, dragStarted = false;
    const DELAY = () => _cEdit ? 150 : 430;
    const clearHold = () => { if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; } };
    const begin = (x, y, target) => {
      if (target && target.closest("button, input")) return;
      moved = false; dragStarted = false; sx = x; sy = y; clearHold();
      holdTimer = setTimeout(() => {
        holdTimer = null;
        if (moved) return;
        if (!_cEdit) { enterCEdit(); return; }
        dragStarted = true;
        startCDrag(wrap, y);
      }, DELAY());
    };
    const move = (x, y, e) => {
      if (_cDrag && _cDrag.wrap === wrap) { if (e && e.cancelable) e.preventDefault(); moveCDrag(y); return; }
      if (holdTimer && (Math.abs(x - sx) > 8 || Math.abs(y - sy) > 8)) { moved = true; clearHold(); }
    };
    const finish = () => { clearHold(); if (_cDrag && _cDrag.wrap === wrap) endCDrag(); };
    row.addEventListener("touchstart", e => { const t = e.touches[0]; begin(t.clientX, t.clientY, e.target); }, { passive: true });
    row.addEventListener("touchmove", e => { const t = e.touches[0]; if (t) move(t.clientX, t.clientY, e); }, { passive: false });
    row.addEventListener("touchend", finish);
    row.addEventListener("touchcancel", finish);
    row.addEventListener("mousedown", e => begin(e.clientX, e.clientY, e.target));
    row.addEventListener("mousemove", e => { if (_cDrag) move(e.clientX, e.clientY, null); });
    row.addEventListener("mouseup", finish);
    row.addEventListener("click", e => { if (dragStarted) { e.stopPropagation(); dragStarted = false; } }, true);
  }

  function startCDrag(wrap, pointerY) {
    if (_cDrag) return;
    const top = wrap.getBoundingClientRect().top;
    _cDrag = { wrap, container: wrap.closest(".wk-plan"), grabDy: pointerY - top, ty: 0 };
    wrap.style.transition = "none";
    wrap.classList.add("wk-dragging");
    if (window.haptic) try { haptic(18); } catch {}
  }
  function moveCDrag(pointerY) {
    const d = _cDrag; if (!d) return;
    const h = d.wrap.getBoundingClientRect().height;
    const center = (pointerY - d.grabDy) + h / 2;
    let insertBeforeEl = null;
    for (const child of d.container.children) {
      if (child === d.wrap) continue;
      const r = child.getBoundingClientRect();
      if (r.top + r.height / 2 > center) { insertBeforeEl = child; break; }
    }
    const curNext = d.wrap.nextElementSibling;
    if (insertBeforeEl !== curNext && insertBeforeEl !== d.wrap) d.container.insertBefore(d.wrap, insertBeforeEl);
    const rect = d.wrap.getBoundingClientRect();
    const naturalTop = rect.top - d.ty;
    d.ty = (pointerY - d.grabDy) - naturalTop;
    d.wrap.style.transform = `translateY(${d.ty}px)`;
  }
  function endCDrag() {
    const d = _cDrag; if (!d) return;
    _cDrag = null;
    d.wrap.style.transition = "transform 0.18s ease"; d.wrap.style.transform = "";
    d.wrap.classList.remove("wk-dragging");
    setTimeout(() => { d.wrap.style.transition = ""; }, 200);
    const container = d.container;
    if (container.classList.contains("wk-plan-flat")) {
      // «Целая»: собираем новый состав дней по заголовкам-разделителям (как группы
      // категорий в упражнениях — карточка попадает в тот день, под чей заголовок легла).
      const newItems = workout.days.map(() => []);
      let curDi = 0;
      [...container.children].forEach(ch => {
        if (ch.classList.contains("wk-day-sec-head")) { curDi = +ch.dataset.di; return; }
        if (ch.classList.contains("wk-item-wrap")) { const it = workout.days[+ch.dataset.di].items[+ch.dataset.i]; if (it) newItems[curDi].push(it); }
      });
      workout.days.forEach((day, di) => { day.items = newItems[di]; });
    } else if (container.dataset.di != null) {
      const di = +container.dataset.di, day = workout.days[di];
      if (day) { const order = [...container.querySelectorAll(".wk-item-wrap")].map(w => +w.dataset.i); day.items = order.map(i => day.items[i]).filter(Boolean); }
    }
    render();
  }

  // Общий каталог сохраняет фильтры/группы и открывает детали по названию.
  function openExercisePicker(movement) {
    if (!exercises.length) { showToast("В базе нет упражнений"); return; }
    const day = activeDay(), context = { ...draftContext }, sessionRevision = _sessionRevision;
    window.openConstructorExerciseCatalog({
      canSelect: id => { const e = exById(id); return !!e && available(e) && (!movement || e.categories.includes(movement)); },
      isSelected: id => day.items.some(it => it.exId === id),
      onSelect: id => {
        if (sessionRevision !== _sessionRevision || context.owner !== Auth.userId() || context.profile !== DATA.getCurrentUser()) return false;
        const e = exById(id);
        if (!e || !available(e) || (movement && !e.categories.includes(movement)) || day.items.some(it => it.exId === id)) return false;
        day.items.push({ exId: e.id, sets: setsForEx(e), reps: normalizeReps(workout.reps), rpe: READINESS[workout.readiness].rpe });
        persist(); return true;
      },
    });
  }

  /* ── Публичный API ───────────────────────────────────────────────────────── */
  window.CONSTRUCTOR = {
    onNavigate(name, internalCatalog = false) {
      if (_sessionActive && !['constructor','exerciseDetail','muscleDetail'].includes(name) && !internalCatalog) endSession();
    },
    back() {
      if (_step === 'result') { setParameters(); return true; }
      return false;
    },
    init({ resume = false } = {}) {
      if (resume && _sessionActive && _hasPlan && workout && draftContext?.owner === Auth.userId() && draftContext?.profile === DATA.getCurrentUser()) {
        loadData(); _step = 'result'; render(); return;
      }
      endSession(); _sessionActive = true;
      draftContext={owner:Auth.userId(),profile:DATA.getCurrentUser()};
      loadData();
      workout = loadWorkout();
      workout.readiness = READINESS[workout.readiness] ? workout.readiness : "средняя";
      workout.target = Math.max(1, Math.min(10, +workout.target || 4));
      workout.splitDays = Math.max(1, Math.min(4, +workout.splitDays || 1));
      workout.reps = normalizeReps(workout.reps);
      workout.equipOff = [];
      workout.movements = Array.isArray(workout.movements) ? workout.movements.filter(n => categories.some(c => c.name === n)) : baseCats().map(c => c.name);
      workout.priority = workout.priority.filter(n => !workout.restrictions.includes(n));
      if (workout.active === "all") workout.active = 0;
      _step = 'parameters';
      _cEdit = false; _keepVolume = false;
      render();
    },
  };
})();
