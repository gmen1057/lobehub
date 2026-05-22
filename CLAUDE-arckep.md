# LobeChat — arckep fork operational notes

Дополнение к `CLAUDE.md` (upstream LobeHub guide). Здесь только то, что специфично для нашего форка `chat.arckep.ru`. **Не сливать с upstream `CLAUDE.md`** — этот файл живёт отдельно, чтобы не ловить конфликты при merge.

## Деплой prod (chat.arckep.ru)

|                   |                                             |
| ----------------- | ------------------------------------------- |
| URL               | <https://chat.arckep.ru>                    |
| Source            | `/opt/lobechat-src/`                        |
| Prod (standalone) | `/opt/lobechat/`                            |
| Service           | `image-studio-lobechat.service` (порт 3402) |
| Логи              | `/var/log/image-studio-lobechat.log`        |

### Билд + деплой

```bash
cd /opt/lobechat-src
bun run build # vite SPA + next Turbopack, ~6–9 min

# Оба rsync критичны. Забыть любой = 404 на чанках или SSR с stale-ссылками
rsync -a --delete /opt/lobechat-src/.next/ /opt/lobechat/.next/
rsync -a --delete /opt/lobechat-src/public/_spa/ /opt/lobechat/public/_spa/

systemctl restart image-studio-lobechat
```

**Почему именно так:**

- `.next/` целиком — не только `standalone/`. Next.js standalone в новых версиях кладёт SSR-шаблоны в `.next/server/app/spa/...body`, которые runtime-генерируют HTML со ссылками на JS-чанки. Старые `*.body` → браузер получает 404 на `_spa/assets/index-XXX.js`.
- `public/_spa/` — Vite SPA assets (`assets/index-*.js`, `index.html`). Старые чанки здесь → браузер грузит stale bundle без фиксов.
- `.env` в `/opt/lobechat/` не трогаем (он не входит в `.next/` и `public/_spa/`).

**Проверка после деплоя:**

```bash
cat /opt/lobechat/.next/BUILD_ID # должен совпадать с src
curl -sS -o /dev/null -w "%{http_code}" https://chat.arckep.ru/_spa/assets/$(ls /opt/lobechat/public/_spa/assets/index-*.js | head -1 | xargs basename)
# должен быть 200, не 404
```

## Arckep-специфичные модификации (за пределами upstream)

- **Auth**: бесшовная через cookie `.arckep.ru` + bridge с Image Studio. См. `arckep_token` в коде.
- **Биллинг**: в рублях, через FastAPI endpoint Image Studio backend
- **Брендинг**: LobeHub полностью заменён на Image Studio
- **Язык**: русский по умолчанию (cookie `LOBE_LOCALE`)
- **Stats**: ₽ вместо $
- **Models**: chat через Inworld Router (15 моделей + 4 Gemini image)
- **Безопасность**: hard-disable browser `fetchOnClient` для billed providers (revenue leak protection)

## Известные ошибки и нюансы (инциденты)

| Дата       | Что случилось                                                                                  | Причина                                                                                                  | Фикс                                                                                          |
| ---------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 2026-05-11 | 404 на `_spa/assets/index-*.js`, Render Error `URL@[native code]`                              | Забыт `rsync public/_spa/` + rsync `.next/` не обновил `.next/server/` (SSR body ссылки на старые чанки) | Двойной rsync: `.next/` целиком + `public/_spa/`                                              |
| 2026-05-11 | systemd SIGKILL при restart                                                                    | Next.js standalone не умирает за 90s на SIGTERM                                                          | Норма; restart ждёт timeout, потом KILL                                                       |
| 2026-05-11 | `--no-verify` в коммите                                                                        | Pre-commit hooks (eslint+prettier) таймаутились на 5 файлах                                              | Не обходить hooks; если таймаут — увеличить patience или фиксить конфиг                       |
| 2026-05-22 | Все Opus 4.6/4.7 запросы возвращали 400 `tools: Tool names must be unique.` — чат «не отвечал» | `enabledSearch` добавлял встроенный `web_search` поверх плагина с тем же именем → дубликат в payload     | Дедуп `postTools` по `name` после слияния search-tool в `anthropicCompatibleFactory/index.ts` |

## Известные особенности

- **Kling video** доступен через Qwen-провайдер (см. `packages/model-runtime/src/providers/qwen/createVideo.ts`). Отдельный custom runtime не нужен.
- **Codegraph**: slug = `lobechat` (не `lobechat-src`). Проект индексируется web+AST без Joern (см. `/opt/lobechat-src/.agents/codegraph.json`).

Подробности по AI-tooling, codegraph и общей карте проектов — в `/root/CLAUDE.md`.
