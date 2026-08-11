import { afterEach, describe, expect, it } from 'vitest';
import {
  hasTalosLocalRuntimeConfig,
  talosRuntimeModeForAgent,
} from '../src/talos-local-runtime.js';

describe('Talos local runtime', () => {
  it('maps local agent profiles to their host runtime modes', () => {
    expect(talosRuntimeModeForAgent('talos-qwen')).toBe('chat');
    expect(talosRuntimeModeForAgent('talos-deepseek')).toBe('coding');
    expect(talosRuntimeModeForAgent('codex')).toBeNull();
  });

  describe('hasTalosLocalRuntimeConfig', () => {
    const originalUrl = process.env.LOCAL_LLM_CONTROL_URL;
    const originalToken = process.env.LOCAL_LLM_CONTROL_TOKEN;

    afterEach(() => {
      if (originalUrl === undefined) delete process.env.LOCAL_LLM_CONTROL_URL;
      else process.env.LOCAL_LLM_CONTROL_URL = originalUrl;
      if (originalToken === undefined) delete process.env.LOCAL_LLM_CONTROL_TOKEN;
      else process.env.LOCAL_LLM_CONTROL_TOKEN = originalToken;
    });

    it('is false when the controller URL or token is missing', () => {
      expect(hasTalosLocalRuntimeConfig({ ...process.env, LOCAL_LLM_CONTROL_URL: undefined, LOCAL_LLM_CONTROL_TOKEN: undefined })).toBe(false);
      expect(hasTalosLocalRuntimeConfig({ ...process.env, LOCAL_LLM_CONTROL_URL: 'http://host:8992', LOCAL_LLM_CONTROL_TOKEN: undefined })).toBe(false);
      expect(hasTalosLocalRuntimeConfig({ ...process.env, LOCAL_LLM_CONTROL_URL: undefined, LOCAL_LLM_CONTROL_TOKEN: 'token' })).toBe(false);
    });

    it('is true when both the controller URL and token are set', () => {
      expect(hasTalosLocalRuntimeConfig({
        ...process.env,
        LOCAL_LLM_CONTROL_URL: 'http://host:8992',
        LOCAL_LLM_CONTROL_TOKEN: 'token',
      })).toBe(true);
    });
  });
});
