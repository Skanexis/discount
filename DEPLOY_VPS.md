# Full Deploy Guide: Local -> Git -> VPS

Этот бот работает через Telegram long polling (без HTTP-порта), поэтому:
- текущий домен не трогаем;
- nginx не трогаем;
- существующий процесс в `/opt/yosupport/app` не трогаем;
- поднимаем отдельный systemd-сервис `yosupport-discount-bot`.

## Что получится в итоге

- код бота хранится в Git-репозитории;
- VPS забирает код через `git clone` / `git pull`;
- бот работает как отдельный Linux service;
- обновление: `git pull` + `npm install` + `systemctl restart`.

## 0. Предварительные условия

1. Локально установлен `git`.
2. На VPS есть `git`, `node`, `npm`.
3. У вас есть репозиторий (GitHub/GitLab/Bitbucket).
4. Вы знаете Telegram `BOT_TOKEN`, `CHANNEL_ID`, `ADMIN_IDS`.

Проверки на VPS:

```bash
git --version
node --version
npm --version
```

## 1. Залить текущий проект в Git (с локального ПК)

Работайте из папки проекта `DISCOUNT`.

Если репозиторий еще не инициализирован:

```bash
git init
git add .
git commit -m "Initial telegram discount bot"
```

Создайте пустой репозиторий на GitHub/GitLab (без README/.gitignore), затем:

```bash
git branch -M main
git remote add origin <YOUR_REPO_URL>
git push -u origin main
```

Примеры `YOUR_REPO_URL`:
- SSH: `git@github.com:USERNAME/discount-bot.git`
- HTTPS: `https://github.com/USERNAME/discount-bot.git`

Если remote уже есть:

```bash
git remote -v
git remote set-url origin <YOUR_REPO_URL>
git push -u origin main
```

Дальше при каждом изменении локально:

```bash
git add .
git commit -m "Describe changes"
git push
```

## 2. Подготовить доступ VPS к приватному репозиторию (SSH)

Если репозиторий публичный, этот шаг можно пропустить.

Сделайте на VPS ключ для пользователя, под которым будет ходить Git (ниже используется `yosupport`):

```bash
id yosupport || sudo adduser --disabled-password --gecos "" yosupport
YO_HOME="$(getent passwd yosupport | cut -d: -f6)"
sudo mkdir -p "$YO_HOME/.ssh"
sudo chown -R yosupport:yosupport "$YO_HOME"
sudo chmod 700 "$YO_HOME/.ssh"
sudo -u yosupport -H ssh-keygen -t ed25519 -C "yosupport-discount-vps" -f "$YO_HOME/.ssh/id_ed25519" -N ""
sudo -u yosupport -H cat "$YO_HOME/.ssh/id_ed25519.pub"
```

Скопируйте вывод `.pub` и добавьте в репозиторий как Deploy Key (read-only).  
Проверьте доступ:

```bash
sudo -u yosupport -H ssh -T git@github.com
```

## 3. Первый деплой на VPS (без затрагивания текущего сервиса)

Создаем отдельную папку и клонируем проект:

```bash
sudo mkdir -p /opt/yosupport/app
sudo chown -R yosupport:yosupport /opt/yosupport
sudo -u yosupport -H bash -lc "cd /opt/yosupport/app && git clone <YOUR_REPO_URL> discount-bot"
```

Устанавливаем зависимости:

```bash
sudo -u yosupport -H bash -lc "cd /opt/yosupport/app/discount-bot && npm install --omit=dev"
```

Создаем `.env`:

```bash
sudo -u yosupport -H bash -lc "cd /opt/yosupport/app/discount-bot && cp .env.example .env"
sudo -u yosupport -H nano /opt/yosupport/app/discount-bot/.env
```

Заполните:
- `BOT_TOKEN=...`
- `CHANNEL_ID=@your_channel_or_-100...`
- `ADMIN_IDS=123456789,987654321`
- `DATA_FILE=./data/store.json`

Устанавливаем systemd unit:

```bash
sudo cp /opt/yosupport/app/discount-bot/deploy/systemd/yosupport-discount-bot.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable yosupport-discount-bot
sudo systemctl start yosupport-discount-bot
```

Если используете не `yosupport`, измените `User` и `Group` в `deploy/systemd/yosupport-discount-bot.service` до копирования unit в `/etc/systemd/system/`.

Проверка:

```bash
sudo systemctl status yosupport-discount-bot --no-pager
sudo journalctl -u yosupport-discount-bot -f
```

## 4. Обновление бота на VPS (новый коммит в Git)

После `git push` с локального ПК:

```bash
sudo -u yosupport -H bash -lc "cd /opt/yosupport/app/discount-bot && git fetch --all --prune && git pull --ff-only && npm install --omit=dev"
sudo systemctl restart yosupport-discount-bot
sudo systemctl status yosupport-discount-bot --no-pager
```

## 5. Что не трогаем, чтобы не сломать текущий проект

1. Не меняем конфиги nginx.
2. Не останавливаем существующие service/unit.
3. Не используем те же имена unit-файлов.
4. Не размещаем новый бот в папке существующего приложения.

Текущий бот изолирован:
- путь: `/opt/yosupport/app/discount-bot`
- unit: `yosupport-discount-bot.service`

## 6. Частые проблемы

`Permission denied (publickey)` при `git clone`/`git pull`:
- Deploy key не добавлен в репозиторий;
- либо команда запускается не от `yosupport`.

`BOT_TOKEN is required in .env`:
- `.env` не создан или пустой.

Бот не может проверить подписку:
- бот не админ в канале;
- неверный `CHANNEL_ID`.
