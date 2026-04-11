'use client';

import { memo } from 'react';

/**
 * arckep: WantMoreSkills originally rendered "You've reached the end — send a
 * request" text that opened a feedback modal submitting to LobeHub. We don't
 * want outbound feedback channels in our UI, so we render nothing. SkillStore
 * lists still work end-to-end; the list just terminates silently.
 */
const WantMoreSkills = memo(() => null);

WantMoreSkills.displayName = 'WantMoreSkills';

export default WantMoreSkills;
