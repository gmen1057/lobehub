-- Посев прав RBAC для движка чата (план lobechat-engine-studio-chat, D16).
-- Таблицы rbac_* в базе форка пусты, а REST движка (packages/openapi) требует прав на каждый маршрут.
-- Роль arckep_owner = все действия над СВОИМИ данными (scope owner). Выдаётся всем пользователям
-- и новым пользователям служебного входа (packages/openapi/src/helpers/arckepServiceAuth.ts).
-- Идемпотентно: можно запускать повторно. Только добавления (D5).
BEGIN;
INSERT INTO rbac_roles (id, name, display_name, description, is_system, is_active)
VALUES ('arckep_owner', 'arckep_owner', 'Arckep: свои данные', 'Все действия над собственными данными (scope owner) — студия Arckep', true, true)
ON CONFLICT (id) DO NOTHING;
INSERT INTO rbac_permissions (id, code, name, description, category, is_active) VALUES
  ('agent:read:owner', 'agent:read:owner', 'AGENT_READ (owner)', 'Arckep seed: agent:read:owner', 'agent', true),
  ('agent:create:owner', 'agent:create:owner', 'AGENT_CREATE (owner)', 'Arckep seed: agent:create:owner', 'agent', true),
  ('agent:delete:owner', 'agent:delete:owner', 'AGENT_DELETE (owner)', 'Arckep seed: agent:delete:owner', 'agent', true),
  ('agent:fork:owner', 'agent:fork:owner', 'AGENT_FORK (owner)', 'Arckep seed: agent:fork:owner', 'agent', true),
  ('agent:update:owner', 'agent:update:owner', 'AGENT_UPDATE (owner)', 'Arckep seed: agent:update:owner', 'agent', true),
  ('ai_model:create:owner', 'ai_model:create:owner', 'AI_MODEL_CREATE (owner)', 'Arckep seed: ai_model:create:owner', 'ai_model', true),
  ('ai_model:delete:owner', 'ai_model:delete:owner', 'AI_MODEL_DELETE (owner)', 'Arckep seed: ai_model:delete:owner', 'ai_model', true),
  ('ai_model:read:owner', 'ai_model:read:owner', 'AI_MODEL_READ (owner)', 'Arckep seed: ai_model:read:owner', 'ai_model', true),
  ('ai_model:update:owner', 'ai_model:update:owner', 'AI_MODEL_UPDATE (owner)', 'Arckep seed: ai_model:update:owner', 'ai_model', true),
  ('ai_model:invoke:owner', 'ai_model:invoke:owner', 'AI_MODEL_INVOKE (owner)', 'Arckep seed: ai_model:invoke:owner', 'ai_model', true),
  ('ai_provider:create:owner', 'ai_provider:create:owner', 'AI_PROVIDER_CREATE (owner)', 'Arckep seed: ai_provider:create:owner', 'ai_provider', true),
  ('ai_provider:delete:owner', 'ai_provider:delete:owner', 'AI_PROVIDER_DELETE (owner)', 'Arckep seed: ai_provider:delete:owner', 'ai_provider', true),
  ('ai_provider:read:owner', 'ai_provider:read:owner', 'AI_PROVIDER_READ (owner)', 'Arckep seed: ai_provider:read:owner', 'ai_provider', true),
  ('ai_provider:update:owner', 'ai_provider:update:owner', 'AI_PROVIDER_UPDATE (owner)', 'Arckep seed: ai_provider:update:owner', 'ai_provider', true),
  ('api_key:create:owner', 'api_key:create:owner', 'API_KEY_CREATE (owner)', 'Arckep seed: api_key:create:owner', 'api_key', true),
  ('api_key:delete:owner', 'api_key:delete:owner', 'API_KEY_DELETE (owner)', 'Arckep seed: api_key:delete:owner', 'api_key', true),
  ('api_key:read:owner', 'api_key:read:owner', 'API_KEY_READ (owner)', 'Arckep seed: api_key:read:owner', 'api_key', true),
  ('api_key:update:owner', 'api_key:update:owner', 'API_KEY_UPDATE (owner)', 'Arckep seed: api_key:update:owner', 'api_key', true),
  ('document:create:owner', 'document:create:owner', 'DOCUMENT_CREATE (owner)', 'Arckep seed: document:create:owner', 'document', true),
  ('document:delete:owner', 'document:delete:owner', 'DOCUMENT_DELETE (owner)', 'Arckep seed: document:delete:owner', 'document', true),
  ('document:read:owner', 'document:read:owner', 'DOCUMENT_READ (owner)', 'Arckep seed: document:read:owner', 'document', true),
  ('document:update:owner', 'document:update:owner', 'DOCUMENT_UPDATE (owner)', 'Arckep seed: document:update:owner', 'document', true),
  ('file:delete:owner', 'file:delete:owner', 'FILE_DELETE (owner)', 'Arckep seed: file:delete:owner', 'file', true),
  ('file:read:owner', 'file:read:owner', 'FILE_READ (owner)', 'Arckep seed: file:read:owner', 'file', true),
  ('file:update:owner', 'file:update:owner', 'FILE_UPDATE (owner)', 'Arckep seed: file:update:owner', 'file', true),
  ('file:upload:owner', 'file:upload:owner', 'FILE_UPLOAD (owner)', 'Arckep seed: file:upload:owner', 'file', true),
  ('knowledge_base:create:owner', 'knowledge_base:create:owner', 'KNOWLEDGE_BASE_CREATE (owner)', 'Arckep seed: knowledge_base:create:owner', 'knowledge_base', true),
  ('knowledge_base:delete:owner', 'knowledge_base:delete:owner', 'KNOWLEDGE_BASE_DELETE (owner)', 'Arckep seed: knowledge_base:delete:owner', 'knowledge_base', true),
  ('knowledge_base:read:owner', 'knowledge_base:read:owner', 'KNOWLEDGE_BASE_READ (owner)', 'Arckep seed: knowledge_base:read:owner', 'knowledge_base', true),
  ('knowledge_base:update:owner', 'knowledge_base:update:owner', 'KNOWLEDGE_BASE_UPDATE (owner)', 'Arckep seed: knowledge_base:update:owner', 'knowledge_base', true),
  ('message:create:owner', 'message:create:owner', 'MESSAGE_CREATE (owner)', 'Arckep seed: message:create:owner', 'message', true),
  ('message:delete:owner', 'message:delete:owner', 'MESSAGE_DELETE (owner)', 'Arckep seed: message:delete:owner', 'message', true),
  ('message:read:owner', 'message:read:owner', 'MESSAGE_READ (owner)', 'Arckep seed: message:read:owner', 'message', true),
  ('message:update:owner', 'message:update:owner', 'MESSAGE_UPDATE (owner)', 'Arckep seed: message:update:owner', 'message', true),
  ('translation:create:owner', 'translation:create:owner', 'TRANSLATION_CREATE (owner)', 'Arckep seed: translation:create:owner', 'translation', true),
  ('translation:read:owner', 'translation:read:owner', 'TRANSLATION_READ (owner)', 'Arckep seed: translation:read:owner', 'translation', true),
  ('translation:delete:owner', 'translation:delete:owner', 'TRANSLATION_DELETE (owner)', 'Arckep seed: translation:delete:owner', 'translation', true),
  ('translation:update:owner', 'translation:update:owner', 'TRANSLATION_UPDATE (owner)', 'Arckep seed: translation:update:owner', 'translation', true),
  ('session:create:owner', 'session:create:owner', 'SESSION_CREATE (owner)', 'Arckep seed: session:create:owner', 'session', true),
  ('session:delete:owner', 'session:delete:owner', 'SESSION_DELETE (owner)', 'Arckep seed: session:delete:owner', 'session', true),
  ('session:read:owner', 'session:read:owner', 'SESSION_READ (owner)', 'Arckep seed: session:read:owner', 'session', true),
  ('session:update:owner', 'session:update:owner', 'SESSION_UPDATE (owner)', 'Arckep seed: session:update:owner', 'session', true),
  ('session_group:create:owner', 'session_group:create:owner', 'SESSION_GROUP_CREATE (owner)', 'Arckep seed: session_group:create:owner', 'session_group', true),
  ('session_group:delete:owner', 'session_group:delete:owner', 'SESSION_GROUP_DELETE (owner)', 'Arckep seed: session_group:delete:owner', 'session_group', true),
  ('session_group:read:owner', 'session_group:read:owner', 'SESSION_GROUP_READ (owner)', 'Arckep seed: session_group:read:owner', 'session_group', true),
  ('session_group:update:owner', 'session_group:update:owner', 'SESSION_GROUP_UPDATE (owner)', 'Arckep seed: session_group:update:owner', 'session_group', true),
  ('topic:create:owner', 'topic:create:owner', 'TOPIC_CREATE (owner)', 'Arckep seed: topic:create:owner', 'topic', true),
  ('topic:delete:owner', 'topic:delete:owner', 'TOPIC_DELETE (owner)', 'Arckep seed: topic:delete:owner', 'topic', true),
  ('topic:read:owner', 'topic:read:owner', 'TOPIC_READ (owner)', 'Arckep seed: topic:read:owner', 'topic', true),
  ('topic:update:owner', 'topic:update:owner', 'TOPIC_UPDATE (owner)', 'Arckep seed: topic:update:owner', 'topic', true),
  ('user:read:owner', 'user:read:owner', 'USER_READ (owner)', 'Arckep seed: user:read:owner', 'user', true),
  ('user:update:owner', 'user:update:owner', 'USER_UPDATE (owner)', 'Arckep seed: user:update:owner', 'user', true)
ON CONFLICT (id) DO NOTHING;
INSERT INTO rbac_role_permissions (role_id, permission_id)
SELECT 'arckep_owner', p.id FROM rbac_permissions p WHERE p.code LIKE '%:owner'
ON CONFLICT DO NOTHING;
INSERT INTO rbac_user_roles (user_id, role_id)
SELECT u.id, 'arckep_owner' FROM users u
ON CONFLICT DO NOTHING;
COMMIT;
