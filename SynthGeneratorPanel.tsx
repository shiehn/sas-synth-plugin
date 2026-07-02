/**
 * SynthGeneratorPanel — Real UI for the @signalsandsorcery/synth-generator plugin
 *
 * Thin family adapter over the SDK panel-core (useGeneratorPanelCore +
 * GeneratorPanelShell, SDK 2.35.0). Everything the pre-extraction monolith
 * carried — track load/reconcile, event subscriptions, prompt persistence,
 * mixer/FX/drawer/piano-roll wiring, crossfade/fade machinery, render
 * skeleton — now lives in the SDK; this file supplies only what is genuinely
 * synth-specific:
 *
 *   - the MIDI system prompt (synth flat-note schema + role)
 *   - Surge/raw dual-path sound serialization (ValueTree vs raw VST3 state)
 *   - the role-driven host.shufflePreset 🎲 with its exhausted-cycle regex
 *   - the single-track generation strategy (LLM → clip → mute → role →
 *     preset → edit-buffer seed)
 *   - identity literals (accent #A78BFA, 'synth-' names, Surge XT default)
 *
 * Behavior is pinned by sas-app/src/__tests__/synth-panel-behavior.test.tsx
 * (Phase-0 snapshot + host-call-sequence oracle) — it must pass UNCHANGED
 * against this rewrite. Uses ONLY PluginHost SDK methods — no EngineContext,
 * no window.electronAPI.
 */

import React, { useMemo } from 'react';
import type {
  PluginUIProps,
  PluginHost,
  PluginTrackHandle,
  MidiClipData,
  TrackSoundSnapshot,
} from '@signalsandsorcery/plugin-sdk';
import {
  GeneratorPanelShell,
  useGeneratorPanelCore,
  formatConcurrentTracks,
  parseLLMNoteResponse,
  type GeneratorPanelAdapter,
  type GenerationServices,
  type GeneratorTrackState,
  type PanelSoundAdapter,
} from '@signalsandsorcery/plugin-sdk';

// ============================================================================
// Constants
// ============================================================================

const MAX_TRACKS = 16;
const ESTIMATED_GENERATION_MS = 15000;

/**
 * Build the MIDI system prompt using the host's canonical role list
 * (host.getValidRoles()) so the LLM emits a role value the classifier
 * understands. See `src/music-engine/constants/instrument-classification.ts`
 * — the assistant-side single source of truth.
 */
function buildMidiSystemPrompt(validRoles: readonly string[]): string {
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
- role: instrument role — MUST be one of: ${validRoles.join(', ')}`;
}

// ============================================================================
// Synth sound serialization (Surge ValueTree vs raw VST3 dual path)
// ============================================================================

/**
 * Resolve the track's instrument (first non-utility plugin) plus how its
 * state serializes: default Surge XT round-trips through the Tracktion
 * ValueTree (get/setPluginState); third-party instruments (u-he Diva, Serum,
 * …) need their RAW VST3 state (get/setRawPluginState), which the ValueTree
 * wrapper does not faithfully preserve. Matching only 'Surge' silently broke
 * history for custom-instrument tracks pre-split.
 */
async function getInstrument(
  host: PluginHost,
  trackId: string,
): Promise<{ index: number; isRaw: boolean } | null> {
  try {
    const plugins = await host.getTrackPlugins(trackId);
    const instrument = plugins.find(
      (p) => !p.name.includes('Volume') && !p.name.includes('Pan') && !p.name.includes('Level'),
    );
    if (!instrument) return null;
    return { index: instrument.index, isRaw: !instrument.name.includes('Surge') };
  } catch {
    return null;
  }
}

function createSynthSoundAdapter(host: PluginHost): PanelSoundAdapter {
  const applySound = async (trackId: string, descriptor: unknown): Promise<void> => {
    const { state, stateType } = descriptor as { state: string; stateType?: 'raw' | 'valuetree' };
    const inst = await getInstrument(host, trackId);
    if (!inst) return;
    // Restore through the setter matching how the sound was captured. Absent
    // stateType ⇒ ValueTree (history recorded before the raw/ValueTree split).
    if (stateType === 'raw') await host.setRawPluginState(trackId, inst.index, state);
    else await host.setPluginState(trackId, inst.index, state);
  };
  return {
    applySound,
    captureSoundDescriptor: async (trackId: string) => {
      const inst = await getInstrument(host, trackId);
      if (!inst) return null;
      // Capture in the instrument's native serialization so restore is faithful.
      const state = inst.isRaw
        ? await host.getRawPluginState(trackId, inst.index)
        : await host.getPluginState(trackId, inst.index);
      return { descriptor: { state, stateType: inst.isRaw ? 'raw' : 'valuetree' } };
    },
    copySnapshot: async (trackId: string, snap: TrackSoundSnapshot) => {
      if (snap.kind !== 'preset') return 'default';
      await applySound(trackId, { state: snap.state, stateType: snap.stateType });
      // Persist the copy as the track's durable preset identity — getTrackSound
      // reads it, and the drift re-sync compares identities (an unpersisted
      // copy reads as "no sound" and gets re-pushed on every panel load).
      // Absent stateType ⇒ ValueTree (same fallback applySound uses).
      await host
        .persistTrackPresetState?.(trackId, {
          state: snap.state,
          stateType: snap.stateType ?? 'valuetree',
          name: snap.label,
        })
        .catch(() => {});
      return snap.label;
    },
    descriptorFromSnapshot: (snap: TrackSoundSnapshot) => {
      const preset = snap as Extract<TrackSoundSnapshot, { kind: 'preset' }>;
      return { state: preset.state, stateType: preset.stateType };
    },
    acceptedSnapshotKind: 'preset',
    // Surge state blobs are large, so cap synth history tighter than samples.
    historyMax: 12,
    importSoundLabel: 'Import Preset',
    importNoun: 'preset',
    previousSoundLabel: 'Previous preset',
  };
}

// ============================================================================
// Synth generation strategy (single track: LLM → clip → mute → role → preset)
// ============================================================================

async function generateSynthTrack(
  track: GeneratorTrackState,
  services: GenerationServices,
): Promise<void> {
  const { host } = services;
  const trackId = track.handle.id;

  // 1. Get musical context (for clip timing calculations)
  const musicalContext = await host.getMusicalContext();

  // 2. Get generation context (excludes this track)
  const generationContext = await host.getGenerationContext(trackId);

  // 3. Classify preset category from the prompt
  const presetCategory = await host.classifyPresetCategory(track.prompt);

  // 4. Build user prompt (musical context + scene contract auto-prefixed by
  // the host). The SDK helper renders other tracks' role + prompt + raw MIDI
  // notes-by-chord, so the LLM sees the full scene state. Empty when no other
  // tracks exist — skip the heading rather than emit "(none yet)" noise.
  const concurrentBlock = formatConcurrentTracks(generationContext);

  const promptParts: string[] = [];
  if (concurrentBlock) {
    promptParts.push(concurrentBlock, '');
  }
  promptParts.push(
    `Classified preset category: ${presetCategory}`,
    ``,
    `User request: "${track.prompt}"`,
    ``,
    `Generate MIDI notes for a synth part that fits this context.`,
  );
  const userPrompt = promptParts.join('\n');

  // 5. Call LLM (host auto-prefixes musical context)
  const llmResult = await host.generateWithLLM({
    system: buildMidiSystemPrompt(host.getValidRoles()),
    user: userPrompt,
    responseFormat: 'json',
  });

  // 6. Parse LLM response
  const parsed = parseLLMNoteResponse(llmResult.content);
  if (!parsed || parsed.notes.length === 0) {
    throw new Error('LLM returned no valid MIDI notes');
  }

  // 7. Post-process MIDI
  const processedNotes = await host.postProcessMidi(parsed.notes, {
    quantize: true,
    removeOverlaps: true,
  });

  // 8. Write MIDI clip
  const clipData: MidiClipData = {
    startTime: 0,
    endTime: (musicalContext.bars * 4 * 60) / musicalContext.bpm,
    tempo: musicalContext.bpm,
    notes: processedNotes,
  };
  await host.writeMidiClip(trackId, clipData);

  // Mute newly generated tracks by default — fresh generations must not blast
  // out while the user is still setting up the next track. Optimistic local
  // update so the UI doesn't wait for the trackStateChanged round-trip.
  await host.setTrackMute(trackId, true).catch(() => {});
  services.updateTrack(trackId, (t) => ({
    ...t,
    runtimeState: { ...t.runtimeState, muted: true },
  }));

  // Store role in scene data for shuffle/duplicate to use (stable DB UUID key)
  const genDbId = services.engineToDbId(trackId);
  const newRole = parsed.role ?? track.role;
  if (services.activeSceneId && newRole) {
    host
      .setSceneData(services.activeSceneId, services.trackDataKey(genDbId, 'role'), newRole)
      .catch(() => {});
  }

  // Persist the role to tracks.role so the transition generator's layer
  // classifier can see it. Without this, plugin-created synth tracks ship as
  // role=NULL and drop out of the transition chop catalog.
  if (newRole && newRole !== track.role) {
    try {
      await host.setTrackRole(trackId, newRole);
    } catch (err) {
      // Non-fatal — MIDI is already written.
      console.warn('[SynthGeneratorPanel] setTrackRole failed:', err);
    }
  }

  // Apply a matching preset based on the role + MIDI notes. Without this, the
  // track keeps the default Surge XT init patch. Skip for custom instruments —
  // the user chose their sound, don't overwrite it.
  if (!track.instrumentPluginId) {
    try {
      await host.shufflePreset(trackId);
    } catch {
      // Non-fatal — track still has MIDI, just default preset
    }
  }

  // Update state on success. Seed the piano-roll edit buffer with the freshly
  // generated notes so opening the Edit tab needs no round-trip, and mark the
  // track loaded so the tab doesn't re-fetch over them.
  services.updateTrack(trackId, (t) => ({
    ...t,
    isGenerating: false,
    error: null,
    role: newRole,
    hasMidi: true,
    generationProgress: 0,
    editNotes: processedNotes,
    editBars: musicalContext.bars,
    editBpm: musicalContext.bpm,
  }));
  services.markEditLoaded(trackId);
  // Fresh baseline — clear history; the next shuffle lazy-seeds this preset.
  services.soundHistory.clear(trackId);
  host.showToast('success', 'MIDI generated');
}

// ============================================================================
// The adapter
// ============================================================================

function createSynthGeneratorAdapter(host: PluginHost): GeneratorPanelAdapter {
  return {
    identity: {
      familyKey: 'synth',
      familyLabel: 'Synths',
      trackNamePrefix: 'synth',
      logTag: 'SynthGeneratorPanel',
      accentColor: '#A78BFA',
      transitionAccentColor: '#9333EA',
      placeholderAccentColor: '#3B82F6',
      maxTracks: MAX_TRACKS,
      estimatedGenerationMs: ESTIMATED_GENERATION_MS,
    },
    features: {
      instrumentPicker: true,
      bulkComposePlaceholders: true,
      exportMidi: true,
      transitionDesigner: true,
      importTracks: true,
    },
    createTrackOptions: () => ({ loadSynth: true, synthName: 'Surge XT' }),
    // Native, role-appropriate Surge preset (keeps the default patch on failure).
    applyPortedTrackSound: async (handle: PluginTrackHandle) => {
      try {
        await host.shufflePreset(handle.id);
      } catch {
        /* non-fatal */
      }
    },
    buildSystemPrompt: buildMidiSystemPrompt,
    parseNotesResponse: parseLLMNoteResponse,
    sound: createSynthSoundAdapter(host),
    shuffle: {
      shuffle: async (track: GeneratorTrackState, excludeNames: string[]) => {
        const result = await host.shufflePreset(track.handle.id, excludeNames);
        return { appliedName: result.presetName };
      },
      isExhaustedError: (err: unknown) =>
        /no presets available/i.test(err instanceof Error ? err.message : String(err)),
    },
    generation: { generate: generateSynthTrack },
  };
}

// ============================================================================
// SynthGeneratorPanel
// ============================================================================

export function SynthGeneratorPanel(props: PluginUIProps): React.ReactElement {
  // Referentially stable adapter — REQUIRED (an unstable adapter re-creates
  // the core's loadTracks every render; the historical render-loop bug).
  const adapter = useMemo(() => createSynthGeneratorAdapter(props.host), [props.host]);
  const core = useGeneratorPanelCore({ ui: props, adapter });
  return <GeneratorPanelShell core={core} />;
}

export default SynthGeneratorPanel;
