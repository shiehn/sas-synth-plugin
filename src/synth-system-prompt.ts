/**
 * The synth panel's MIDI system prompt (extracted verbatim from
 * SynthGeneratorPanel.tsx so it is testable — the extraction itself changed
 * no bytes of the prompt).
 *
 * Build the MIDI system prompt using the host's canonical role list
 * (host.getValidRoles()) so the LLM emits a role value the classifier
 * understands. See `src/music-engine/constants/instrument-classification.ts`
 * — the assistant-side single source of truth.
 *
 * P8a (multi-time-signature): `timeSignature` is the scene meter ("N/D").
 * Omitted / '4/4' / unparseable → the prompt is BYTE-IDENTICAL to the legacy
 * 4/4 text (pinned by __tests__/meter-prompt.test.ts). Any other meter
 * appends the SDK's per-family meter rules (bar arithmetic in quarter notes,
 * grouping, strong-beat idiom).
 */
import { formatPluginMeterGuidance } from '@signalsandsorcery/plugin-sdk';

export function buildMidiSystemPrompt(
  validRoles: readonly string[],
  timeSignature: string = '4/4',
): string {
  // '' for 4/4 and unparseable input — the byte-identity contract.
  const meterRules = formatPluginMeterGuidance(timeSignature);
  const meterRulesBlock = meterRules ? `\n\n${meterRules}` : '';
  return `You are a MIDI composition AI. Given a musical context and text description, generate MIDI notes.

Respond with ONLY a JSON object in this format:
{
  "notes": [
    { "pitch": 60, "startBeat": 0, "durationBeats": 1, "velocity": 100 }
  ],
  "role": "bass"
}

Rules:
- pitch: MIDI note number 0-127
- startBeat: position in quarter-note beats from start of clip (0-based)
- durationBeats: duration in quarter-note beats
- velocity: 1-127
- Keep notes within the key and scale provided
- Match the style described in the prompt
- If "Concurrent tracks in scene" are listed, compose to COMPLEMENT them: lock to the bassline's root motion, avoid clashing with notes already sounding, don't double another part's rhythm note-for-note, and leave rhythmic space (rests are part of the groove).
- If "REFERENCE TRACKS" are listed, treat them as the parts you are writing AGAINST (counterpoint): interlock onsets rather than attacking together, favor contrary or oblique motion against their contour, prefer chord tones on strong beats with passing/neighbor tones on weak beats, and stay clear of the registers where they are busy.
- If "RHYTHM ANCHORS" are listed, the OPPOSITE applies: those are the kick/sub the band locks to. Land your accents ON their onsets where the style allows — the counterpoint advice above is for melodic REFERENCE TRACKS only, and displacing every note off the anchor grid reads as drift, not groove.
- role: instrument role — MUST be one of: ${validRoles.join(', ')}${meterRulesBlock}`;
}
