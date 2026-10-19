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

## Решения

- Вопрос: самоход агента сайтов (Wave 4) — серверный CAO или клиентский follow-up?
- Взяли: клиентский хук после `sendMessage` → `internal_execAgentRuntime` (скрытое продолжение, не дубль user bubble). Судья — `gemini-2.5-flash-lite` через `fetchPresetTaskResult` (тот же billing proxy). Потолок 150 ₽ из `GET /chat/api/arckep/topic-spend`. Макс. 2 ремонта, потом AskUserQuestion.
- Отвергли: их CAO / Upstash / `agent_operations` / verify_* таблицы; новый write-path биллинга; RuntimeExecutors (Gemini 6-layer).
- Почему: флаг `SITES_AUTO_CONTINUE_ENABLED = false` + `chatConfig.enableSitesAutoContinue` на дефолтном помощнике выключен. Живое не трогаем, пока не перевернём константу.

## Известные особенности

- **Kling video** доступен через Qwen-провайдер (см. `packages/model-runtime/src/providers/qwen/createVideo.ts`). Отдельный custom runtime не нужен.
- **Codegraph**: slug = `lobechat` (не `lobechat-src`). Проект индексируется web+AST без Joern (см. `/opt/lobechat-src/.agents/codegraph.json`).
- **Сжатие длинного чата:** после первого сжатия порог поднимается до 65% окна (гистерезис, идеи upstream #18626). Иначе сжатый контекст сидит около 50% и каждый мелкий tool-result снова гоняет суммаризацию — жжёт токены и может зациклить. `/compact` и автосжатие не стартуют, пока уже идёт сжатие этого же топика. RuntimeExecutors.ts не трогаем: решение «сжимать или нет» в GeneralChatAgent.

## Решения

- Вопрос: после сжатия снова сжимать сразу, если всё ещё >50% окна?
- Взяли: гистерезис 50% → 65% (и явный `recompressionThresholdRatio`, если задан).
- Отвергли: вечный skip (длинный чат упрётся в лимит) и тот же порог 50% (петля суммаризаций).
- Почему: свежее сжатие почти всегда около нижнего порога; одна tool-выдача не должна запускать второй проход.

## Навыки в движке без интерфейса (ARCKEP_HEADLESS_TOOLS=1, 19.10.2026)

- **Список навыков** (`<available_skills>`): LobeHub и Task скрыты (`src/helpers/skillFilters.ts`), Artifacts и наши SEO-навыки (`seo-demand`, `content-articles`, `yandex-direct-guide`, `packages/builtin-skills`) остаются; описание в списке режется до ~200 знаков по границе слова, подвал называет `activateSkill` (lobe-activator).
- **Инструменты навыков** (`lobe-skills`: readReference, runCommand, execScript, exportFile) не в постоянной части запроса и не в `<available_tools>`. `activateSkill` подключает их, если у навыка есть справочники или скрипты (`state.activatedTools` → `activatedStepTools`, `serverRuntimes/skillTools.ts`). Манифест — `SkillsManifestHeadless`: без подтверждения человеком, `execScript` принимает `skill`.
- **Куда идут команды:** в песочницу E2B человека через шлюз коннекторов (`src/server/services/skillSandbox`, `execute_code` / `read_file`, заголовки `X-Arckep-User` + `X-Arckep-Topic`). Без номера человека в студии (`userNNN@arckep.ru`) песочница не работает. `exportFile` кладёт файл в хранилище (`files/skills/exports/<дата>/<тема>/…`), запись в `files` — владелец человек; модель получает `fileId` и строку `ARCKEP_FILE {json}`. Адрес `/f/<id>` людям недоступен (nginx не отдаёт его движку), экран берёт файл через `GET /files/<id>/url`.
- **«Мои навыки»:** инструмент `arckep-skills` (saveSkillFromText / FromUrl / FromFile) — по требованию через активатор; REST `/api/v1/skills` (GET список и карточка, POST из текста, POST /import по ссылке или fileId, DELETE). Один сервис `src/server/services/skill/userSkills.ts`. Ссылки только https через ssrf-safe-fetch, файл до 10 МБ, предел распаковки zip, не больше 100 навыков, помощник — не больше 10 сохранений в час, метка `savedVia` в шапке навыка.

## Решения

- Вопрос: имя навыка занято — ошибка или обновление?
- Взяли: ошибка CONFLICT с подсказкой; обновление только при явном `replace=true` и только для навыка, созданного из текста. Импортированные по ссылке заменить нельзя.
- Отвергли: тихая замена (помощник мог бы затереть навык человека) и «всегда ошибка» (правка своего навыка требовала бы удаления).
- Почему: помощник сохраняет без подтверждения (решение владельца 19.10), поэтому замена должна быть явным шагом.
- Вопрос: «выключенный» навык (вкл/выкл на экране)?
- Взяли: не делали — в `agent_skills` такого поля нет, PATCH не объявлен. Для вкл/выкл нужна колонка или настройка пользователя и фильтр в `execAgent` и `activateSkill`.

Подробности по AI-tooling, codegraph и общей карте проектов — в `/root/CLAUDE.md`.
