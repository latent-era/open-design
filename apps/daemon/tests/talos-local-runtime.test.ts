import { describe, expect, it } from 'vitest';
import { talosRuntimeModeForAgent } from '../src/talos-local-runtime.js';

describe('Talos local runtime', () => {
  it('maps local agent profiles to their host runtime modes', () => {
    expect(talosRuntimeModeForAgent('talos-qwen')).toBe('chat');
    expect(talosRuntimeModeForAgent('talos-deepseek')).toBe('coding');
    expect(talosRuntimeModeForAgent('codex')).toBeNull();
  });
});
