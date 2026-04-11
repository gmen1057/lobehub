import { ActionIcon, DropdownMenu, Flexbox, Icon } from '@lobehub/ui';
import { BotMessageSquareIcon, MoreHorizontal, Settings2Icon } from 'lucide-react';
import { memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { DESKTOP_HEADER_ICON_SIZE } from '@/const/layoutTokens';
import NavHeader from '@/features/NavHeader';
import ToggleRightPanelButton from '@/features/RightPanel/ToggleRightPanelButton';
import { useAgentStore } from '@/store/agent';

import AgentForkTag from './AgentForkTag';
import AgentStatusTag from './AgentStatusTag';
import AgentVersionReviewTag from './AgentVersionReviewTag';
import AutoSaveHint from './AutoSaveHint';

/**
 * arckep: stripped the "Publish to community" menu entry and all related
 * state/handlers (market auth, fork confirmation modal, publish result
 * modal, ownership check, version review validation). Publishing goes to
 * LobeHub marketplace which we don't support. Only "Advanced settings"
 * remains in the dropdown menu.
 */
const Header = memo(() => {
  const { t } = useTranslation('setting');

  const menuItems = useMemo(
    () => [
      {
        icon: <Icon icon={Settings2Icon} />,
        key: 'advanced-settings',
        label: t('advancedSettings'),
        onClick: () => useAgentStore.setState({ showAgentSetting: true }),
      },
    ],
    [t],
  );

  return (
    <NavHeader
      left={
        <Flexbox horizontal gap={8}>
          <AutoSaveHint />
          <AgentStatusTag />
          <AgentVersionReviewTag />
          <AgentForkTag />
        </Flexbox>
      }
      right={
        <Flexbox horizontal align={'center'} gap={4}>
          <DropdownMenu items={menuItems}>
            <ActionIcon icon={MoreHorizontal} size={DESKTOP_HEADER_ICON_SIZE} />
          </DropdownMenu>
          <ToggleRightPanelButton icon={BotMessageSquareIcon} showActive={true} />
        </Flexbox>
      }
    />
  );
});

export default Header;
