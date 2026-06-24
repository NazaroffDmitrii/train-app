/*
 * storage.js — адаптер доступа к удалённому хранилищу (раздел 2 спецификации)
 *
 * Сейчас бэкенда нет, поэтому здесь реализован клиент JSONBin (https://jsonbin.io)
 * напрямую из браузера через fetch. Это единственный файл, который вообще
 * знает о существовании JSONBin — DATA, sync.js и экраны приложения обращаются
 * только к функциям ниже. Когда появится нормальный бэкенд, переписывается
 * только этот файл (и config.js), остальной код не меняется.
 *
 * Один bin = один JSON-документ. Обновление всегда перезаписывает документ
 * целиком (PUT) — построчных/частичных обновлений JSONBin не поддерживает.
 * Поэтому данные разбиты на отдельные бины по сущностям (раздел 8 спецификации) —
 * чтобы конкурентные перезаписи разных бинов не били друг друга.
 *
 * Ключ доступа (Access Key, не Master Key — см. config.js) живёт в клиентском
 * коде в открытом виде. Это осознанный компромисс пет-проекта на двух
 * доверенных пользователей (раздел 2 спецификации), снимается при переезде
 * на нормальный бэкенд.
 */

const Storage = (() => {
  let cfg = { enabled: false, baseUrl: "https://api.jsonbin.io/v3", accessKey: "", masterKey: "" };

  function configure(next) {
    cfg = { ...cfg, ...next };
  }

  function isEnabled() {
    return !!(cfg.enabled && (cfg.accessKey || cfg.masterKey));
  }

  function hasSeparateAccessKey() {
    return !!(cfg.accessKey && cfg.accessKey !== cfg.masterKey);
  }

  // Для чтения/обновления бинов — отдельный Access Key отправляем как
  // X-Access-Key, а мастер-ключ как X-Master-Key. JSONBin не считает
  // мастер-ключ валидным access key, даже если строка ключа та же самая.
  function authHeaders(extra) {
    const auth = hasSeparateAccessKey()
      ? { "X-Access-Key": cfg.accessKey }
      : { "X-Master-Key": cfg.masterKey || cfg.accessKey };
    return { ...auth, ...extra };
  }

  // Для СОЗДАНИЯ бина предпочитаем X-Master-Key; если пользователь всё же
  // настроил отдельный Access Key с правом Create и не указал мастер-ключ,
  // отправляем его как X-Access-Key.
  function createAuthHeaders(extra) {
    const auth = cfg.masterKey
      ? { "X-Master-Key": cfg.masterKey }
      : { "X-Access-Key": cfg.accessKey };
    return { ...auth, ...extra };
  }

  async function throwHttpError(res, where) {
    let message = "";
    try { message = (await res.json())?.message || ""; }
    catch {
      try { message = await res.text(); } catch {}
    }
    throw new Error(`${where}: HTTP ${res.status}${message ? ` — ${message}` : ""}`);
  }

  // Создать новый bin с данными. Возвращает id созданного bin'а.
  // Используется только во время работы приложения для тренировок
  // (один bin на тренировку создаётся на лету — раздел 8 спецификации).
  async function createBin(data, name) {
    if (!isEnabled()) throw new Error("Storage: JSONBin отключён (см. config.js)");
    const res = await fetch(`${cfg.baseUrl}/b`, {
      method: "POST",
      keepalive: true,
      headers: createAuthHeaders({
        "Content-Type": "application/json",
        "X-Bin-Private": "true",
        ...(name ? { "X-Bin-Name": encodeURIComponent(name).slice(0, 120) } : {}),
      }),
      body: JSON.stringify(data),
    });
    if (!res.ok) await throwHttpError(res, "Storage.createBin");
    const json = await res.json();
    const id = json?.metadata?.id || json?.id;
    if (!id) throw new Error("Storage.createBin: сервер не вернул id");
    return id;
  }

  // Прочитать последнюю версию bin'а. null, если bin не найден (404) —
  // это не ошибка, просто «пока ничего нет», вызывающий код должен сам
  // решить, что в этом случае делать (обычно — оставить локальные данные).
  async function readBin(binId) {
    if (!isEnabled() || !binId) return null;
    const res = await fetch(`${cfg.baseUrl}/b/${binId}/latest`, {
      method: "GET",
      keepalive: true,
      headers: authHeaders(),
      cache: "no-store",
    });
    if (res.status === 404) return null;
    if (!res.ok) await throwHttpError(res, "Storage.readBin");
    const json = await res.json();
    return json?.record ?? json;
  }

  // Перезаписать bin целиком. X-Bin-Versioning: false — чтобы не копить
  // историю версий на каждое мелкое изменение (бесплатный тариф ограничен
  // числом запросов, а не места ради истории смысла нет — см. README).
  async function updateBin(binId, data) {
    if (!isEnabled() || !binId) throw new Error("Storage.updateBin: нет bin id или JSONBin отключён");
    const res = await fetch(`${cfg.baseUrl}/b/${binId}`, {
      method: "PUT",
      keepalive: true,
      headers: authHeaders({ "Content-Type": "application/json", "X-Bin-Versioning": "false" }),
      body: JSON.stringify(data),
    });
    if (!res.ok) await throwHttpError(res, "Storage.updateBin");
    const json = await res.json();
    return json?.record ?? json;
  }

  // Удалить bin безвозвратно. Нужно, чтобы удалённые/отменённые тренировки не
  // копились мусором на JSONBin. ВАЖНО: у Access Key должно быть право Delete
  // (Update и так позволяет перезаписать данные, так что это не расширяет риск).
  // 404 считаем успехом — бин уже удалён.
  async function deleteBin(binId) {
    if (!isEnabled() || !binId) return;
    const res = await fetch(`${cfg.baseUrl}/b/${binId}`, {
      method: "DELETE",
      keepalive: true,
      headers: authHeaders(),
    });
    if (!res.ok && res.status !== 404) await throwHttpError(res, "Storage.deleteBin");
  }

  return { configure, isEnabled, createBin, readBin, updateBin, deleteBin };
})();
