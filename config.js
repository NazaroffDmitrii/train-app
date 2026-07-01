/*
 * config.js — конфигурация подключения к Supabase
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ БЕЗОПАСНОСТЬ                                                              │
 * │                                                                           │
 * │ Этот файл отдаётся клиенту как есть (его кэширует и Service Worker, см.    │
 * │ sw.js → APP_SHELL). Всё, что здесь лежит, ПУБЛИЧНО, если сайт публичный.   │
 * │                                                                           │
 * │ SUPABASE_KEY — publishable key. В отличие от JSONBin Access Key, его      │
 * │ ПРЕДНАЗНАЧЕНО класть в открытый клиентский код — это часть архитектуры    │
 * │ Supabase. Безопасность обеспечивается RLS-политиками на таблице (см.      │
 * │ supabase-setup.sql), а не секретностью этого ключа. Ни при каких          │
 * │ обстоятельствах сюда не должен попасть secret key (sb_secret_...) —       │
 * │ он даёт полный доступ к БД в обход RLS.                                   │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

const CONFIG = {
  ENABLED: true,

  SUPABASE_URL: "https://xkaaimxkxureljjucapn.supabase.co",
  SUPABASE_KEY: "sb_publishable_hxLSUMUYKno0NaYw721ciA_w3zD4NeS",

  // Мэппинг локальных userId на строки таблицы public.snapshots (user_id).
  BINS: {
    user_dima: "dima",
    user_natela: "natela",
  },
};
