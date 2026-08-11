export type TalosLocalAgentId = 'talos-qwen' | 'talos-deepseek';
export type TalosLocalRuntimeMode = 'chat' | 'coding';

export interface TalosLocalRuntimeStatus {
  mode: TalosLocalRuntimeMode;
  qwen_active: boolean;
  qwen_status_active: boolean;
  ds4_active: boolean;
  game_running: boolean;
}

export function talosRuntimeModeForAgent(
  agentId: unknown,
): TalosLocalRuntimeMode | null {
  if (agentId === 'talos-qwen') return 'chat';
  if (agentId === 'talos-deepseek') return 'coding';
  return null;
}

function controllerConfig(
  env: NodeJS.ProcessEnv,
): { baseUrl: string; token: string } | null {
  const baseUrl = String(env.LOCAL_LLM_CONTROL_URL ?? '')
    .trim()
    .replace(/\/+$/u, '');
  const token = String(env.LOCAL_LLM_CONTROL_TOKEN ?? '').trim();
  return baseUrl && token ? { baseUrl, token } : null;
}

async function controllerRequest(
  env: NodeJS.ProcessEnv,
  path: '/status' | '/mode',
  init?: RequestInit,
): Promise<TalosLocalRuntimeStatus> {
  const config = controllerConfig(env);
  if (!config) throw new Error('Talos local runtime control is unavailable');
  const response = await fetch(`${config.baseUrl}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${config.token}`,
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
    },
    signal: AbortSignal.timeout(190_000),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: unknown };
    const detail = typeof body.error === 'string' ? body.error : `HTTP ${response.status}`;
    throw new Error(`Talos local runtime request failed: ${detail}`);
  }
  return await response.json() as TalosLocalRuntimeStatus;
}

export function readTalosLocalRuntimeStatus(
  env: NodeJS.ProcessEnv = process.env,
): Promise<TalosLocalRuntimeStatus> {
  return controllerRequest(env, '/status');
}

export function activateTalosLocalAgent(
  agentId: TalosLocalAgentId,
  env: NodeJS.ProcessEnv = process.env,
): Promise<TalosLocalRuntimeStatus> {
  const mode = talosRuntimeModeForAgent(agentId);
  if (!mode) throw new Error('Unsupported Talos local agent');
  return controllerRequest(env, '/mode', {
    method: 'POST',
    body: JSON.stringify({ mode }),
  });
}
