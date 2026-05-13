-- Create keltus_ru_cms database and a dedicated user for Directus.
-- Run with:
--   sudo mysql < /home/john/Documents/Projects/keltus.ru/deploy/create-db.sql
--
-- Idempotent: re-running is safe (no DROP, only IF NOT EXISTS / IDENTIFIED BY).

CREATE DATABASE IF NOT EXISTS keltus_ru_cms
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE USER IF NOT EXISTS 'keltus_ru_cms'@'127.0.0.1'
  IDENTIFIED BY 'cms_local_dev_pw_change_for_prod';

GRANT ALL PRIVILEGES ON keltus_ru_cms.* TO 'keltus_ru_cms'@'127.0.0.1';

FLUSH PRIVILEGES;
