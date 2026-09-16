# LC: автоматическое управление контекстом — ревью

Owner: codex
Branch: codex/fix-context-quality
Worktree: /var/tmp/wt/lc-context-quality
Base: 1d2ca12a01
Rollout: пользователь разрешил commit/push и deployment 2026-09-16. Выполняется подготовка релиза; ниже сохранены результаты дорелизного ревью.

## Что изменено

- Все типы текстовых вложений, включая VCF: предварительный просмотр до 8 000 символов на файл и 32 000 символов текста вложений на историю. Приоритет у свежих загрузок. Текст запроса пользователя не обрезается. Файлы знаний агента имеют отдельный общий бюджет 32 000 символов; метаданные и инструкции добавляются сверх этих лимитов.
- Оригиналы сохраняются. readKnowledge читает до 20 000 символов исходного текста за вызов (бюджет делится между максимум 8 файлами), возвращает точные UTF-16 startOffset/endOffset/nextOffset/totalCharCount. Есть буквальный поиск без embeddings; нет совпадения не означает отсутствия смысла.
- Поиск по embeddings при ошибке возвращает модели инструкцию перейти к прямому чтению. Инструменты доступны автоматически для моделей с function calling, без настройки базы знаний пользователем.
- Единые серверные сервисы для клиентских и фоновых инструментов. Добавлена отсутствовавшая серверная регистрация knowledge-base. Чтение файлов/тем проверяет владельца; векторный поиск получает только принадлежащие пользователю fileIds.
- Модель получает правила: для полного сравнения или подсчёта обработать оригинал целиком доступным кодом либо прочитать все страницы с учётом покрытия; не выдавать выборку за весь документ и не перекладывать чтение на пользователя.
- Сжатие сохраняет задачи, ограничения, числа, исключения, источники и незавершённые вопросы. Идентификаторы оригинальных файлов добавляются детерминированно, независимо от качества резюме.
- getTopicContext(mode="archive") позволяет перечитать оригинальные тексты переписки, в том числе скрытые сжатием; режим summary сохраняет совместимость прежнего API. Продолжение передаёт snapshotAt из первой страницы: новые tool results не должны попадать в читаемый снимок.
- Клиентское автосжатие оставляет последние два пользовательских хода и связанные tool-call/result сообщения. Ручной /compact не менялся. Фоновый runtime сохраняет прежнюю границу сжатия.
- Перед отправкой из браузерного runtime оценивается уже собранный текстовый prompt с описаниями инструментов. При превышении 50% от min(окно модели, 128 000) запускается сжатие старой истории; неоплаченный placeholder переиспользуется. Есть защита от повторения той же попытки сжатия.
- Страницы оригиналов не подвергаются повторному общему усечению результата инструмента: иначе nextOffset пропускал бы не показанный модели текст.

Skill lobechat-pipeline использован для проверки обеих веток исполнения инструментов и отделения рабочей копии от deployment.

## Проверки

- Пакетные регрессии: 24 файла, 211 тестов (большой VCF, поиск в конце, полное последовательное восстановление, Unicode, бюджеты, ссылки после сжатия, подсчёт токенов).
- Регрессии приложения: 10 файлов, 213 тестов (клиентский preflight/переиспользование placeholder, server runtime, автоматическая доступность инструментов, ограничения доступа, архив/снимок, сохранение страниц).
- Итого 424 теста. Логи: /var/tmp/lc-context-tests-packages.log и /var/tmp/lc-context-tests-root.log. После последней типовой правки тестовой фикстуры дополнительно повторены 4 теста ExecutionRuntime: PASS (/var/tmp/lc-context-tests-last.log).
- TypeScript: полный tsgo НЕ зелёный и до правки. Baseline 557 диагностик, рабочая копия 555. Новых пар файл/код диагностики нет; две ошибки прежнего chunk.ts исчезли после переноса запросов. Основной фон — несколько идентичностей drizzle-orm в установленных зависимостях. Логи: /var/tmp/lc-context-types-baseline.txt и /var/tmp/lc-context-types-final.txt.
- ESLint по всем изменённым TS/TSX: PASS; git diff --check: PASS. Лог /var/tmp/lc-context-lint-final.log пуст, exit 0.
- Сборочный smoke: обе SPA и Next скомпилированы. Процесс остановлен SIGTERM на генерации статических страниц (последний подтверждённый прогресс 1177/3149); полной успешной сборки НЕТ. Важно: последняя правка snapshotAt внесена после старта этой сборки. Это не воспроизводимая release-сборка окончательного diff; после заморозки исходников и разрешения на публикацию требуется новая полная сборка с утверждённой конфигурацией. Лог: /var/tmp/lc-context-build-final.log.
- Первая изолированная сборка: обе SPA собраны, Next скомпилирован; сбор данных страниц остановился из-за отсутствия KEY\_VAULTS\_SECRET. Повторная сборка использует исключительно фиктивный ключ и DATABASE\_URL на закрытом локальном порту 1. Артефакты этой сборки НЕ предназначены для production.
- Codegraph MCP недоступен в сессии: связи проверены вручную, автоматической graph-validation нет.
- На этапе реализации платные запросы к живым моделям и production E2E не запускались. GitHub CI тогда не запускался: push ещё не был разрешён.

## Границы и оставшиеся риски

- Это управление рабочим контекстом, а не доказательство безошибочности ответа LLM. Соблюдение полного покрытия предписано модели, но отдельный автоматический проверяющий достоверность не реализован.
- Дословное сравнение/подсчёт большого массива может потребовать много чтений и стоить денег. Новый специализированный парсер VCF/аналитический движок здесь не добавлен; используется существующий доступный кодовый инструмент или постраничное чтение.
- Страницы ограничены на границе model context. Внутренний getFileContents пока загружает оригинал целиком; это не оптимизация передачи файла между сервером и браузером.
- Оценка токенов приблизительная и текстовая, не расчёт provider billing и не точный учёт изображений.
- Проверка собранного prompt добавлена в браузерный runtime. Общие ограничения вложений/чтение применяются и к серверному runtime, но аналогичный final-prompt preflight на сервере не добавлен.
- Нет жёсткого лимита цены: если нечего сжимать, сжатие отключено или та же попытка уже сделана, запрос может пройти дальше. Резервирование баланса на всю цепочку, атомарное завершение/возврат многошаговой операции и страховка от овердрафта требуют отдельной правки биллинга.
- Без function calling модель не сможет дочитать оригинал инструментом. Для таких моделей нужны отдельная стратегия серверного извлечения/UX; Astra и исследованный сценарий используют инструменты.

## Перед публикацией

Явное разрешение владельца на commit/push/merge и deployment получено. /opt/lobechat-src остаётся на arckep/v2.1.46; /opt/image-studio — main, с сохранением существующих посторонних untracked-файлов. Пересобрать с реальными настройками в утверждённом workflow, выполнить обе rsync (.next и public/\_spa), перезапуск и smoke. Проверить BUILD\_ID. Отдельный платный end-to-end сценарий — только с согласованным тестовым бюджетом, не за счёт пользователя leo-n.

## Полный список файлов

- `CONTEXT_QUALITY_PLAN.md`
- `CONTEXT_QUALITY_REVIEW.md`
- `packages/agent-runtime/package.json`
- `packages/agent-runtime/src/utils/compression.ts`
- `packages/agent-runtime/src/utils/index.ts`
- `packages/agent-runtime/src/utils/tokenCounter.test.ts`
- `packages/agent-runtime/src/utils/tokenCounter.ts`
- `packages/builtin-tool-knowledge-base/src/ExecutionRuntime/index.test.ts`
- `packages/builtin-tool-knowledge-base/src/ExecutionRuntime/index.ts`
- `packages/builtin-tool-knowledge-base/src/executor/index.ts`
- `packages/builtin-tool-knowledge-base/src/manifest.ts`
- `packages/builtin-tool-knowledge-base/src/systemRole.ts`
- `packages/builtin-tool-knowledge-base/src/types.ts`
- `packages/builtin-tool-topic-reference/src/executor/index.ts`
- `packages/builtin-tool-topic-reference/src/manifest.ts`
- `packages/context-engine/src/processors/CompressedGroupRoleTransform.ts`
- `packages/context-engine/src/processors/MessageContent.ts`
- `packages/context-engine/src/processors/__tests__/FileContextBudget.test.ts`
- `packages/prompts/src/chains/compressContext.ts`
- `packages/prompts/src/prompts/compressContext/index.ts`
- `packages/prompts/src/prompts/files/context.test.ts`
- `packages/prompts/src/prompts/files/context.ts`
- `packages/prompts/src/prompts/files/file.ts`
- `packages/prompts/src/prompts/files/index.test.ts`
- `packages/prompts/src/prompts/files/index.ts`
- `packages/prompts/src/prompts/files/knowledgeBase.ts`
- `packages/prompts/src/prompts/knowledgeBaseQA/formatFileContents.ts`
- `packages/prompts/src/prompts/knowledgeBaseQA/formatSearchResults.ts`
- `pnpm-lock.yaml`
- `src/helpers/toolEngineering/index.ts`
- `src/server/modules/Mecha/AgentToolsEngine/__tests__/index.test.ts`
- `src/server/modules/Mecha/AgentToolsEngine/index.ts`
- `src/server/routers/lambda/chunk.ts`
- `src/server/routers/lambda/topic.ts`
- `src/server/services/knowledgeRetrieval/index.test.ts`
- `src/server/services/knowledgeRetrieval/index.ts`
- `src/server/services/toolExecution/__tests__/sourcePages.test.ts`
- `src/server/services/toolExecution/index.ts`
- `src/server/services/toolExecution/serverRuntimes/index.ts`
- `src/server/services/toolExecution/serverRuntimes/knowledgeBase.ts`
- `src/server/services/toolExecution/serverRuntimes/topicReference.ts`
- `src/server/services/topicContext/index.test.ts`
- `src/server/services/topicContext/index.ts`
- `src/services/chat/chat.test.ts`
- `src/services/chat/index.ts`
- `src/services/chat/types.ts`
- `src/store/chat/agents/__tests__/createAgentExecutors/call-llm.test.ts`
- `src/store/chat/agents/__tests__/createAgentExecutors/compress-context.test.ts`
- `src/store/chat/agents/createAgentExecutors.ts`
- `src/store/chat/utils/compression.test.ts`
- `src/store/chat/utils/compression.ts`
- `src/store/tool/slices/builtin/executors/lobe-topic-reference.ts`
