import { appEnv } from '@/envs/app';

/** Адрес файла человека для модели и HTML-предпросмотра (nginx отдаёт /chat/f/ движку: 302 в хранилище). */
export const fileAddress = (fileId: string) => `${appEnv.APP_URL}/f/${fileId}/`;
