#!/usr/bin/env bash
# Шаги после слияния PR #617 (план lobechat-engine-studio-chat, Phase 3): живая папка → main,
# включить три настройки движка в backend/.env, выложить студию, проверить /chat-next браузером.
# Запуск: bash /var/tmp/wt/lobechat-engine/scripts/arckep/post-merge-phase3.sh
set -euo pipefail

cd /opt/image-studio
git fetch -q origin
if ! git merge-base --is-ancestor "$(git rev-parse origin/claude/lobechat-engine-studio)" origin/main; then
    echo "PR #617 ещё не слит в main — остановка." >&2
    exit 1
fi
git pull --ff-only origin main

# Три строки добавлены 16.10 и закомментированы другим агентом, пока код бэкенда их не знал.
sed -i -e 's/^#LOBECHAT_ENGINE_URL=/LOBECHAT_ENGINE_URL=/' \
       -e 's/^#LOBECHAT_ENGINE_SERVICE_KEY=/LOBECHAT_ENGINE_SERVICE_KEY=/' \
       -e 's/^#CHAT_NEXT_USER_IDS=/CHAT_NEXT_USER_IDS=/' backend/.env
grep -c '^LOBECHAT_ENGINE_URL=\|^LOBECHAT_ENGINE_SERVICE_KEY=\|^CHAT_NEXT_USER_IDS=' backend/.env | grep -qx 3

./deploy.sh all

sleep 5
curl -s -o /dev/null -w 'live /chat-next -> %{http_code}\n' https://arckep.ru/chat-next
curl -s -o /dev/null -w 'live /chat -> %{http_code}\n' https://arckep.ru/chat
cd /var/tmp/pw-v4 && node chat-next-check.mjs
