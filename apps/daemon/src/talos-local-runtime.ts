export type TalosLocalAgentId = 'talos-qwen' | 'talos-deepseek';
export type TalosLocalRuntimeMode = 'chat' | 'coding';

export interface TalosLocalRuntimeStatus {
  // The controller also reports a transient 'transitioning' value mid-switch;
  // callers must key readiness off the *_active flags below, not this field.
  mode: TalosLocalRuntimeMode | 'transitioning';
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

// A cold model load can outlast any reasonable single HTTP request (observed
// >190s in production), so callers must not treat this endpoint's response
// latency as a readiness signal — see activateTalosLocalAgent below.
export function hasTalosLocalRuntimeConfig(env: NodeJS.ProcessEnv): boolean {
  return controllerConfig(env) !== null;
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
    signal: AbortSignal.timeout(600_000),
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
