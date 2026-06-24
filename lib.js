/*
 * lib.js — чистые функции без зависимостей от DOM/localStorage.
 *
 * Вынесены сюда, чтобы их можно было проверять в изоляции (см. tests.html) и
 * переиспользовать. Грузится ПЕРЕД app.js, так что app.js видит их как глобали.
 * Сюда кладём только формулы/форматтеры без побочных эффектов.
 */

const DAY_MS = 86400000;

// Секунды → "м:сс" или "ч:мм:сс".
function formatDuration(totalSec) {
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
  return `${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
}

// "ч:мм:сс" | "мм:сс" | "сс" → секунды.
function parseDurationToSec(str) {
  const parts = String(str).split(":").map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] || 0;
}

function fmtDate(ts) {
  const d = new Date(ts);
  const day = String(d.getDate()).padStart(2,"0");
  const mon = String(d.getMonth() + 1).padStart(2,"0");
  return `${day}.${mon}.${d.getFullYear()}`;
}

// Темп хранится строкой "м:сс" (раздел 7 спеки) — для графиков нужно число секунд и обратно.
function paceStrToSec(str) {
  const [m, s] = String(str).split(":").map(Number);
  return (m || 0) * 60 + (s || 0);
}
function secToPaceStr(totalSec) {
  const m = Math.floor(totalSec / 60);
  const s = Math.round(totalSec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

// Начало дня (локальная полночь) для метки ts.
function statsStartOfDay(ts) {
  const d = new Date(ts); d.setHours(0,0,0,0); return d.getTime();
}

// Серия тренировок: текущая (если последняя — сегодня или вчера) и лучшая.
function computeStreak(workouts) {
  if (!workouts.length) return { current: 0, best: 0 };
  const daySet = new Set(workouts.map(w => statsStartOfDay(w.startedAt)));
  const days = Array.from(daySet).sort((a,b) => b - a);
  const todayStart = statsStartOfDay(Date.now());
  const yest = todayStart - DAY_MS;
  let current = 0;
  if (days[0] === todayStart || days[0] === yest) {
    for (let i = 0; i < days.length; i++) {
      if (days[i] === days[0] - i * DAY_MS) current++;
      else break;
    }
  }
  let best = 0, run = 1;
  for (let i = 1; i < days.length; i++) {
    if (days[i-1] - days[i] === DAY_MS) run++;
    else { if (run > best) best = run; run = 1; }
  }
  if (run > best) best = run;
  if (current > best) best = current;
  return { current, best };
}
