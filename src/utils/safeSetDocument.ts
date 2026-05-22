import { type IEditor } from '@lobehub/editor';

/**
 * Безопасно обновляет документ в Lexical Editor, предотвращая ошибку
 * "cannot be called during an update" (краш qn), если редактор уже находится
 * в цикле обновления.
 */
export const safeSetDocument = (
  editor: IEditor | undefined,
  type: 'json' | 'markdown' | 'text',
  content: string,
  options?: any,
) => {
  if (!editor) return;

  try {
    const lexicalEditor = editor.getLexicalEditor?.();
    if (lexicalEditor?.isUpdating?.()) {
      setTimeout(() => {
        try {
          editor.setDocument(type, content, options);
        } catch (err) {
          console.error('[safeSetDocument] Deferred setDocument failed:', err);
        }
      }, 0);
    } else {
      editor.setDocument(type, content, options);
    }
  } catch (err) {
    // Резервный вариант, если во время обычной проверки произошла ошибка
    console.warn('[safeSetDocument] Initial setDocument threw error, deferring update:', err);
    setTimeout(() => {
      try {
        editor.setDocument(type, content, options);
      } catch (innerErr) {
        console.error('[safeSetDocument] Fallback setDocument failed:', innerErr);
      }
    }, 0);
  }
};
