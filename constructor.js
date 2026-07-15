/*
 * Конструктор тренировок — порт логики из «Мышцы и категории.html» (см.
 * Актуальное/Логика конструктора тренировок.md). Работает поверх базы «Атлас»:
 * тренируем ДВИЖЕНИЯ (categories типа «База»), баланс подходов, fractional-объём
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
    "низкая":  { target: 2, range: "1–2", rpe: "4–6",  character: "локальные" },
    "средняя": { target: 4, range: "2–4", rpe: "7–8",  character: "региональные" },
    "высокая": { target: 5, range: "4–6", rpe: "9–10", character: "глобальные" },
  };
  const OVERLOAD_OK = ["Разгибание в ТБС (ягодичные)", "Разгибание позвоночника"];
  const VOL_WARN = 20, VOL_MAX = 22, OVERTRAIN_FRAC = 9;
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
  let exercises = [], categories = [], muscles = [], workout = null;
  let _cEdit = false;   // режим правки плана (покачивание + перетаскивание), как в упражнениях
  let _cDrag = null;    // активное перетаскивание карточки

  function loadData() {
    const uid = DATA.getCurrentUser();
    categories = DATA.atlasMovements();  // {name, group, type}
    muscles = DATA.atlasMuscles();       // {name, group, visible, bundles}
    // упражнения приложения → форма генератора; личные без atlas в генерацию не идут
    exercises = DATA.getVisibleExercises(uid).filter(e => e.atlas && !DATA.isHidden(uid, e.id)).map(e => ({
      id: e.id,
      name: e.name,
      equipment: e.atlas.equipment || "",
      level: LEVEL_RU[e.atlas.level] || "",
      categories: e.atlas.categories || [],
      muscles: {
        target: e.atlas.target || [],
        synergist: e.atlas.synergist || [],
        stabilizer: e.atlas.stabilizer || [],
      },
    }));
  }

  function defaultWorkout() {
    return {
      readiness: "средняя", target: READINESS["средняя"].target, reps: "8–12",
      priority: [], priorityBonus: 2, restrictions: [], settingsOpen: true,
      splitDays: 1, equipOff: [], pins: {},
      days: [{ name: "Тренировка 1", items: [] }], active: 0,
    };
  }
  function persist() {
    try { localStorage.setItem(`train_constructor_${DATA.getCurrentUser()}`, JSON.stringify(workout)); } catch (e) {}
  }
  function loadWorkout() {
    try {
      const r = localStorage.getItem(`train_constructor_${DATA.getCurrentUser()}`);
      if (r) { const d = JSON.parse(r); if (d && Array.isArray(d.days) && d.days.length) {
        d.priority = d.priority || []; d.restrictions = d.restrictions || []; d.equipOff = d.equipOff || []; d.pins = d.pins || {};
        return d;
      } }
    } catch (e) {}
    return defaultWorkout();
  }

  /* ── Хелперы таксономии ──────────────────────────────────────────────────── */
  function baseCats() { return categories.filter(c => c.type === "База"); }
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
  function exSig(e) { return exBaseCats(e).slice().sort().join(" | "); }
  function alternatives(e) { const sig = exSig(e); return exercises.filter(x => x.id !== e.id && exSig(x) === sig); }
  function replaceOptions(e) { const sig = exSig(e); return exercises.filter(x => exSig(x) === sig); }
  function setsForEx(e) { let s = 0; exBaseCats(e).forEach(c => { s = Math.max(s, targetFor(c)); }); return s || (+workout.target || 3); }

  function generateInto(movements) {
    const set = new Set(movements);
    const pool = exercises.filter(e => { const bc = exBaseCats(e); return bc.length && bc.every(c => set.has(c)) && equipAllowed(e); });
    const uncovered = new Set(movements), usedIds = new Set(), chosen = [], load = {};
    if (workout.readiness !== "низкая") {
      const K = (workout.readiness === "высокая" ? 2 : 1) * Math.max(1, +workout.splitDays || 1);
      let seeded = 0, sg = 0;
      while (seeded < K && uncovered.size && sg++ < 50) {
        const gp = pool.filter(e => !usedIds.has(e.id) && exCharacter(e) === "глобальные" && exBaseCats(e).some(c => uncovered.has(c)));
        if (!gp.length) break;
        const e = pickForGen(gp, load);
        usedIds.add(e.id); const s = setsForEx(e);
        chosen.push({ exId: e.id, sets: s, reps: workout.reps || "8–12", rpe: READINESS[workout.readiness].rpe });
        exBaseCats(e).forEach(c => uncovered.delete(c));
        loadKeys(e).forEach(x => { load[x.key] = (load[x.key] || 0) + s * x.w; });
        seeded++;
      }
    }
    let guard = 0;
    while (uncovered.size && guard++ < 400) {
      const m = randPick([...uncovered]);
      let cands = pool.filter(e => !usedIds.has(e.id) && exBaseCats(e).includes(m));
      if (!cands.length) { uncovered.delete(m); continue; }
      const nonRed = cands.filter(e => exBaseCats(e).every(c => uncovered.has(c)));
      if (nonRed.length) cands = nonRed;
      const multi = cands.filter(e => exBaseCats(e).filter(c => uncovered.has(c)).length >= 2);
      const bucket = (multi.length && Math.random() < compoundProb()) ? multi : cands;
      const e = pickForGen(bucket, load);
      usedIds.add(e.id);
      const sets = setsForEx(e);
      chosen.push({ exId: e.id, sets, reps: workout.reps || "8–12", rpe: READINESS[workout.readiness].rpe });
      exBaseCats(e).forEach(c => uncovered.delete(c));
      loadKeys(e).forEach(x => { load[x.key] = (load[x.key] || 0) + sets * x.w; });
    }
    const rank = { glob: 0, reg: 1, loc: 2 };
    chosen.sort((a, b) => { const ea = exById(a.exId), eb = exById(b.exId); return (rank[CHAR[exCharacter(ea)]] - rank[CHAR[exCharacter(eb)]]) || (exBaseCats(eb).length - exBaseCats(ea).length); });
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
    const baseNames = baseCats().map(c => c.name).filter(n => !restricted.has(n));
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
    workout.active = 0; render();
  }
  function fillDay() {
    if (!exercises.length) { showToast("В базе нет упражнений"); return; }
    const day = activeDay(), activeIdx = workout.active;
    const restricted = new Set(workout.restrictions), pins = workout.pins || {};
    const micro = microCoverage();
    const inDay = new Set(); day.items.forEach(it => { const e = exById(it.exId); if (e) exBaseCats(e).forEach(c => inDay.add(c)); });
    const targets = baseCats().map(c => c.name).filter(name => {
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
    const pool = exercises.filter(e => { const bc = exBaseCats(e); return bc.length && bc.every(c => set.has(c)) && equipAllowed(e); });
    const uncovered = new Set(targets), added = []; let guard = 0, addVol = 0;
    while (uncovered.size && guard++ < 400) {
      if (dayVolume(day) + addVol >= VOL_WARN) break;
      const m = randPick([...uncovered]);
      let cands = pool.filter(e => !usedIds.has(e.id) && exBaseCats(e).includes(m));
      if (!cands.length) { uncovered.delete(m); continue; }
      const jointOk = cands.filter(e => { const z = jointLoad(e); return !z || !dayZones[z]; });
      if (jointOk.length) cands = jointOk;
      const nonRed = cands.filter(e => exBaseCats(e).every(c => uncovered.has(c)));
      if (nonRed.length) cands = nonRed;
      const multi = cands.filter(e => exBaseCats(e).filter(c => uncovered.has(c)).length >= 2);
      const bucket = (multi.length && Math.random() < compoundProb()) ? multi : cands;
      const e = pickForGen(bucket, load);
      usedIds.add(e.id);
      const sets = setsForEx(e);
      added.push({ exId: e.id, sets, reps: workout.reps || "8–12", rpe: READINESS[workout.readiness].rpe }); addVol += sets;
      exBaseCats(e).forEach(c => uncovered.delete(c));
      loadKeys(e).forEach(x => load[x.key] = (load[x.key] || 0) + sets * x.w);
      const z = jointLoad(e); if (z) dayZones[z] = (dayZones[z] || 0) + 1;
    }
    if (!added.length) { showToast("Лимит занятия достигнут — убери лишнее или добавь день"); return; }
    day.items = day.items.concat(added);
    const rank = { glob: 0, reg: 1, loc: 2 };
    day.items.sort((a, b) => { const ea = exById(a.exId), eb = exById(b.exId); return (rank[CHAR[exCharacter(ea)]] - rank[CHAR[exCharacter(eb)]]) || (exBaseCats(eb).length - exBaseCats(ea).length); });
    render();
  }
  function regenItem(di, i) { const d = workout.days[+di]; if (!d) return; const it = d.items[i]; const e = exById(it.exId); if (!e) return; const alts = alternatives(e); if (!alts.length) { showToast("Нет других вариантов"); return; } it.exId = randPick(alts).id; render(); }
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
    const closed = base.filter(c => (cov[c.name] || 0) > 0);
    if (closed.length) {
      const min = Math.min(...closed.map(c => cov[c.name]));
      const exempt = c => OVERLOAD_OK.includes(c.name) || workout.priority.includes(c.name);
      const over = closed.filter(c => !exempt(c) && cov[c.name] - min > 1).map(c => c.name + " (" + cov[c.name] + ")");
      if (over.length) warns.push({ t: "warn", m: "Перекос по подходам" + sfx + " (разница >1 от минимума " + min + "): " + over.join(", ") + "." });
    }
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
    if (!filled.length) { showToast("План пуст — сначала сгенерируй"); return; }
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
    showToast(single ? "Шаблон сохранён" : n + " шаблона сохранено");
    goToScreen("templates");
  }

  /* ── Render (мобильный UI в #constructor-scroll) ─────────────────────────── */
  function segHtml(name, options, cur, handler) {
    return `<div class="wk-seg">${options.map(o => {
      const val = Array.isArray(o) ? o[0] : o, lbl = Array.isArray(o) ? o[1] : o;
      return `<button class="wk-seg-btn${String(cur) === String(val) ? " active" : ""}" data-${name}="${esc(val)}">${esc(lbl)}</button>`;
    }).join("")}</div>`;
  }
  function chipsHtml(cls, list, activeSet, attr) {
    return `<div class="wk-chips">${list.map(n =>
      `<button class="wk-chip ${cls}${activeSet.has(n) ? " active" : ""}" data-${attr}="${esc(n)}">${esc(n)}</button>`).join("")}</div>`;
  }
  // Выпадающий выбор (как в форме мышц): выбранное — чипами с ✕, снизу — раскрытие
  // вниз со списком оставшихся. Открытый список запоминается в workout.uiOpen,
  // чтобы переживать полный re-render. data-<attr> на чипе и опции переиспользует
  // тот же тумблер, что и раньше (клик по чипу снимает, по опции — добавляет).
  function ddHtml(kind, options, selectedNames, attr, placeholder, chipMod) {
    const openK = workout.uiOpen === kind;
    const chips = selectedNames.length ? `<div class="wk-dd-chips">${selectedNames.map(n =>
      `<span class="wk-dd-chip${chipMod ? " " + chipMod : ""}" data-${attr}="${esc(n)}">${esc(n)}<span class="wk-dd-x">×</span></span>`).join("")}</div>` : "";
    const rest = options.filter(o => !selectedNames.includes(o));
    const trigger = `<button class="wk-dd-trigger${openK ? " open" : ""}" data-ddtoggle="${kind}"><span>${esc(placeholder)}</span><span class="wk-dd-caret">⌄</span></button>`;
    const panel = openK ? `<div class="wk-dd-panel">${
      rest.length ? rest.map(o => `<button class="wk-dd-opt" data-${attr}="${esc(o)}">${esc(o)}</button>`).join("")
                  : `<div class="wk-dd-empty">Все добавлены</div>`
    }</div>` : "";
    return `<div class="wk-dd">${chips}${trigger}${panel}</div>`;
  }

  function render() {
    const el = $("constructor-scroll");
    if (!el) return;
    const rd = READINESS[workout.readiness];
    const multi = workout.days.length > 1;
    const open = workout.settingsOpen !== false;

    // — Настройки —
    const prioritySet = new Set(workout.priority), restrictSet = new Set(workout.restrictions), equipOffSet = new Set(workout.equipOff);
    const baseNames = baseCats().map(c => c.name);
    const settings = `
      <div class="wk-card">
        <button class="wk-set-toggle" id="wk-set-toggle">
          <span>Параметры</span>
          <span class="wk-set-chev">${open ? "▴" : "▾"}</span>
        </button>
        ${open ? `
        <div class="wk-set-body">
          <div class="wk-field">
            <span class="wk-label">Готовность</span>
            ${segHtml("readiness", ["низкая", "средняя", "высокая"], workout.readiness)}
            <p class="wk-hint">Характер: ${esc(rd.character)} · усилие ${esc(rd.rpe)} (RPE)</p>
          </div>
          <div class="wk-field wk-row">
            <div><span class="wk-label">Подходов / движение</span>
              <input class="wk-num" id="wk-target" type="number" min="0" value="${workout.target}"></div>
            <div><span class="wk-label">Повторы</span>
              <input class="wk-num wk-num-wide" id="wk-reps" type="text" value="${esc(workout.reps)}"></div>
          </div>
          <div class="wk-field">
            <span class="wk-label">Дней в сплите</span>
            ${segHtml("split", [[1, "1 день"], [2, "2 дня"], [3, "3 дня"], [4, "4 дня"]], workout.splitDays)}
            <p class="wk-hint">${workout.splitDays > 1 ? "Баланс считается за всю неделю; дни — срезы." : "Fullbody — все движения за одно занятие."}</p>
          </div>
          <div class="wk-field">
            <span class="wk-label">Доступное оборудование</span>
            ${ddHtml("equip", EQUIP_TAGS, EQUIP_TAGS.filter(t => !equipOffSet.has(t)), "equip", "＋ добавить оборудование")}
            <p class="wk-hint">В списке — доступное; чего нет в зале, убери крестиком.</p>
          </div>
          <div class="wk-field">
            <span class="wk-label">Приоритет (+${workout.priorityBonus} подх.)</span>
            ${ddHtml("prio", baseNames, [...prioritySet], "prio", "＋ добавить движение в приоритет")}
          </div>
          <div class="wk-field">
            <span class="wk-label">Ограничения (не грузить)</span>
            ${ddHtml("restr", baseNames, [...restrictSet], "restr", "＋ добавить ограничение", "warn")}
          </div>
        </div>` : `<p class="wk-set-sum">Готовность: <b>${esc(workout.readiness)}</b> · цель ${workout.target} · дней: ${workout.days.length}</p>`}
      </div>
      <button class="wk-generate" id="wk-generate">⟳ Сгенерировать план</button>`;

    const isAll = workout.active === "all";
    const rank = { "глобальные": "Г", "региональные": "Р", "локальные": "Л" };

    // — Вкладки дней + «Целая» (при многодневном сплите) —
    let daysHtml = "";
    if (multi) {
      daysHtml = `<div class="wk-days">${workout.days.map((d, i) => `
        <button class="wk-day${!isAll && i === workout.active ? " active" : ""}${dayVolume(d) > VOL_MAX ? " over" : ""}" data-day="${i}">
          <span class="wk-day-name">${esc(d.name)}</span><span class="wk-day-vol">${dayVolume(d)}п</span>
        </button>`).join("")}
        <button class="wk-day wk-day-all${isAll ? " active" : ""}" data-day="all">
          <span class="wk-day-name">Целая</span><span class="wk-day-vol">${totalVolume()}п</span>
        </button></div>`;
    }

    // — Покрытие: карточка по набору движений —
    const covCard = (title, cov, total) => {
      const covered = baseCats().map(c => c.name).filter(n => (cov[n] || 0) > 0);
      return `<div class="wk-card">
        <div class="wk-card-head">${esc(title)} <span class="wk-vol-badge${total > VOL_MAX ? " over" : total > VOL_WARN ? " high" : ""}">${total} подх.</span></div>
        ${covered.length ? `<div class="wk-chips">${covered.map(n => `<span class="wk-cov-chip">${esc(n)} <b>${cov[n]}</b></span>`).join("")}</div>` : `<p class="wk-hint">Движения не покрыты — сгенерируй или добавь упражнения.</p>`}
      </div>`;
    };
    let covHtml = "";
    if (isAll) covHtml = covCard("Общее покрытие за микроцикл", microCoverage(), totalVolume());
    else if (multi) covHtml = covCard("День «" + activeDay().name + "»", coverage(), dayVolume(activeDay())) + covCard("Общее за микроцикл", microCoverage(), totalVolume());
    else covHtml = covCard("Покрытие", coverage(), dayVolume(activeDay()));

    // — Замечания стопкой: одно за раз, счётчик «i / N», листается стрелками/свайпом —
    const warns = warnings();
    let warnHtml;
    if (!warns.length) {
      warnHtml = `<div class="wk-ok">✓ ${multi ? "Микроцикл сбалансирован." : "Движения закрыты, объём в норме."}</div>`;
    } else {
      if (workout.warnIdx == null || workout.warnIdx >= warns.length) workout.warnIdx = warns.length - 1;
      if (workout.warnIdx < 0) workout.warnIdx = 0;
      const wi = workout.warnIdx, w = warns[wi];
      const dots = warns.map((_, i) => `<span class="wk-warn-dot${i === wi ? " on" : ""}"></span>`).join("");
      warnHtml = `<div class="wk-card wk-warns-card">
        <div class="wk-card-head">Замечания <span class="wk-warns-count">${wi + 1} / ${warns.length}</span></div>
        <div class="wk-warn-stack" id="wk-warn-stack"><div class="wk-warn ${w.t}">${esc(w.m)}</div></div>
        ${warns.length > 1 ? `<div class="wk-warn-nav">
          <button class="wk-warn-arrow" data-warnnav="-1"${wi === 0 ? " disabled" : ""}>‹</button>
          <div class="wk-warn-dots">${dots}</div>
          <button class="wk-warn-arrow" data-warnnav="1"${wi === warns.length - 1 ? " disabled" : ""}>›</button>
        </div>` : ""}
      </div>`;
    }

    // — Карточка упражнения плана: свайп влево = удалить, удержание = перетащить,
    //   ⟳ = другой вариант, ряд дней (много-день) = быстрый перенос —
    const itemHtml = (it, di, i) => {
      const e = exById(it.exId);
      const nm = e ? e.name : "Упражнение недоступно";
      const mv = e ? exBaseCats(e).join(" · ") : "";
      const ch = e ? rank[exCharacter(e)] : "";
      const dayChips = multi ? `<div class="wk-item-days">${workout.days.map((d, dj) =>
        `<button class="wk-item-day${dj === di ? " cur" : ""}" data-moveto="${dj}" data-di="${di}" data-i="${i}">${esc(d.name)}</button>`).join("")}</div>` : "";
      return `<div class="wk-item-wrap" data-di="${di}" data-i="${i}">
        <div class="wk-item-del">${WK_TRASH}Удалить</div>
        <div class="wk-item">
          <div class="wk-item-top">
            <span class="wk-item-lvl">${ch}</span>
            <span class="wk-item-name">${esc(nm)}</span>
            <span class="wk-item-sets">${it.sets}×${esc(it.reps || "")}</span>
            <button class="wk-item-regen" data-regen data-di="${di}" data-i="${i}" title="Другой вариант">⟳</button>
          </div>
          ${mv ? `<div class="wk-item-mv">${esc(mv)}</div>` : ""}
          ${dayChips}
        </div>
      </div>`;
    };

    // — План: активный день, либо «Целая» плоским списком с заголовками-днями
    //   (как группы категорий в списке упражнений — перетаскивание в другой день
    //   переносит туда). В режиме правки карточки покачиваются. —
    const emptyMsg = `<p class="wk-empty">План пуст. Настрой параметры и нажми «Сгенерировать» или добавь упражнение вручную.</p>`;
    const editCls = _cEdit ? " wk-editing" : "";
    let planHtml;
    if (isAll) {
      const secs = workout.days.map((d, di) => {
        const head = `<div class="wk-day-sec-head" data-di="${di}">${esc(d.name)} <span class="wk-day-sec-vol">${dayVolume(d)}п</span></div>`;
        const items = d.items.length ? d.items.map((it, i) => itemHtml(it, di, i)).join("") : `<div class="wk-sec-empty" data-di="${di}">Пусто${_cEdit ? " — перетащи сюда" : ""}</div>`;
        return head + items;
      }).join("");
      planHtml = `<div class="wk-plan wk-plan-flat${editCls}">${secs}</div>`;
    } else {
      const items = activeDay().items;
      planHtml = items.length
        ? `<div class="wk-plan${editCls}" data-di="${workout.active}">${items.map((it, i) => itemHtml(it, workout.active, i)).join("")}</div>`
        : emptyMsg;
    }
    const hasAny = workout.days.some(d => d.items.length);
    const doneBtn = _cEdit ? `<button class="wk-edit-done" id="wk-edit-done">Готово</button>` : "";

    // Ручное добавление — доступно всегда (план можно собрать и без генерации).
    const addManual = `<button class="wk-add-manual" id="wk-add">＋ Добавить упражнение вручную</button>`;
    const actions = hasAny || multi ? `
      <div class="wk-actions">
        <button class="wk-act primary wk-act-full" id="wk-save">Сохранить как шаблон${multi ? "ы" : ""}</button>
        <div class="wk-actions-row">
          <button class="wk-act" id="wk-fill">＋ Дополнить ${isAll ? "дни" : "день"}</button>
          <button class="wk-act wk-act-clear" id="wk-clear">Очистить ${isAll ? "всё" : "день"}</button>
        </div>
      </div>` : "";

    el.innerHTML = settings + daysHtml + (hasAny ? covHtml + warnHtml : "") + planHtml + addManual + actions + doneBtn;
    wire();
    persist();
  }

  function wire() {
    const el = $("constructor-scroll");
    const on = (sel, ev, fn) => el.querySelectorAll(sel).forEach(n => n.addEventListener(ev, () => fn(n)));

    $("wk-set-toggle") && $("wk-set-toggle").addEventListener("click", () => { workout.settingsOpen = !(workout.settingsOpen !== false); render(); });
    on("[data-readiness]", "click", n => { workout.readiness = n.dataset.readiness; workout.target = READINESS[workout.readiness].target; render(); });
    on("[data-split]", "click", n => { workout.splitDays = Math.max(1, Math.min(6, +n.dataset.split || 1)); render(); });
    on("[data-ddtoggle]", "click", n => { const k = n.dataset.ddtoggle; workout.uiOpen = workout.uiOpen === k ? null : k; render(); });
    on("[data-equip]", "click", n => { const t = n.dataset.equip; const i = workout.equipOff.indexOf(t); if (i >= 0) workout.equipOff.splice(i, 1); else workout.equipOff.push(t); workout.uiOpen = null; render(); });
    on("[data-prio]", "click", n => { const t = n.dataset.prio; const i = workout.priority.indexOf(t); if (i >= 0) workout.priority.splice(i, 1); else workout.priority.push(t); workout.uiOpen = null; render(); });
    on("[data-restr]", "click", n => { const t = n.dataset.restr; const i = workout.restrictions.indexOf(t); if (i >= 0) workout.restrictions.splice(i, 1); else workout.restrictions.push(t); workout.uiOpen = null; render(); });
    on("[data-day]", "click", n => { workout.active = n.dataset.day === "all" ? "all" : +n.dataset.day; render(); });
    on("[data-regen]", "click", n => regenItem(n.dataset.di, +n.dataset.i));
    on("[data-moveto]", "click", n => moveToDay(n.dataset.di, +n.dataset.i, +n.dataset.moveto));
    on("[data-warnnav]", "click", n => { workout.warnIdx = (workout.warnIdx || 0) + (+n.dataset.warnnav); render(); });
    // Свайп влево = удалить; долгое удержание = режим правки → перетаскивание
    // (как в списке упражнений).
    el.querySelectorAll(".wk-item-wrap").forEach(wrap => { wireItemSwipe(wrap); wireItemGesture(wrap); });
    $("wk-edit-done") && $("wk-edit-done").addEventListener("click", exitCEdit);
    // Свайп по стопке замечаний — листать вперёд/назад.
    const warnStack = $("wk-warn-stack"); if (warnStack) wireWarnSwipe(warnStack);

    const tgt = $("wk-target"); if (tgt) tgt.addEventListener("change", () => { workout.target = Math.max(0, +tgt.value || 0); persist(); });
    const reps = $("wk-reps"); if (reps) reps.addEventListener("change", () => { workout.reps = reps.value; persist(); });
    $("wk-generate") && $("wk-generate").addEventListener("click", generate);
    $("wk-fill") && $("wk-fill").addEventListener("click", fillDay);
    $("wk-clear") && $("wk-clear").addEventListener("click", () => { if (workout.active === "all") workout.days.forEach(d => d.items = []); else activeDay().items = []; render(); });
    $("wk-save") && $("wk-save").addEventListener("click", saveAsTemplates);
    $("wk-add") && $("wk-add").addEventListener("click", openExercisePicker);
  }

  // Свайп влево по карточке плана → удалить (порог 80px).
  function wireItemSwipe(wrap) {
    const row = wrap.querySelector(".wk-item");
    if (!row) return;
    let sx = 0, sy = 0, dx = 0, active = false, decided = false, horiz = false, swiped = false;
    const MAX = 96, DEL = 80;
    row.addEventListener("pointerdown", e => {
      if (e.target.closest("button")) return;
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
      if (target && target.closest("button")) return;
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

  // Свайп по стопке замечаний → предыдущее/следующее.
  function wireWarnSwipe(stack) {
    let sx = 0, sy = 0, active = false, decided = false, horiz = false;
    stack.addEventListener("pointerdown", e => { sx = e.clientX; sy = e.clientY; active = true; decided = false; horiz = false; });
    stack.addEventListener("pointermove", e => {
      if (!active) return;
      const mx = e.clientX - sx, my = e.clientY - sy;
      if (!decided) { if (Math.abs(mx) < 10 && Math.abs(my) < 10) return; decided = true; horiz = Math.abs(mx) > Math.abs(my); if (!horiz) active = false; }
    });
    const end = e => {
      if (!active || !horiz) { active = false; return; }
      active = false;
      const mx = e.clientX - sx;
      if (Math.abs(mx) < 40) return;
      workout.warnIdx = (workout.warnIdx || 0) + (mx < 0 ? 1 : -1);
      render();
    };
    stack.addEventListener("pointerup", end);
    stack.addEventListener("pointercancel", () => { active = false; });
  }

  // Ручной выбор упражнения в план активного дня (модалка с поиском по базе).
  function openExercisePicker() {
    if (!exercises.length) { showToast("В базе нет упражнений"); return; }
    const bd = document.createElement("div");
    bd.className = "modal-backdrop open ref-form-backdrop";
    bd.style.zIndex = "60";
    bd.innerHTML = `
      <div class="modal modal-form modal-scroll wk-picker">
        <h2 class="modal-title">Добавить упражнение</h2>
        <input class="ex-form-input" id="wk-pick-search" type="text" placeholder="Поиск по названию…" autocomplete="off">
        <div class="wk-pick-list" id="wk-pick-list"></div>
        <div class="modal-form-actions"><button class="btn-chip" data-act="cancel">Закрыть</button></div>
      </div>`;
    document.body.appendChild(bd);
    const close = () => bd.remove();
    bd.addEventListener("click", e => { if (e.target === bd) close(); });
    bd.querySelector('[data-act="cancel"]').addEventListener("click", close);
    const listEl = $("wk-pick-list"), inp = $("wk-pick-search");
    const renderList = () => {
      const q = inp.value.trim().toLowerCase();
      const pool = exercises.filter(e => !q || (e.name || "").toLowerCase().includes(q))
        .sort((a, b) => (a.name || "").localeCompare(b.name || "", "ru")).slice(0, 300);
      listEl.innerHTML = pool.length
        ? pool.map(e => { const mv = exBaseCats(e).join(" · "); return `<button class="wk-pick-item" data-id="${esc(e.id)}"><span class="wk-pick-name">${esc(e.name)}</span>${mv ? `<span class="wk-pick-mv">${esc(mv)}</span>` : ""}</button>`; }).join("")
        : `<p class="wk-hint" style="text-align:center;padding:20px">Ничего не найдено</p>`;
      listEl.querySelectorAll(".wk-pick-item").forEach(b => b.addEventListener("click", () => {
        const e = exById(b.dataset.id); if (!e) return;
        activeDay().items.push({ exId: e.id, sets: setsForEx(e), reps: workout.reps || "8–12", rpe: READINESS[workout.readiness].rpe });
        close(); render(); showToast("Упражнение добавлено");
      }));
    };
    renderList();
    inp.addEventListener("input", renderList);
    setTimeout(() => inp.focus(), 60);
  }

  /* ── Публичный API ───────────────────────────────────────────────────────── */
  window.CONSTRUCTOR = {
    init() {
      loadData();
      workout = loadWorkout();
      render();
    },
  };
})();
