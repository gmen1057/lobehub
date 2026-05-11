# LobeChat — arckep fork operational notes

Дополнение к `CLAUDE.md` (upstream LobeHub guide). Здесь только то, что специфично для нашего форка `chat.arckep.ru`. **Не сливать с upstream `CLAUDE.md`** — этот файл живёт отдельно, чтобы не ловить конфликты при merge.

## Деплой prod (chat.arckep.ru)

| | |
|---|---|
| URL | https://chat.arckep.ru |
| Source | `/opt/lobechat-src/` |
| Prod (standalone) | `/opt/lobechat/` |
| Service | `image-studio-lobechat.service` (порт 3402) |
| Логи | `/var/log/image-studio-lobechat.log` |

### Билд + деплой

```bash
cd /opt/lobechat-src && NEXT_BUILD_STANDALONE=1 bun run build
systemctl stop image-studio-lobechat
rsync -a --delete /opt/lobechat-src/.next/standalone/ /opt/lobechat/ --exclude=.env
rsync -a /opt/lobechat-src/.next/static/ /opt/lobechat/.next/static/
rsync -a /opt/lobechat-src/public/ /opt/lobechat/public/
systemctl start image-studio-lobechat
```

`--exclude=.env` критичен: prod-конфиг (`/opt/lobechat/.env`) не должен затираться сборочной копией.

## Arckep-специфичные модификации (за пределами upstream)

- **Auth**: бесшовная через cookie `.arckep.ru` + bridge с Image Studio. См. `arckep_token` в коде.
- **Биллинг**: в рублях, через FastAPI endpoint Image Studio backend
- **Брендинг**: LobeHub полностью заменён на Image Studio
- **Язык**: русский по умолчанию (cookie `LOBE_LOCALE`)
- **Stats**: ₽ вместо $
- **Models**: chat через Inworld Router (15 моделей + 4 Gemini image)
- **Безопасность**: hard-disable browser `fetchOnClient` для billed providers (revenue leak protection)

## Известные особенности

- **Kling video** доступен через Qwen-провайдер (см. `packages/model-runtime/src/providers/qwen/createVideo.ts`). Отдельный custom runtime не нужен.
- **Codegraph**: проект ингещён, web+AST без Joern (см. `/opt/lobechat-src/.agents/codegraph.json`).

Подробности по AI-tooling, codegraph и общей карте проектов — в `/root/CLAUDE.md`.
