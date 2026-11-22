interface CompactTopicRegistryGlobal {
  __arckepActiveTopicCompactions?: Set<string>;
}

const globalForCompactRegistry = globalThis as unknown as CompactTopicRegistryGlobal;

export const getActiveTopicCompactions = (): Set<string> => {
  if (!globalForCompactRegistry.__arckepActiveTopicCompactions) {
    globalForCompactRegistry.__arckepActiveTopicCompactions = new Set<string>();
  }
  return globalForCompactRegistry.__arckepActiveTopicCompactions;
};

export const resetInFlightTopicCompactionsForTests = (): void => {
  getActiveTopicCompactions().clear();
};

export const hasInFlightTopicCompaction = (userId: string, topicId: string): boolean => {
  if (!userId || !topicId) return false;
  return getActiveTopicCompactions().has(`${userId}:${topicId}`);
};

export const hasInFlightTopicCompactionsForUser = (userId: string): boolean => {
  if (!userId) return false;
  const prefix = `${userId}:`;
  for (const key of getActiveTopicCompactions()) {
    if (key.startsWith(prefix)) return true;
  }
  return false;
};
