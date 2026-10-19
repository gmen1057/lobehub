/**
 * arckep (19.10.2026): есть ли у модели зрение — та же проверка, что при вызове модели (RuntimeExecutors,
 * isCanUseVision): встроенный список моделей, неизвестная модель — со зрением.
 */
export const modelHasVision = async (model: string, provider: string): Promise<boolean> => {
  const { LOBE_DEFAULT_MODEL_LIST } = await import('model-bank');
  const info = LOBE_DEFAULT_MODEL_LIST.find(
    (item) => item.id === model && item.providerId === provider,
  );
  return info?.abilities?.vision ?? true;
};
