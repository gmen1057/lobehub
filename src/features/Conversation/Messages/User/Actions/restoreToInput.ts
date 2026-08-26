import { message as antdMessage } from 'antd';

import type { ChatInputEditor } from '@/features/ChatInput';
import { cleanSpeakerTag } from '@/store/chat/utils/cleanSpeakerTag';
import { unescapeMarkdown } from '@/store/chat/utils/unescapeMarkdown';
import { useFileStore } from '@/store/file';
import type { UploadFileItem } from '@/types/files/upload';
import type { UIChatMessage } from '@/types/index';

import { useConversationStore } from '../../../store';

const fromMedia = (
  list: { alt: string; id: string; url: string }[] | undefined,
  typePrefix: string,
): UploadFileItem[] =>
  (list ?? []).map((item) => ({
    file: { name: item.alt || item.id, size: 0, type: `${typePrefix}/*` } as File,
    fileUrl: item.url,
    id: item.id,
    previewUrl: item.url,
    skipRemoveFile: true,
    status: 'success' as const,
  }));

/** Restore a sent user message (text + attachments) into the composer. */
export const restoreUserMessageToInput = (data: UIChatMessage, successLabel: string) => {
  const editor = useConversationStore.getState().editor as ChatInputEditor | null;
  if (!editor) return;

  const markdown = unescapeMarkdown(cleanSpeakerTag(data.content ?? ''));
  const editorData = data.editorData;
  const hasEditorData =
    editorData && typeof editorData === 'object' && Object.keys(editorData).length > 0;

  try {
    if (hasEditorData) {
      editor.setJSONState(editorData);
    } else {
      editor.setDocument('markdown', markdown);
    }
  } catch {
    editor.setDocument('markdown', markdown);
  }

  useConversationStore.getState().updateInputMessage(markdown);

  const restored: UploadFileItem[] = [
    ...fromMedia(data.imageList, 'image'),
    ...fromMedia(data.videoList, 'video'),
    ...(data.fileList ?? []).map((f) => ({
      file: { name: f.name, size: f.size, type: f.fileType } as File,
      fileUrl: f.url,
      id: f.id,
      previewUrl: f.url,
      skipRemoveFile: true,
      status: 'success' as const,
    })),
  ];

  const fileStore = useFileStore.getState();
  fileStore.clearChatUploadFileList();
  if (restored.length > 0) {
    fileStore.dispatchChatUploadFileList({ files: restored, type: 'addFiles' });
  }

  editor.focus();
  antdMessage.success(successLabel);
};
