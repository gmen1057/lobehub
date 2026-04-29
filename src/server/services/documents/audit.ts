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

const getAuditUrl = () =>
  `${process.env.IMAGE_STUDIO_API_URL || 'http://127.0.0.1:8202'}/api/chat/tool-audits`;

const getInternalToken = () =>
  process.env.ARCKEP_INTERNAL_TOKEN || process.env.LOBECHAT_BACKEND_KEY;

// Backend (image-studio /api/chat/tool-audits) uses snake_case Pydantic schema.
// Translate camelCase TS payload to snake_case before posting.
export const auditDocumentToolCall = (payload: DocumentAuditPayload) => {
  const token = getInternalToken();
  if (!token) return;

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

  void fetch(getAuditUrl(), {
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
