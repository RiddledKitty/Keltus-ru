# Развёртывание keltus.ru

Папка `deploy/` содержит всё, что нужно, чтобы поднять keltus.ru на свежем
сервере с уже установленным базовым стеком (Node 20+, MariaDB, nginx, certbot).

## Быстрый старт

```bash
# 1. Распакуйте архив с кодом в /var/www/keltus.ru
sudo mkdir -p /var/www/keltus.ru
sudo tar -xzf keltus-ru-deploy.tar.gz -C /var/www/keltus.ru

# 2. Запустите установщик от root
sudo bash /var/www/keltus.ru/deploy/install-latvia.sh
```

Скрипт:
1. сгенерирует свежие секреты под `/root/keltus-ru-secrets/secrets.env`;
2. создаст две базы MariaDB (CMS + аналитика) и пользователей;
3. напишет `cms/.env`, `web/.env`, `analytics/.env`, `.deploy-secrets`;
4. поставит зависимости (`npm install`) для CMS, веба и каждого расширения Directus;
5. выполнит `directus bootstrap` (схема и первый администратор);
6. установит юниты `keltus-ru-cms`, `keltus-ru-rebuild`, `keltus-ru-analytics` и
   запустит первые два (Go-бинарник аналитики собирается отдельно);
7. прогонит `setup-collections.mjs`, `setup-contact-requests.mjs`, `seed-content.mjs`;
8. выставит публичные права чтения через политику Public в Directus 11;
9. вызовет первую пересборку статики через rebuild-листенер;
10. установит nginx-vhost (HTTP) и сделает `nginx -t && systemctl reload nginx`.

В конце установщик распечатает логин и пароль администратора. Они также
сохранены в `/root/keltus-ru-secrets/secrets.env`.

## Что осталось сделать руками

1. **DNS.** Направьте A-записи `keltus.ru`, `www.keltus.ru`, `admin.keltus.ru`
   на этот сервер.
2. **HTTPS.** Когда DNS поднимется:
   ```bash
   sudo certbot --nginx -d keltus.ru -d www.keltus.ru -d admin.keltus.ru
   ```
3. **Аналитика на Go.** Соберите бинарник и запустите юнит:
   ```bash
   cd /var/www/keltus.ru/analytics
   sudo -u www-data go build -o keltusanalytics ./cmd/keltusanalytics
   sudo systemctl enable --now keltus-ru-analytics
   ```
4. **Почта.** Заполните Brevo или SMTP в `/var/www/keltus.ru/cms/.env`,
   затем `sudo systemctl restart keltus-ru-cms`. Без этого контактная форма
   сохраняет заявку в БД, но не отправляет письмо-уведомление.
5. **Cloudflare (необязательно).** Если домен стоит за Cloudflare —
   заполните `CLOUDFLARE_API_TOKEN` и `CLOUDFLARE_ZONE_ID` в
   `/var/www/keltus.ru/.deploy-secrets`, затем
   `sudo systemctl restart keltus-ru-rebuild`. Иначе кэш CDN придётся
   сбрасывать вручную после правок в админке.

## Порты

| Сервис             | Порт | Юнит                       |
|--------------------|-----:|----------------------------|
| Directus           | 8057 | `keltus-ru-cms.service`    |
| Аналитика (Go)     | 4330 | `keltus-ru-analytics.service` |
| Rebuild-листенер   | 4338 | `keltus-ru-rebuild.service` |

## Ручная пересборка статики

```bash
source /var/www/keltus.ru/.deploy-secrets
curl -sf -X POST "http://127.0.0.1:4338/rebuild" \
  -H "Authorization: Bearer $REBUILD_SECRET"
```

**Никогда не запускайте `npm run build` от root** в `/var/www/keltus.ru/web` —
файлы попадут в `dist/` с владельцем root, и следующая пересборка как
www-data (которую запускает rebuild-листенер по вебхуку Directus) упадёт с
`EACCES`, оставив `dist/` без `index.html`. nginx начнёт отдавать 403.
Если это случилось:

```bash
sudo chown -R www-data:www-data /var/www/keltus.ru/web/dist
# затем повторите пересборку через листенер выше
```
