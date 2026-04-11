import { memo } from 'react';

/**
 * arckep: LobeHub marketplace publishing disabled. Original component
 * rendered a "Publish to Community" button + result modal that submitted
 * the group to LobeHub's marketplace. We blocked the marketplace via nginx
 * and MarketAuth, so this button would lead nowhere. Render null.
 */
const GroupPublishButton = memo(() => null);

GroupPublishButton.displayName = 'GroupPublishButton';

export default GroupPublishButton;
