import { type ChatContextContent } from '@lobechat/types';
import { convertSvgFileToPng } from '@lobechat/utils/client/svgToPng';
import { COMPRESSIBLE_IMAGE_TYPES, compressImageFile } from '@lobechat/utils/compressImage';
import {
  isLargeSvg,
  isSvgFileName,
  isSvgMime,
  SVG_CODE_SOFT_CAP_BYTES,
  SVG_LARGE_THRESHOLD_BYTES,
} from '@lobechat/utils/isVisionImage';
import { Modal } from 'antd';
import { t } from 'i18next';

import { notification } from '@/components/AntdStaticMethods';
import { FILE_UPLOAD_BLACKLIST } from '@/const/file';
import { fileService } from '@/services/file';
import { ragService } from '@/services/rag';
import { UPLOAD_NETWORK_ERROR } from '@/services/upload';
import { type UploadFileListDispatch } from '@/store/file/reducers/uploadFileList';
import { uploadFileListReducer } from '@/store/file/reducers/uploadFileList';
import { type StoreSetter } from '@/store/types';
import { type FileListItem } from '@/types/files';
import { type UploadFileItem } from '@/types/files/upload';
import { isChunkingUnsupported } from '@/utils/isChunkingUnsupported';
import { sleep } from '@/utils/sleep';
import { setNamespace } from '@/utils/storeDebug';

import { type FileStore } from '../../store';

const n = setNamespace('chat');

type Setter = StoreSetter<FileStore>;
export const createFileSlice = (set: Setter, get: () => FileStore, _api?: unknown) =>
  new FileActionImpl(set, get, _api);

export class FileActionImpl {
  readonly #get: () => FileStore;
  readonly #set: Setter;

  constructor(set: Setter, get: () => FileStore, _api?: unknown) {
    void _api;
    this.#set = set;
    this.#get = get;
  }

  addChatContextSelection = (context: ChatContextContent): void => {
    const current = this.#get().chatContextSelections;
    const next = [context, ...current.filter((item) => item.id !== context.id)];

    this.#set({ chatContextSelections: next }, false, n('addChatContextSelection'));
  };

  clearChatContextSelections = (): void => {
    this.#set({ chatContextSelections: [] }, false, n('clearChatContextSelections'));
  };

  clearChatUploadFileList = (): void => {
    this.#set({ chatUploadFileList: [] }, false, n('clearChatUploadFileList'));
  };

  dispatchChatUploadFileList = (payload: UploadFileListDispatch): void => {
    const nextValue = uploadFileListReducer(this.#get().chatUploadFileList, payload);
    if (nextValue === this.#get().chatUploadFileList) return;

    this.#set({ chatUploadFileList: nextValue }, false, `dispatchChatFileList/${payload.type}`);
  };

  removeChatContextSelection = (id: string): void => {
    const next = this.#get().chatContextSelections.filter((item) => item.id !== id);
    this.#set({ chatContextSelections: next }, false, n('removeChatContextSelection'));
  };

  removeChatUploadFile = async (id: string): Promise<void> => {
    const { dispatchChatUploadFileList } = this.#get();

    dispatchChatUploadFileList({ id, type: 'removeFile' });
    await fileService.removeFile(id);
  };

  startAsyncTask = async (
    id: string,
    runner: (id: string) => Promise<string>,
    onFileItemUpdate: (fileItem: FileListItem) => void,
  ): Promise<void> => {
    await runner(id);

    let isFinished = false;

    while (!isFinished) {
      // Poll task status every 2 seconds
      await sleep(2000);

      let fileItem: FileListItem | undefined;

      try {
        const result = await fileService.getKnowledgeItem(id);
        fileItem = result ?? undefined;
      } catch (e) {
        console.error('getFileItem Error:', e);
        continue;
      }

      if (!fileItem) return;

      onFileItemUpdate(fileItem);

      if (fileItem.finishEmbedding) {
        isFinished = true;
      }

      // if error, also break
      else if (fileItem.chunkingStatus === 'error' || fileItem.embeddingStatus === 'error') {
        isFinished = true;
      }
    }
  };

  /**
   * Large SVG: ask whether to rasterize to PNG (vision) or keep full SVG source as code.
   * Small SVG: always keep as code (providers reject SVG in vision image_url).
   */
  #maybeConvertLargeSvg = async (file: File): Promise<File> => {
    const isSvg = isSvgMime(file.type) || isSvgFileName(file.name);
    if (!isSvg || !isLargeSvg(file.size)) return file;

    const sizeKb = Math.round(file.size / 1024);
    const thresholdKb = Math.round(SVG_LARGE_THRESHOLD_BYTES / 1024);

    const convertToPng = await new Promise<boolean>((resolve) => {
      Modal.confirm({
        title: 'Большой SVG',
        content: `Файл «${file.name}» (${sizeKb} КБ) больше ${thresholdKb} КБ. Модели не принимают SVG как картинку. Конвертировать в PNG (удобно «увидеть» логотип) или отправить полный исходный код SVG в запрос?`,
        okText: 'Конвертировать в PNG',
        cancelText: 'Полный SVG (код)',
        centered: true,
        onOk: () => resolve(true),
        onCancel: () => resolve(false),
      });
    });

    if (!convertToPng) {
      if (file.size > SVG_CODE_SOFT_CAP_BYTES) {
        notification.info({
          message: 'SVG как код',
          description: `Файл большой (${sizeKb} КБ) — в запрос уйдёт полный исходник. Это может увеличить расход токенов.`,
          duration: 6,
        });
      }
      return file;
    }

    try {
      const png = await convertSvgFileToPng(file);
      notification.success({
        message: 'SVG → PNG',
        description: `«${file.name}» конвертирован в PNG для vision.`,
        duration: 4,
      });
      return png;
    } catch (e) {
      console.error('SVG→PNG conversion failed', e);
      notification.warning({
        message: 'Не удалось конвертировать SVG',
        description: 'Отправляем полный SVG как код.',
        duration: 5,
      });
      return file;
    }
  };

  uploadChatFiles = async (rawFiles: File[]): Promise<void> => {
    const { dispatchChatUploadFileList } = this.#get();
    // 0. skip file in blacklist
    const filteredFiles = rawFiles.filter((file) => !FILE_UPLOAD_BLACKLIST.includes(file.name));

    // 0.5 large SVG → offer PNG conversion (vision) vs full source as code
    const afterSvgChoice: File[] = [];
    for (const file of filteredFiles) {
      afterSvgChoice.push(await this.#maybeConvertLargeSvg(file));
    }

    // 1. compress images and add files with base64
    const files = await Promise.all(
      afterSvgChoice.map((file) =>
        COMPRESSIBLE_IMAGE_TYPES.has(file.type) ? compressImageFile(file) : file,
      ),
    );

    const uploadFiles: UploadFileItem[] = await Promise.all(
      files.map(async (file) => {
        let previewUrl: string | undefined = undefined;
        let base64Url: string | undefined = undefined;

        // only image and video can be previewed, we create a previewUrl and base64Url for them
        if (file.type.startsWith('image') || file.type.startsWith('video')) {
          const data = await file.arrayBuffer();

          previewUrl = URL.createObjectURL(new Blob([data!], { type: file.type }));

          const base64 = Buffer.from(data!).toString('base64');
          base64Url = `data:${file.type};base64,${base64}`;
        }

        return { base64Url, file, id: file.name, previewUrl, status: 'pending' } as UploadFileItem;
      }),
    );

    dispatchChatUploadFileList({ files: uploadFiles, type: 'addFiles' });

    // upload files and process it
    const pools = files.map(async (file) => {
      let fileResult: { id: string; url: string } | undefined;

      try {
        fileResult = await this.#get().uploadWithProgress({
          file,
          onStatusUpdate: dispatchChatUploadFileList,
        });
      } catch (error) {
        // skip `UNAUTHORIZED` error
        if ((error as any)?.message !== 'UNAUTHORIZED')
          notification.error({
            description:
              // it may be a network error or the cors error
              error === UPLOAD_NETWORK_ERROR
                ? t('upload.networkError', { ns: 'error' })
                : // or the error from the server
                  typeof error === 'string'
                  ? error
                  : t('upload.unknownError', { ns: 'error', reason: (error as Error).message }),
            message: t('upload.uploadFailed', { ns: 'error' }),
          });

        dispatchChatUploadFileList({ id: file.name, type: 'removeFile' });
      }

      if (!fileResult) return;

      // image don't need to be chunked and embedding
      if (isChunkingUnsupported(file.type)) return;

      await ragService.parseFileContent(fileResult.id);
    });

    await Promise.all(pools);
  };
}

export type FileAction = Pick<FileActionImpl, keyof FileActionImpl>;
