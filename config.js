/*
 * config.js — конфигурация подключения к JSONBin
 * Сгенерировано мастером setup.html — 22.06.2026, 13:25:10
 *
 * MASTER_KEY нужен только для создания новых бинов (каждая тренировка
 * получает свой бин). ACCESS_KEY используется для чтения и обновления.
 * Если создать отдельный Access Key не удалось — оба поля одинаковы.
 *
 * ВАЖНО: не публикуй этот файл в открытом репозитории, если оба ключа
 * совпадают (т.е. у тебя мастер-ключ в обоих полях).
 */

const CONFIG = {
  ENABLED: true,

  MASTER_KEY: "$2a$10$SmIUJtFC5cbDja71zw6um.48mUUtTFdADZFiFUK2R2GJ2tkdr99YS",
  ACCESS_KEY: "$2a$10$SmIUJtFC5cbDja71zw6um.48mUUtTFdADZFiFUK2R2GJ2tkdr99YS",

  BINS: {
    exercises: "6a390d83da38895dfeeaae66",
    user_dima: "6a390d84f5f4af5e291c35a2",
    user_natela: "6a390d84f5f4af5e291c35a3",
    templates_dima: "6a390d85da38895dfeeaae67",
    templates_natela: "6a390d85da38895dfeeaae68",
    workoutIndex_dima: "6a390d85da38895dfeeaae69",
    workoutIndex_natela: "6a390d86f5f4af5e291c35a4",
  },
};
