# Bot Configurator — Конфигуратор ботов

Встроенный агент для управления Telegram-ботами пользователя через инструмент `arckep-bot`.

## Возможности

- Просмотр списка ботов (`listMyBots`)
- Изменение модели бота (`setModel`)
- Настройка приветствия (`setGreeting`)
- Управление командами (`addCommand`, `removeCommand`, `listCommands`)
- Управление доступом и статусом бота

## Plugin

- **Идентификатор**: `arckep-bot`
- **Тенантность**: авторизация на стороне инструмента (server-side, через BetterAuth-сессию)

## Связанные файлы

- Определение агента: `packages/builtin-agents/src/agents/bot-configurator/`
- Инструмент: `packages/builtin-tool-arckep-bot/`
- Реестр: `packages/builtin-agents/src/index.ts`
