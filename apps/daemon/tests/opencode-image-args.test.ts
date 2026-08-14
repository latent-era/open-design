import { describe, expect, it } from 'vitest';

import { opencodeAgentDef } from '../src/runtimes/defs/opencode.js';

/**
 * Reference images reach opencode through `-f`, not through the prompt.
 *
 * The daemon appends attached images to the message text as `@<abs path>`
 * mentions. opencode resolves `@` against the project, so an upload sitting
 * outside it does not resolve, and the turn died with `empty_output` while a
 * tool call was outstanding — the user saw a failed run, not a missing image.
 *
 * `opencode run -f <path>` attaches a file directly and was verified end to
 * end against the local vision model.
 */
const opencode = opencodeAgentDef;

describe('opencode buildArgs image handling', () => {
  it('attaches each image with -f', () => {
    const args = opencode.buildArgs!('prompt', ['/tmp/od-uploads/a.png'], [], {}, {});
    const at = args.indexOf('-f');
    expect(at).toBeGreaterThan(-1);
    expect(args[at + 1]).toBe('/tmp/od-uploads/a.png');
  });

  it('attaches several images', () => {
    const args = opencode.buildArgs!('prompt', ['/a.png', '/b.png'], [], {}, {});
    expect(args.filter((a) => a === '-f')).toHaveLength(2);
    expect(args).toContain('/a.png');
    expect(args).toContain('/b.png');
  });

  it('adds nothing when there are no images', () => {
    const args = opencode.buildArgs!('prompt', [], [], {}, {});
    expect(args).not.toContain('-f');
  });

  it('keeps the run subcommand first', () => {
    // `-f` is a greedy array flag: placed before the subcommand it swallows it.
    const args = opencode.buildArgs!('prompt', ['/a.png'], [], {}, {});
    expect(args[0]).toBe('run');
    expect(args.indexOf('-f')).toBeGreaterThan(0);
  });

  it('still honours model and resume flags alongside images', () => {
    const args = opencode.buildArgs!(
      'prompt',
      ['/a.png'],
      [],
      { model: 'qwen_local/qwen3.6-35b' },
      { resumeSessionId: 'ses_1' },
    );
    expect(args).toContain('-s');
    expect(args).toContain('ses_1');
    expect(args).toContain('-m');
    expect(args).toContain('-f');
  });
});
