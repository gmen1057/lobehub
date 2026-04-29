interface DocumentAuditPayload {
  contentSha256?: string;
  fileId?: string;
  filename?: string;
  format: string;
  messageId?: string;
  mimeType?: string;
  s3Key?: string;
  size?: number;
  status: 'failed' | 'success';
  toolCallId?: string;
  topicId?: null | string;
  userId: string;
}

// Allowlist for the audit endpoint host. Only loopback (this host) is permitted —
// guards against env-var compromise that would otherwise leak the internal token to
// an arbitrary external service.
const AUDIT_HOST_ALLOWLIST = new Set(['127.0.0.1', 'localhost']);

const getAuditUrl = (): string | null => {
  const base = process.env.IMAGE_STUDIO_API_URL || 'http://127.0.0.1:8202';
  try {
    const url = new URL(base);
    if (!AUDIT_HOST_ALLOWLIST.has(url.hostname)) {
      console.error(
        '[documents:audit] IMAGE_STUDIO_API_URL host not in allowlist; refusing to send token:',
        url.hostname,
      );
      return null;
    }
    return `${base.replace(/\/$/, '')}/api/chat/tool-audits`;
  } catch (error) {
    console.error('[documents:audit] Invalid IMAGE_STUDIO_API_URL:', error);
    return null;
  }
};

const getInternalToken = () =>
  process.env.ARCKEP_INTERNAL_TOKEN || process.env.LOBECHAT_BACKEND_KEY;

// Backend (image-studio /api/chat/tool-audits) uses snake_case Pydantic schema.
// Translate camelCase TS payload to snake_case before posting.
export const auditDocumentToolCall = (payload: DocumentAuditPayload) => {
  const token = getInternalToken();
  if (!token) return;

  const url = getAuditUrl();
  if (!url) return;

  const body = {
    api_name: 'generateDocument',
    content_sha256: payload.contentSha256,
    format: payload.format,
    message_id: payload.messageId,
    request_metadata: {
      file_id: payload.fileId,
      filename: payload.filename,
      mime_type: payload.mimeType,
      status: payload.status,
    },
    s3_key: payload.s3Key,
    size_bytes: payload.size ?? 0,
    tool_call_id: payload.toolCallId,
    tool_id: 'lobe-documents',
    topic_id: payload.topicId,
    user_id: Number(payload.userId),
  };

  void fetch(url, {
    body: JSON.stringify(body),
    headers: {
      'Content-Type': 'application/json',
      'X-Arckep-Token': token,
    },
    method: 'POST',
  }).catch((error) => {
    console.error('[documents:audit] Failed to post tool audit:', error);
  });
};
