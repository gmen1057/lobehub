interface ToolDeferralOptions {
  candidates: string[];
  configuredToolIds: string[];
  hiddenToolIds: string[];
  isManualMode: boolean;
  pickedToolIds: ReadonlySet<string>;
}

/** Keep selected tools usable when manual mode removes the tool activator. */
export const getDeferredToolIds = ({
  candidates,
  configuredToolIds,
  hiddenToolIds,
  isManualMode,
  pickedToolIds,
}: ToolDeferralOptions): string[] => {
  const configured = new Set(configuredToolIds);
  const hidden = new Set(hiddenToolIds);

  return [...new Set(candidates)].filter(
    (id) => !pickedToolIds.has(id) && !hidden.has(id) && !(isManualMode && configured.has(id)),
  );
};
