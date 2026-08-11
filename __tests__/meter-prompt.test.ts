/**
 * Meter-awareness of the synth MIDI system prompt (P8a multi-time-signature).
 *
 * BYTE-IDENTITY PIN: the snapshot below was recorded from the PRE-meter
 * implementation (the verbatim extraction of SynthGeneratorPanel's
 * `buildMidiSystemPrompt(validRoles)` — no meter parameter). After the meter
 * parameter landed, the 4/4 prompt — with the parameter omitted OR passed
 * explicitly as '4/4' — must still match that snapshot byte-for-byte. Never
 * update this snapshot as part of a meter change; a diff here means 4/4
 * behavior drifted. Last deliberately revised 2026-08-10 (hand-edited snap)
 * to add the RHYTHM ANCHORS bullet — kick/sub pins moved out of the
 * counterpoint header into their own lock-to header.
 */
import { describe, it, expect } from '@jest/globals';
import { buildMidiSystemPrompt } from '../src/synth-system-prompt';

const SAMPLE_ROLES = ['bass', 'pads', 'leads', 'keys', 'plucks'] as const;

describe('buildMidiSystemPrompt — 4/4 byte identity', () => {
  it('4/4 output is byte-identical to the pre-meter prompt (snapshot pin)', () => {
    expect(buildMidiSystemPrompt(SAMPLE_ROLES)).toMatchSnapshot();
  });

  it("omitted, explicit '4/4', and unparseable meters all produce the identical legacy prompt", () => {
    const legacy = buildMidiSystemPrompt(SAMPLE_ROLES);
    expect(buildMidiSystemPrompt(SAMPLE_ROLES, '4/4')).toBe(legacy);
    expect(buildMidiSystemPrompt(SAMPLE_ROLES, 'waltz')).toBe(legacy);
    expect(buildMidiSystemPrompt(SAMPLE_ROLES, '')).toBe(legacy);
  });
});

describe('buildMidiSystemPrompt — non-4/4 meters', () => {
  it('3/4 appends the waltz meter rules with the 3-qn bar arithmetic', () => {
    const prompt = buildMidiSystemPrompt(SAMPLE_ROLES, '3/4');
    expect(prompt).toContain('Time signature 3/4 — meter rules:');
    expect(prompt).toContain('NO beats-2-and-4 backbeat');
    expect(prompt).toContain('spans 3 quarter notes');
    // Everything before the appended block is the untouched legacy prompt.
    expect(prompt.startsWith(buildMidiSystemPrompt(SAMPLE_ROLES))).toBe(true);
  });

  it('6/8 appends compound-duple rules (second pulse, threes)', () => {
    const prompt = buildMidiSystemPrompt(SAMPLE_ROLES, '6/8');
    expect(prompt).toContain('Time signature 6/8 — meter rules:');
    expect(prompt).toContain('SECOND pulse');
    expect(prompt).toContain('threes');
  });

  it('7/8 states the fractional bar span and grouping', () => {
    const prompt = buildMidiSystemPrompt(SAMPLE_ROLES, '7/8');
    expect(prompt).toContain('spans 3.5 quarter notes');
    expect(prompt).toContain('2+2+3');
  });

  it('non-4/4 prompts keep the role list and note schema', () => {
    const prompt = buildMidiSystemPrompt(SAMPLE_ROLES, '12/8');
    expect(prompt).toContain(SAMPLE_ROLES.join(', '));
    expect(prompt).toContain('"startBeat"');
  });
});
