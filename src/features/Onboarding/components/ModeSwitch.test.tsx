import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import ModeSwitch from './ModeSwitch';

let mockAgentOnboardingEnabled = true;

vi.mock('@/routes/onboarding/config', () => ({
  get AGENT_ONBOARDING_ENABLED() {
    return mockAgentOnboardingEnabled;
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        'agent.modeSwitch.agent': 'Conversational',
        'agent.modeSwitch.classic': 'Classic',
        'agent.modeSwitch.label': 'Choose your onboarding mode',
      })[key] || key,
  }),
}));

const renderModeSwitch = async ({
  actions,
  enabled,
  entry = '/onboarding/agent',
  showLabel,
}: {
  actions?: ReactNode;
  enabled: boolean;
  entry?: string;
  showLabel?: boolean;
}) => {
  mockAgentOnboardingEnabled = enabled;

  render(
    <MemoryRouter initialEntries={[entry]}>
      <ModeSwitch actions={actions} showLabel={showLabel} />
    </MemoryRouter>,
  );
};

afterEach(() => {
  cleanup();
});

describe('ModeSwitch', () => {
  it('renders both onboarding variants when agent onboarding is enabled', async () => {
    await renderModeSwitch({ enabled: true, showLabel: true });

    expect(screen.getByText('Choose your onboarding mode')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Conversational' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Classic' })).not.toBeChecked();
  });

  it('hides the onboarding switch entirely when agent onboarding is disabled', async () => {
    await renderModeSwitch({ enabled: false });

    expect(screen.queryByRole('radio', { name: 'Conversational' })).not.toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: 'Classic' })).not.toBeInTheDocument();
    expect(screen.queryByText('Choose your onboarding mode')).not.toBeInTheDocument();
  });

  it('keeps action buttons visible when agent onboarding is disabled', async () => {
    await renderModeSwitch({
      actions: <button type="button">Restart</button>,
      enabled: false,
    });

    expect(screen.getByRole('button', { name: 'Restart' })).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: 'Conversational' })).not.toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: 'Classic' })).not.toBeInTheDocument();
  });
});
