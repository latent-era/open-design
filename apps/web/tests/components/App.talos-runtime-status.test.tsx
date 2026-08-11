// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../../src/App';
import type { AppConfig } from '../../src/types';
import { loadConfig, mergeDaemonConfig, fetchDaemonConfig, syncConfigToDaemon } from '../../src/state/config';
import {
  daemonIsLive,
  fetchAgentsStream,
  fetchAppVersionInfo,
  fetchDesignSystems,
  fetchPromptTemplates,
  fetchSkills,
} from '../../src/providers/registry';
import { fetchAmrModels, fetchTalosLocalRuntimeStatus } from '../../src/providers/daemon';
import { listProjects, listTemplates } from '../../src/state/projects';

vi.mock('../../src/router', () => ({
  navigate: vi.fn(),
  useRoute: () => ({ kind: 'home' as const, view: 'home' as const }),
}));

vi.mock('../../src/components/EntryView', () => ({
  EntryView: ({ config }: { config: AppConfig }) => (
    <div data-testid="agent-id">{config.agentId ?? 'none'}</div>
  ),
}));

vi.mock('../../src/components/ProjectView', () => ({
  ProjectView: () => <div>Project view</div>,
}));

vi.mock('../../src/components/pet/PetOverlay', () => ({
  PetOverlay: () => null,
}));

vi.mock('../../src/components/pet/pets', () => ({
  migrateCustomPetAtlas: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../src/components/SettingsDialog', () => ({
  SettingsDialog: () => null,
}));

vi.mock('../../src/providers/registry', async () => {
  const actual = await vi.importActual<typeof import('../../src/providers/registry')>(
    '../../src/providers/registry',
  );
  return {
    ...actual,
    daemonIsLive: vi.fn(),
    fetchAgentsStream: vi.fn(),
    fetchAppVersionInfo: vi.fn(),
    fetchDesignSystems: vi.fn(),
    fetchPromptTemplates: vi.fn(),
    fetchSkills: vi.fn(),
  };
});

vi.mock('../../src/providers/daemon', async () => {
  const actual = await vi.importActual<typeof import('../../src/providers/daemon')>(
    '../../src/providers/daemon',
  );
  return {
    ...actual,
    fetchAmrModels: vi.fn(),
    fetchTalosLocalRuntimeStatus: vi.fn(),
  };
});

vi.mock('../../src/state/projects', async () => {
  const actual = await vi.importActual<typeof import('../../src/state/projects')>(
    '../../src/state/projects',
  );
  return {
    ...actual,
    listProjects: vi.fn(),
    listTemplates: vi.fn(),
  };
});

vi.mock('../../src/state/config', async () => {
  const actual = await vi.importActual<typeof import('../../src/state/config')>(
    '../../src/state/config',
  );
  return {
    ...actual,
    fetchComposioConfigFromDaemon: vi.fn().mockResolvedValue(null),
    loadConfig: vi.fn(),
    mergeDaemonConfig: vi.fn(actual.mergeDaemonConfig),
    saveConfig: vi.fn(),
    fetchDaemonConfig: vi.fn(),
    fetchMediaProvidersFromDaemon: vi.fn().mockResolvedValue({ status: 'ok', providers: null }),
    syncComposioConfigToDaemon: vi.fn().mockResolvedValue(true),
    syncConfigToDaemon: vi.fn().mockResolvedValue(undefined),
    syncMediaProvidersToDaemon: vi.fn().mockResolvedValue(undefined),
  };
});

const mockedDaemonIsLive = vi.mocked(daemonIsLive);
const mockedFetchAgentsStream = vi.mocked(fetchAgentsStream);
const mockedFetchAppVersionInfo = vi.mocked(fetchAppVersionInfo);
const mockedFetchDesignSystems = vi.mocked(fetchDesignSystems);
const mockedFetchPromptTemplates = vi.mocked(fetchPromptTemplates);
const mockedFetchSkills = vi.mocked(fetchSkills);
const mockedFetchAmrModels = vi.mocked(fetchAmrModels);
const mockedFetchTalosLocalRuntimeStatus = vi.mocked(fetchTalosLocalRuntimeStatus);
const mockedListProjects = vi.mocked(listProjects);
const mockedListTemplates = vi.mocked(listTemplates);
const mockedLoadConfig = vi.mocked(loadConfig);
const mockedFetchDaemonConfig = vi.mocked(fetchDaemonConfig);
const mockedSyncConfigToDaemon = vi.mocked(syncConfigToDaemon);

function baseConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    mode: 'daemon',
    apiKey: '',
    apiProtocol: 'anthropic',
    apiVersion: '',
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-sonnet-4-5',
    apiProviderBaseUrl: 'https://api.anthropic.com',
    apiProtocolConfigs: {},
    agentId: null,
    skillId: null,
    designSystemId: null,
    onboardingCompleted: true,
    mediaProviders: {},
    composio: {},
    agentModels: {},
    agentCliEnv: {},
    ...overrides,
  };
}

const talosAgents = [
  {
    id: 'talos-qwen',
    name: 'Qwen Local',
    bin: '/usr/local/bin/talos-opencode-runtime',
    available: true,
    version: '1.0.0',
    models: [{ id: 'qwen_local/qwen3.6-35b', label: 'Qwen 3.6 35B' }],
  },
  {
    id: 'talos-deepseek',
    name: 'DeepSeek Local',
    bin: '/usr/local/bin/talos-opencode-runtime',
    available: true,
    version: '1.0.0',
    models: [{ id: 'deepseek_local/deepseek-v4-flash-0731-q2', label: 'DeepSeek V4 Flash' }],
  },
];

describe('App Talos runtime status auto-correction', () => {
  beforeEach(() => {
    mockedDaemonIsLive.mockResolvedValue(true);
    mockedFetchAgentsStream.mockResolvedValue([...talosAgents]);
    mockedFetchSkills.mockResolvedValue([]);
    mockedFetchDesignSystems.mockResolvedValue([]);
    mockedFetchPromptTemplates.mockResolvedValue([]);
    mockedFetchAppVersionInfo.mockResolvedValue(null);
    mockedListProjects.mockResolvedValue([]);
    mockedListTemplates.mockResolvedValue([]);
    mockedFetchAmrModels.mockResolvedValue({
      source: 'preset',
      refreshing: false,
      models: [{ id: 'amr-model', label: 'AMR Model' }],
    });
    mockedFetchDaemonConfig.mockResolvedValue({});
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }),
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('corrects a stale talos-qwen selection to talos-deepseek when the host is actually running DeepSeek', async () => {
    mockedLoadConfig.mockReturnValue(baseConfig({ agentId: 'talos-qwen' }));
    mockedFetchTalosLocalRuntimeStatus.mockResolvedValue({
      mode: 'coding',
      qwen_active: false,
      qwen_status_active: false,
      ds4_active: true,
      game_running: false,
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId('agent-id').textContent).toBe('talos-deepseek');
    });
    expect(mockedSyncConfigToDaemon).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'talos-deepseek' }),
    );
  });

  it('does not touch a non-Talos selection even when a Talos model is loaded', async () => {
    mockedLoadConfig.mockReturnValue(baseConfig({ agentId: 'codex' }));
    mockedFetchTalosLocalRuntimeStatus.mockResolvedValue({
      mode: 'coding',
      qwen_active: false,
      qwen_status_active: false,
      ds4_active: true,
      game_running: false,
    });

    render(<App />);

    await waitFor(() => {
      expect(mockedFetchTalosLocalRuntimeStatus).toHaveBeenCalled();
    });
    expect(screen.getByTestId('agent-id').textContent).toBe('codex');
    expect(mockedSyncConfigToDaemon).not.toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'talos-deepseek' }),
    );
  });

  it('leaves the selection untouched when the status fetch fails', async () => {
    mockedLoadConfig.mockReturnValue(baseConfig({ agentId: 'talos-qwen' }));
    mockedFetchTalosLocalRuntimeStatus.mockRejectedValue(new Error('daemon offline'));

    render(<App />);

    await waitFor(() => {
      expect(mockedFetchTalosLocalRuntimeStatus).toHaveBeenCalled();
    });
    expect(screen.getByTestId('agent-id').textContent).toBe('talos-qwen');
  });
});
