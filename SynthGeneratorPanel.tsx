/**
 * SynthGeneratorPanel — Real UI for the @signalsandsorcery/synth-generator plugin
 *
 * Renders the synth track list with prompt input, MIDI generation,
 * and track controls. Uses ONLY PluginHost SDK methods — no EngineContext,
 * no window.electronAPI, no injected compose props.
 *
 * Delegates all track UI rendering to the reusable SDK TrackRow component.
 */

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import type {
  PluginUIProps,
  PluginTrackHandle,
  PluginTrackRuntimeState,
  PluginTrackFxDetailState,
  PluginFxCategoryDetailState,
  MidiClipData,
  PluginMidiNote,
  BulkAddPlaceholderTrack,
  InstrumentDescriptor,
  FxCategory,
  TrackFxDetailState,
} from '@signalsandsorcery/plugin-sdk';
import { TrackRow, type DrawerTab, useSceneState, useAnySolo, useSoundHistory, useTrackReorder, type TrackSoundHistory, SorceryProgressBar, EMPTY_FX_DETAIL_STATE, formatConcurrentTracks, ImportTrackModal, useTrackLevels, CrossfadeTrackRow, CrossfadeModal, EQUAL_POWER_GAIN, parseCrossfadePairs, buildCrossfadeInpaintPrompt, type CrossfadeSlot, type CrossfadeSelection, type CrossfadeMeta, type CrossfadePairMeta } from '@signalsandsorcery/plugin-sdk';

// ============================================================================
// Constants
// ============================================================================

const MAX_TRACKS = 16;
const ESTIMATED_GENERATION_MS = 15000;
const EMPTY_PLACEHOLDERS: BulkAddPlaceholderTrack[] = [];

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
// Types
// ============================================================================

/** Internal track state combining handle + runtime state + prompt */
interface SynthTrackState {
  handle: PluginTrackHandle;
  prompt: string;
  role: string;
  runtimeState: PluginTrackRuntimeState;
  fxDetailState: TrackFxDetailState;
  // Unified drawer state (replaces fxDrawerOpen + instrumentDrawerOpen + instrumentDrawerStage).
  drawerOpen: boolean;
  drawerTab: DrawerTab;
  editorStage: boolean;
  isGenerating: boolean;
  error: string | null;
  hasMidi: boolean;
  generationProgress: number;
  // Piano-roll edit state. `editNotes` is the live, editable copy of the
  // track's MIDI (loaded lazily when the Edit tab is first opened, or seeded
  // from a fresh generation). `editBars`/`editBpm` size the grid + the save
  // span. See loadEditNotes / handleNotesChange.
  editNotes: PluginMidiNote[];
  editBars: number;
  editBpm: number;
  instrumentPluginId: string | null;
  instrumentName: string | null;
  instrumentMissing: boolean;
  /**
   * Per-track shuffle history. Set of Surge XT preset names already
   * handed back since the track was created OR since the history was
   * reset (which happens automatically when the category pool is
   * exhausted — host.shufflePreset throws "no presets available" and
   * we wipe the history and retry). Cycle pattern: cycle through every
   * preset in the category before any repeat.
   */
  shuffleHistory: Set<string>;
}

/** Shape of the parsed LLM JSON response */
interface LLMNoteResponse {
  notes: PluginMidiNote[];
  role?: string;
}

// ============================================================================
// Crossfade tracks (transition scenes) — shared metadata + parsing live in the
// SDK (crossfade-meta.ts); only the live-track-bound resolved pair is panel-local.
// ============================================================================

/** A crossfade pair resolved against live track state (both members present). */
interface ResolvedCrossfadePair extends CrossfadePairMeta {
  origin: SynthTrackState;
  target: SynthTrackState;
}

// ============================================================================
// SynthGeneratorPanel
// ============================================================================

export function SynthGeneratorPanel({
  host,
  activeSceneId,
  isAuthenticated,
  isConnected,
  onHeaderContent,
  onLoading,
  sceneContext,
  onSelectScene,
  onOpenContract,
  onExpandSelf,
}: PluginUIProps): React.ReactElement {
  // Cosmetic per-track peak meters. Poll while the panel is mounted + visible;
  // NOT gated on transport state (this app plays via decks/clip-launcher, so the
  // linear "is playing" flag is unreliable). Stopped tracks just read the floor.
  // The host coalesces the read so playback always wins over the GUI. Older
  // hosts (no getTrackLevels) degrade to no meter via the `supportsMeters` guard.
  const supportsMeters = typeof host.getTrackLevels === 'function';
  const trackLevels = useTrackLevels(host);

  const [tracks, setTracks] = useState<SynthTrackState[]>([]);
  const [isLoadingTracks, setIsLoadingTracks] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [soundImportTarget, setSoundImportTarget] = useState<SynthTrackState | null>(null);
  // Crossfade tracks (transition scenes): the "+ Crossfade" modal + the parsed
  // pair metadata for the active scene (members are normal tracks linked via
  // scene-data; the render layer groups them into one CrossfadeTrackRow).
  const [crossfadeOpen, setCrossfadeOpen] = useState(false);
  const [crossfadePairsMeta, setCrossfadePairsMeta] = useState<CrossfadePairMeta[]>([]);
  // Scene-keyed compose state: preserved when switching scenes via SDK hook
  const [isComposing, , setIsComposingForScene] = useSceneState(activeSceneId, false);
  const [placeholders, , setPlaceholdersForScene] = useSceneState<BulkAddPlaceholderTrack[]>(activeSceneId, EMPTY_PLACEHOLDERS);
  const saveTimeoutRefs = useRef<Record<string, NodeJS.Timeout>>({});
  // Tracks whose piano-roll notes have already been loaded (or seeded from a
  // fresh generation). Guards the Edit tab against re-fetching on every open
  // and against clobbering unsaved edits. A ref (not state) so toggling it
  // never triggers a re-render / load loop.
  const editLoadStartedRef = useRef<Set<string>>(new Set());
  const [availableInstruments, setAvailableInstruments] = useState<InstrumentDescriptor[]>([]);
  const [instrumentsLoading, setInstrumentsLoading] = useState(false);
  /** Maps engine track ID → stable DB UUID for plugin_data key construction */
  const engineToDbIdRef = useRef<Map<string, string>>(new Map());

  // --- Load tracks when scene changes -----------------------------------
  // Stale-scene guard: tracks state is keyed implicitly by activeSceneId,
  // but React holds the prior scene's tracks until loadTracks finishes its
  // async fetch (engine list + DB query + per-track info ~hundreds of ms).
  // During that window the panel renders the OLD scene's tracks under the
  // NEW scene's header — a "ghost track" symptom that goes away on re-mount.
  // Clear on real scene transitions so the gap is empty, not stale.
  const tracksLoadedForSceneRef = useRef<string | null>(null);

  // --- Sound history (↩ back-arrow + drawer "History" tab) --------------
  // A synth "sound" is its INSTRUMENT plugin state (base64): snapshot via
  // getPluginState at the instrument plugin's index, restore via
  // setPluginState. The instrument is the first non-utility plugin — Surge XT
  // on default tracks, or a third-party VST3 (e.g. u-he Diva) when the user
  // picked a custom instrument. Matching only 'Surge' silently broke history
  // (capture AND apply no-op'd) for custom-instrument tracks.
  // Resolve the track's instrument (first non-utility plugin) plus how its
  // state serializes: default Surge XT round-trips through the Tracktion
  // ValueTree (get/setPluginState); third-party instruments (u-he Diva, Serum,
  // …) need their RAW VST3 state (get/setRawPluginState), which the ValueTree
  // wrapper does not faithfully preserve.
  const getInstrument = useCallback(
    async (trackId: string): Promise<{ index: number; isRaw: boolean } | null> => {
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
    },
    [host],
  );
  const applySynthSound = useCallback(async (trackId: string, descriptor: unknown): Promise<void> => {
    const { state, stateType } = descriptor as { state: string; stateType?: 'raw' | 'valuetree' };
    const inst = await getInstrument(trackId);
    if (!inst) return;
    // Restore through the setter matching how the sound was captured. Absent
    // stateType ⇒ ValueTree (history recorded before the raw/ValueTree split).
    if (stateType === 'raw') await host.setRawPluginState(trackId, inst.index, state);
    else await host.setPluginState(trackId, inst.index, state);
  }, [host, getInstrument]);
  // Persist per-track history to project scene-data so it survives reopen.
  // Surge state blobs are large, so cap synth history tighter than samples.
  const persistSoundHistory = useCallback(
    (trackId: string, state: TrackSoundHistory): void => {
      if (!activeSceneId) return;
      const dbId = engineToDbIdRef.current.get(trackId) ?? trackId;
      host.setSceneData(activeSceneId, `track:${dbId}:soundHistory`, state).catch(() => {});
    },
    [host, activeSceneId],
  );
  const soundHistory = useSoundHistory(applySynthSound, { max: 12, onChange: persistSoundHistory });
  // Cross-panel: dim non-soloed rows when ANY track (any panel) is soloed.
  const anySolo = useAnySolo(host);

  // Drag-to-reorder rows. Shared SDK hook (identical wiring in every panel):
  // optimistic local reorder + persist via host.reorderTracks. Persist by the
  // stable dbId so the order survives project reopen.
  const reorder = useTrackReorder<SynthTrackState>({
    host,
    items: tracks,
    setItems: setTracks,
    getId: (t) => t.handle.dbId,
  });

  // Import just the PRESET (Surge state) from a track in another scene (drawer
  // "Import Preset"), bypassing the contract gate — "different contract, same
  // preset". Read the source state via host.getTrackSound, then apply + record.
  const handleSoundImportPick = useCallback(
    async (sel: { sourceTrackDbId: string; trackName: string; sceneName: string }): Promise<void> => {
      const target = soundImportTarget;
      if (!target || !host.getTrackSound) { setSoundImportTarget(null); return; }
      try {
        const snap = await host.getTrackSound(sel.sourceTrackDbId);
        if (!snap || snap.kind !== 'preset') {
          host.showToast('error', 'No preset to import', `${sel.trackName} has no synth preset.`);
          return;
        }
        const descriptor = { state: snap.state, stateType: snap.stateType };
        await applySynthSound(target.handle.id, descriptor);
        soundHistory.record(target.handle.id, descriptor, snap.label);
        host.showToast('success', 'Preset imported', `${snap.label} → ${target.handle.name}`);
      } catch (err: unknown) {
        host.showToast('error', 'Import failed', err instanceof Error ? err.message : String(err));
      } finally {
        setSoundImportTarget(null);
      }
    },
    [soundImportTarget, host, applySynthSound, soundHistory],
  );
  const captureSynthSound = useCallback(async (trackId: string, label: string): Promise<void> => {
    const inst = await getInstrument(trackId);
    if (!inst) return;
    try {
      // Capture in the instrument's native serialization so restore is faithful:
      // raw VST3 for third-party instruments, ValueTree for Surge.
      const state = inst.isRaw
        ? await host.getRawPluginState(trackId, inst.index)
        : await host.getPluginState(trackId, inst.index);
      soundHistory.record(trackId, { state, stateType: inst.isRaw ? 'raw' : 'valuetree' }, label);
    } catch {
      // Non-fatal — history just won't include this sound.
    }
  }, [host, getInstrument, soundHistory]);

  const loadTracks = useCallback(async (incremental = false): Promise<void> => {
    // Snapshot the scene this load is for. Each subsequent await is a chance
    // for `activeSceneId` to change (user switches scene mid-load) or for a
    // newer loadTracks to take over (newer call writes a different value to
    // `tracksLoadedForSceneRef`). When that happens, this load must NOT call
    // `setTracks(...)` — otherwise the old scene's results overwrite the new
    // scene's panel state, surfacing as phantom tracks under the new scene.
    const sceneAtStart = activeSceneId;
    if (!sceneAtStart) {
      setTracks([]);
      setCrossfadePairsMeta([]);
      tracksLoadedForSceneRef.current = null;
      // No scene → nothing to load → not loading. Without this, a load that
      // had already set isLoadingTracks=true (line below) and is then
      // superseded by a flip to a null activeSceneId (the platform's
      // effectiveSceneId briefly returns null while project.scenes repopulates
      // during load) leaves the spinner stuck on "Loading tracks..." forever.
      setIsLoadingTracks(false);
      return;
    }

    // Scene changed since the last load → clear immediately so the user
    // sees the new (empty) state, not the prior scene's tracks. Don't
    // clear for incremental reloads on the SAME scene (bulk completion
    // re-fetches mid-flight and we want to keep showing tracks then).
    if (!incremental && tracksLoadedForSceneRef.current !== sceneAtStart) {
      setTracks([]);
    }
    tracksLoadedForSceneRef.current = sceneAtStart;
    // Reset sound-history on a full (re)load so history resets per scene/reopen.
    if (!incremental) soundHistory.reset();

    const isStale = (): boolean => tracksLoadedForSceneRef.current !== sceneAtStart;

    // Only show "Loading tracks..." when there are no tracks yet (initial load).
    // Incremental reloads (re-adoption, bulk completion) keep existing tracks visible.
    if (!incremental) setIsLoadingTracks(true);
    try {
      await host.adoptSceneTracks();
      if (isStale()) return;
      const handles = await host.getPluginTracks();
      if (isStale()) return;
      const sceneData = await host.getAllSceneData(sceneAtStart) as Record<string, unknown>;
      if (isStale()) return;

      // Build engine→dbId lookup for callbacks that receive engine IDs
      const idMap = new Map<string, string>();
      for (const h of handles) { idMap.set(h.id, h.dbId); }
      engineToDbIdRef.current = idMap;

      const trackStates: SynthTrackState[] = [];
      for (const handle of handles) {
        // Get runtime state
        let runtimeState: PluginTrackRuntimeState = {
          id: handle.id,
          muted: false,
          solo: false,
          volume: 0.75,
          pan: 0,
        };
        let hasMidi = false;
        try {
          const info = await host.getTrackInfo(handle.id);
          runtimeState = {
            id: handle.id,
            muted: info.muted,
            solo: info.soloed,
            volume: info.volume,
            pan: info.pan,
          };
          hasMidi = info.hasMidi;
        } catch {
          // Use defaults
        }

        // Get FX state
        let fxDetailState: TrackFxDetailState = { ...EMPTY_FX_DETAIL_STATE };
        try {
          const fxState = await host.getTrackFxState(handle.id);
          fxDetailState = pluginFxToToggleFx(fxState);
        } catch {
          // Use defaults
        }

        // Use stable DB UUID for plugin_data keys (engine IDs change on project reload)
        const promptKey = `track:${handle.dbId}:prompt`;
        let prompt = typeof sceneData[promptKey] === 'string'
          ? sceneData[promptKey] as string
          : '';

        // Fallback: read prompt from tracks table (bulk-add saves there, not plugin_data)
        if (!prompt && handle.prompt) {
          prompt = handle.prompt;
          // Backfill into plugin_data so future loads find it directly.
          // Use the scene this load is for, not the (possibly changed) active scene.
          host.setSceneData(sceneAtStart, promptKey, prompt).catch(() => {});
        }

        // Detect hasMidi from role presence as a fallback
        if (!hasMidi && handle.role) {
          hasMidi = true;
        }

        // Detect missing instrument plugins (only for custom instruments, not default Surge XT)
        let instrumentMissing = false;
        if (handle.instrumentPluginId) {
          try {
            const instrDescriptor = await host.getTrackInstrument(handle.id);
            if (instrDescriptor?.missing) {
              instrumentMissing = true;
            }
          } catch {
            // Non-fatal — assume available
          }
        }

        trackStates.push({
          handle,
          prompt,
          role: handle.role ?? '',
          runtimeState,
          fxDetailState,
          drawerOpen: false,
          drawerTab: 'fx',
          editorStage: false,
          isGenerating: false,
          error: null,
          hasMidi,
          generationProgress: 0,
          editNotes: [],
          editBars: 4,
          editBpm: 120,
          instrumentPluginId: handle.instrumentPluginId ?? null,
          instrumentName: handle.instrumentName ?? null,
          instrumentMissing,
          shuffleHistory: new Set<string>(),
        });
      }
      if (isStale()) return;
      // Carry forward the in-memory piano-roll edit buffer (editNotes/Bars/Bpm)
      // for tracks that still exist, matched by stable DB UUID. loadTracks
      // rebuilds every track with editNotes:[], but editLoadStartedRef is a
      // permanent "loaded once" latch (set on generation / first Edit-tab open,
      // never cleared). A reload fired after a generation — instrument swap,
      // agent mutation, engine-ready, or the 30s project sync — would otherwise
      // wipe the seeded notes while the latch still marks the track loaded, so
      // opening the Edit tab skips the engine refetch and shows an empty piano
      // roll even though the MIDI is safe in the engine + DB. Preserving the
      // buffer keeps editLoadStartedRef and editNotes consistent.
      setTracks(prev => {
        const prevByDbId = new Map(prev.map(p => [p.handle.dbId, p]));
        return trackStates.map(ts => {
          const carry = prevByDbId.get(ts.handle.dbId);
          return carry
            ? { ...ts, editNotes: carry.editNotes, editBars: carry.editBars, editBpm: carry.editBpm }
            : ts;
        });
      });
      // Restore persisted history so it survives reopen. Lazy-seed (first shuffle)
      // still covers tracks with no saved history.
      for (const ts of trackStates) {
        const persisted = sceneData[`track:${ts.handle.dbId}:soundHistory`];
        if (persisted && typeof persisted === 'object') {
          soundHistory.restore(ts.handle.id, persisted as TrackSoundHistory);
        }
      }
      // Group crossfade members (normal tracks linked by a shared groupId in
      // scene-data) into pairs. Members render as one CrossfadeTrackRow; the
      // render layer excludes their standalone rows.
      if (!isStale()) setCrossfadePairsMeta(parseCrossfadePairs(sceneData));
    } catch (error: unknown) {
      console.error('[SynthGeneratorPanel] Failed to load tracks:', error);
    } finally {
      // Only clear the loading indicator if no newer loadTracks has taken
      // over — otherwise we'd race with the newer load's own loading state.
      if (tracksLoadedForSceneRef.current === sceneAtStart) {
        setIsLoadingTracks(false);
      }
    }
  }, [host, activeSceneId, soundHistory]);

  useEffect(() => {
    loadTracks();
  }, [loadTracks]);

  // Keep engine→dbId ref in sync with current tracks (for newly created tracks
  // that weren't present when loadTracks last ran)
  useEffect(() => {
    const map = new Map<string, string>();
    for (const t of tracks) { map.set(t.handle.id, t.handle.dbId); }
    engineToDbIdRef.current = map;
  }, [tracks]);

  // --- Reload tracks incrementally as individual bulk tracks complete ----
  const loadedCompletedIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (placeholders.length === 0) {
      loadedCompletedIdsRef.current.clear();
      return;
    }
    const newCompleted = placeholders.filter(
      (ph: BulkAddPlaceholderTrack) => ph.status === 'completed' && !loadedCompletedIdsRef.current.has(ph.id)
    );
    if (newCompleted.length > 0) {
      for (const ph of newCompleted) {
        loadedCompletedIdsRef.current.add(ph.id);
      }
      console.log(`[SynthGeneratorPanel] ${newCompleted.length} track(s) completed, reloading. IDs:`,
        newCompleted.map((ph: BulkAddPlaceholderTrack) => ph.id));
      loadTracks(true);
    }
  }, [placeholders, loadTracks]);

  // --- Re-adopt tracks after engine finishes full loading ---------------
  // Resolves race condition: on startup, loadTracks() may fire before all
  // engine tracks exist. This listener re-triggers adoption once the main
  // process confirms all tracks are loaded.
  const adoptAndLoad = useCallback((): void => {
    loadTracks(true);
  }, [loadTracks]);

  useEffect(() => {
    const unsub = host.onEngineReady(() => {
      adoptAndLoad();
    });
    return unsub;
  }, [host, adoptAndLoad]);

  // --- Re-adopt tracks after agent/CLI tool mutations -------------------
  // The HTTP API path (compose_scene from the chat plugin, sas CLI calls,
  // MCP tools) creates tracks in the DB directly via ToolRegistry, bypassing
  // host.createTrack/host.composeScene. Without this listener the panel never
  // sees those tracks until the user manually switches scenes — and the
  // "compose in progress" spinner never appears for AI-driven runs.
  // Debounced 500ms so a burst of tool calls coalesces into one reload.
  useEffect(() => {
    if (typeof host.onAfterAgentMutation !== 'function') return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsub = host.onAfterAgentMutation(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        loadTracks(true);
      }, 500);
    });
    return () => {
      unsub?.();
      if (timer) clearTimeout(timer);
    };
  }, [host, loadTracks]);

  // --- Subscribe to real-time track state changes -----------------------
  useEffect(() => {
    const unsub = host.onTrackStateChange(
      (trackId: string, state: PluginTrackRuntimeState) => {
        setTracks(prev => prev.map(t =>
          t.handle.id === trackId ? { ...t, runtimeState: state } : t
        ));
      }
    );
    return unsub;
  }, [host]);

  // --- Subscribe to compose progress events -----------------------------
  // Events include sceneId, routed to the correct scene via useSceneState.
  useEffect(() => {
    console.log('[SynthGeneratorPanel] Subscribing to composeProgress');
    const unsub = host.onComposeProgress((event) => {
      const targetScene = event.sceneId;
      if (!targetScene) return;
      console.log('[SynthGeneratorPanel] composeProgress event:', event.phase, 'sceneId:', targetScene, 'placeholders:', event.placeholders?.length ?? 'none');
      switch (event.phase) {
        case 'planning':
          setIsComposingForScene(targetScene, true);
          setPlaceholdersForScene(targetScene, []);
          break;
        case 'generating':
          setIsComposingForScene(targetScene, false);
          if (event.placeholders) {
            setPlaceholdersForScene(targetScene, event.placeholders);
          }
          break;
        case 'complete':
        case 'error':
          setIsComposingForScene(targetScene, false);
          setPlaceholdersForScene(targetScene, EMPTY_PLACEHOLDERS);
          break;
      }
    });
    return unsub;
  }, [host, setIsComposingForScene, setPlaceholdersForScene]);

  // --- Cleanup save timeouts on unmount ---------------------------------
  useEffect(() => {
    const refs = saveTimeoutRefs;
    return () => {
      for (const timeout of Object.values(refs.current)) {
        clearTimeout(timeout);
      }
    };
  }, []);

  // --- Add track --------------------------------------------------------
  // Re-entry guard: rapid clicks on "+ Add" used to race here. The button's
  // visual `disabled` only updates after React commits the next render, so
  // two clicks within the same tick both passed the `tracks.length` gate
  // and both fired `host.createTrack` — producing duplicate synth-<ts>
  // tracks (see 0.55–0.65s-apart timestamps in the audit log). The ref is
  // synchronous (not subject to render-cycle latency); the state mirrors
  // it so the button can disable itself visually too.
  const isAddingTrackRef = useRef(false);
  const [isAddingTrack, setIsAddingTrack] = useState(false);
  const handleAddTrack = useCallback(async (): Promise<void> => {
    if (isAddingTrackRef.current) return;
    if (!activeSceneId) {
      host.showToast('warning', 'Select SCENE');
      return;
    }
    if (!isConnected) {
      host.showToast('warning', 'Systems not connected');
      return;
    }
    if (!isAuthenticated) {
      host.showToast('warning', 'Sign In Required', 'Please sign in to add tracks');
      return;
    }
    if (tracks.length >= MAX_TRACKS) return;

    isAddingTrackRef.current = true;
    setIsAddingTrack(true);
    try {
      const handle = await host.createTrack({
        name: `synth-${Date.now()}`,
        loadSynth: true,
        synthName: 'Surge XT',
      });
      const newTrack: SynthTrackState = {
        handle,
        prompt: '',
        role: '',
        runtimeState: { id: handle.id, muted: false, solo: false, volume: 0.75, pan: 0 },
        fxDetailState: { ...EMPTY_FX_DETAIL_STATE },
        drawerOpen: false,
        drawerTab: 'fx',
        editorStage: false,
        isGenerating: false,
        error: null,
        hasMidi: false,
        generationProgress: 0,
        editNotes: [],
        editBars: 4,
        editBpm: 120,
        instrumentPluginId: null,
        instrumentName: null,
        instrumentMissing: false,
        shuffleHistory: new Set<string>(),
      };
      setTracks(prev => [...prev, newTrack]);
      onExpandSelf?.();
      // Auto-focus the prompt input of the newly created track after accordion animation
      setTimeout(() => {
        const inputs = document.querySelectorAll<HTMLInputElement>('[data-testid="synth-section"] [data-testid="sdk-prompt-input"]');
        if (inputs.length > 0) {
          inputs[inputs.length - 1].focus();
        }
      }, 350);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      host.showToast('error', 'Failed to create track', msg);
    } finally {
      isAddingTrackRef.current = false;
      setIsAddingTrack(false);
    }
  }, [host, activeSceneId, isConnected, isAuthenticated, tracks.length, onExpandSelf]);

  // Cross-panel import ("re-sound a part on a synth"): pull a MIDI part out of a
  // track owned by ANOTHER panel in THIS scene and play it on a fresh Surge
  // patch. The sound never carries across families — that's the point — so we
  // create our own track, copy only the MIDI + role, and shuffle a preset.
  // Ordering matters: createTrack registers ownership synchronously, so the
  // owned writes below (setTrackRole/writeMidiClip/shufflePreset) are safe.
  const handlePortTrack = useCallback(
    async (sel: { sourceTrackDbId: string; trackName: string; role?: string }): Promise<void> => {
      if (!activeSceneId) { host.showToast('warning', 'Select SCENE'); return; }
      if (!isConnected) { host.showToast('warning', 'Systems not connected'); return; }
      if (tracks.length >= MAX_TRACKS) { host.showToast('warning', 'Track limit reached'); return; }
      if (!host.readImportableTrackMidi) return;
      let handle: PluginTrackHandle | null = null;
      try {
        handle = await host.createTrack({ name: `synth-${Date.now()}`, loadSynth: true, synthName: 'Surge XT' });
        if (sel.role) {
          try { await host.setTrackRole(handle.id, sel.role); } catch { /* non-fatal: MIDI still ports */ }
        }
        const midi = await host.readImportableTrackMidi(sel.sourceTrackDbId);
        const notes = midi.clips[0]?.notes ?? [];
        if (notes.length > 0) {
          const mc = await host.getMusicalContext();
          await host.writeMidiClip(handle.id, {
            startTime: 0,
            endTime: (mc.bars * 4 * 60) / mc.bpm,
            tempo: mc.bpm,
            notes,
          });
        }
        // Native, role-appropriate Surge preset (keeps the default patch on failure).
        try { await host.shufflePreset(handle.id); } catch { /* non-fatal */ }
        host.showToast('success', 'Imported to synth', notes.length ? `${sel.trackName} → synth` : `${sel.trackName} (no MIDI yet)`);
        await loadTracks(true);
      } catch (err: unknown) {
        // Roll back the half-made track we created (we own it).
        if (handle) { try { await host.deleteTrack(handle.id); } catch { /* best effort */ } }
        host.showToast('error', 'Import failed', err instanceof Error ? err.message : String(err));
      }
    },
    [host, activeSceneId, isConnected, tracks.length, loadTracks],
  );

  // --- Create a crossfade pair (transition scenes) ----------------------
  // Two tracks share ONE generated MIDI clip: the top wears the ORIGIN scene
  // track's preset, the bottom wears the TARGET's. The user can't
  // regen/shuffle/preset-swap them (CrossfadeTrackRow omits those controls).
  // One-action: generate → create both → write same MIDI → copy presets →
  // equal-power volumes → persist pairing. LIFO rollback on any failure.
  // Throws on failure so the modal surfaces it and stays open.
  const [isCreatingCrossfade, setIsCreatingCrossfade] = useState(false);
  const handleCreateCrossfade = useCallback(
    async (origin: CrossfadeSelection, target: CrossfadeSelection): Promise<void> => {
      const scene = activeSceneId;
      const fromSceneId = sceneContext?.transitionFromSceneId ?? '';
      const toSceneId = sceneContext?.transitionToSceneId ?? '';
      if (!scene) throw new Error('No active scene.');
      if (!isConnected) throw new Error('Systems not connected.');
      if (!isAuthenticated) throw new Error('Please sign in to generate the bridge.');
      if (tracks.length + 2 > MAX_TRACKS) throw new Error('Not enough track slots for a crossfade.');

      setIsCreatingCrossfade(true);
      const created: PluginTrackHandle[] = [];
      try {
        const role = origin.role ?? target.role ?? '';

        // 1. Generate ONE bridge clip via MIDI INPAINTING: morph the ORIGIN part
        // into the TARGET part across the transition. The harmonic frame
        // (key/bpm/transition chords) is auto-prefixed by generateWithLLM; we add
        // the two endpoint patterns + the morph instruction. We deliberately do
        // NOT send concurrent sibling layers — a bridge is about connecting the
        // two tracks, not fitting a full arrangement. Read both patterns before
        // creating the (empty) layer tracks.
        const mc = await host.getMusicalContext();
        const [originMidi, targetMidi, originKey, targetKey] = await Promise.all([
          host.readImportableTrackMidi ? host.readImportableTrackMidi(origin.dbId) : Promise.resolve({ clips: [] }),
          host.readImportableTrackMidi ? host.readImportableTrackMidi(target.dbId) : Promise.resolve({ clips: [] }),
          host.getSceneKey ? host.getSceneKey(fromSceneId) : Promise.resolve(null),
          host.getSceneKey ? host.getSceneKey(toSceneId) : Promise.resolve(null),
        ]);
        const userPrompt = buildCrossfadeInpaintPrompt({
          role,
          bars: mc.bars,
          originName: origin.name,
          targetName: target.name,
          originKey: originKey ? `${originKey.key} ${originKey.mode}` : null,
          targetKey: targetKey ? `${targetKey.key} ${targetKey.mode}` : null,
          originNotes: originMidi.clips[0]?.notes ?? [],
          targetNotes: targetMidi.clips[0]?.notes ?? [],
        });
        const llm = await host.generateWithLLM({
          system: buildMidiSystemPrompt(host.getValidRoles()),
          user: userPrompt,
          responseFormat: 'json',
        });
        const parsed = parseLLMNoteResponse(llm.content);
        if (!parsed || parsed.notes.length === 0) {
          throw new Error('The bridge generator returned no notes.');
        }
        const notes = await host.postProcessMidi(parsed.notes, { quantize: true, removeOverlaps: true });
        const clip: MidiClipData = {
          startTime: 0,
          endTime: (mc.bars * 4 * 60) / mc.bpm,
          tempo: mc.bpm,
          notes,
        };

        // 2. Create the two layer tracks (default Surge; preset copied below).
        const top = await host.createTrack({ name: `synth-${Date.now()}-xf-o`, loadSynth: true, synthName: 'Surge XT' });
        created.push(top);
        const bottom = await host.createTrack({ name: `synth-${Date.now()}-xf-t`, loadSynth: true, synthName: 'Surge XT' });
        created.push(bottom);
        if (role) {
          await host.setTrackRole(top.id, role).catch(() => {});
          await host.setTrackRole(bottom.id, role).catch(() => {});
        }

        // 3. SAME MIDI on both layers.
        await host.writeMidiClip(top.id, clip);
        await host.writeMidiClip(bottom.id, clip);

        // 4. Copy each source preset onto its layer (exact sound — no shuffle).
        const copyPreset = async (newTrackId: string, sourceDbId: string): Promise<string> => {
          if (!host.getTrackSound) return 'default';
          const snap = await host.getTrackSound(sourceDbId);
          if (!snap || snap.kind !== 'preset') return 'default';
          await applySynthSound(newTrackId, { state: snap.state, stateType: snap.stateType });
          return snap.label;
        };
        const originLabel = await copyPreset(top.id, origin.dbId);
        const targetLabel = await copyPreset(bottom.id, target.dbId);

        // 5. Equal-power center so the centered (non-functional) slider already
        // sounds like a midpoint blend. Leave unmuted — the point is to hear it.
        await host.setTrackVolume(top.id, EQUAL_POWER_GAIN).catch(() => {});
        await host.setTrackVolume(bottom.id, EQUAL_POWER_GAIN).catch(() => {});

        // 6. Persist the pairing (one key per member, shared groupId).
        const groupId = top.dbId;
        const originMeta: CrossfadeMeta = {
          groupId, slot: 'origin', partnerDbId: bottom.dbId, sourceTrackDbId: origin.dbId,
          sourceSceneId: fromSceneId, sourceName: origin.name, soundLabel: originLabel, sliderPos: 0.5,
        };
        const targetMeta: CrossfadeMeta = {
          groupId, slot: 'target', partnerDbId: top.dbId, sourceTrackDbId: target.dbId,
          sourceSceneId: toSceneId, sourceName: target.name, soundLabel: targetLabel, sliderPos: 0.5,
        };
        await host.setSceneData(scene, `track:${top.dbId}:crossfade`, originMeta);
        await host.setSceneData(scene, `track:${bottom.dbId}:crossfade`, targetMeta);

        await loadTracks(true);
        host.showToast('success', 'Crossfade created', `${origin.name} → ${target.name}`);
      } catch (err: unknown) {
        // LIFO rollback — delete any track we created.
        for (const h of [...created].reverse()) {
          try { await host.deleteTrack(h.id); } catch { /* best effort */ }
        }
        throw err instanceof Error ? err : new Error(String(err));
      } finally {
        setIsCreatingCrossfade(false);
      }
    },
    [host, activeSceneId, isConnected, isAuthenticated, tracks.length, sceneContext, applySynthSound, loadTracks],
  );

  // --- Export tracks as MIDI bundle -------------------------------------
  const [isExportingMidi, setIsExportingMidi] = useState(false);
  const handleExportMidi = useCallback(async (): Promise<void> => {
    if (isExportingMidi) return;
    setIsExportingMidi(true);
    try {
      const result = await host.exportTracksAsMidiBundle({
        defaultName: 'midi-tracks',
      });
      if (result.success) {
        const filename = result.filePath.split('/').pop() || result.filePath;
        const skippedNote = result.skippedCount > 0
          ? ` (${result.skippedCount} empty track${result.skippedCount === 1 ? '' : 's'} skipped)`
          : '';
        host.showToast('success', 'MIDI exported', `${result.trackCount} track${result.trackCount === 1 ? '' : 's'} → ${filename}${skippedNote}`);
      } else if (!('canceled' in result && result.canceled)) {
        const errMsg = 'error' in result ? result.error : 'Unknown error';
        host.showToast('error', 'Export failed', errMsg);
      }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      host.showToast('error', 'Export failed', msg);
    } finally {
      setIsExportingMidi(false);
    }
  }, [host, isExportingMidi]);

  // --- Push header content (Add button) to accordion header -------------
  const isBulkActive = !!(isComposing || placeholders.length > 0);
  const needsContract = !sceneContext?.hasContract;
  // Crossfade is only offered inside a transition scene that knows both the
  // scenes it bridges, and only when the host supports the picker.
  const xfFromId = sceneContext?.transitionFromSceneId ?? null;
  const xfToId = sceneContext?.transitionToSceneId ?? null;
  const canCrossfade =
    sceneContext?.sceneType === 'transition' && !!xfFromId && !!xfToId && !!host.listSceneFamilyTracks;
  useEffect(() => {
    if (!onHeaderContent) return;
    const addDisabled =
      needsContract ||
      !isConnected ||
      !activeSceneId ||
      tracks.length >= MAX_TRACKS ||
      isAddingTrack;

    onHeaderContent(
      <div className="flex gap-1">
        {host.listImportableTracks && (
          <button
            data-testid="import-from-scene-synth-button"
            onClick={(e: React.MouseEvent) => {
              e.stopPropagation();
              onExpandSelf?.();
              setImportOpen(true);
            }}
            disabled={!activeSceneId || needsContract}
            className={`px-2 py-0.5 text-[10px] font-medium rounded-sm border transition-colors ${
              !activeSceneId || needsContract
                ? 'bg-sas-panel border-sas-border text-sas-muted/50 cursor-not-allowed'
                : 'bg-sas-panel-alt border-sas-border text-sas-muted hover:border-sas-accent hover:text-sas-accent'
            }`}
          >
            Import Track
          </button>
        )}
        <button
          data-testid="add-synth-track-button"
          onClick={(e: React.MouseEvent) => {
            e.stopPropagation();
            if (needsContract) { onOpenContract?.(); return; }
            handleAddTrack();
          }}
          className={`px-2 py-0.5 text-[10px] font-medium rounded-sm border transition-colors ${
            addDisabled
              ? 'bg-sas-panel border-sas-border text-sas-muted/50 cursor-not-allowed'
              : 'bg-sas-accent/10 border-sas-accent/30 text-sas-accent hover:bg-sas-accent/20'
          }`}
        >
          Add Track
        </button>
        {canCrossfade && (
          <button
            data-testid="add-crossfade-button"
            onClick={(e: React.MouseEvent) => {
              e.stopPropagation();
              if (needsContract) { onOpenContract?.(); return; }
              onExpandSelf?.();
              setCrossfadeOpen(true);
            }}
            disabled={!activeSceneId || needsContract || isCreatingCrossfade || tracks.length + 2 > MAX_TRACKS}
            className={`px-2 py-0.5 text-[10px] font-medium rounded-sm border transition-colors ${
              !activeSceneId || needsContract || isCreatingCrossfade || tracks.length + 2 > MAX_TRACKS
                ? 'bg-sas-panel border-sas-border text-sas-muted/50 cursor-not-allowed'
                : 'bg-sas-panel-alt border-sas-border text-sas-muted hover:border-sas-accent hover:text-sas-accent'
            }`}
            title="Crossfade an origin track into a target track over this transition"
          >
            + Crossfade
          </button>
        )}
      </div>
    );
    return () => { onHeaderContent(null); };
  }, [onHeaderContent, needsContract, isConnected, activeSceneId, tracks.length, isAddingTrack,
      handleAddTrack, onOpenContract, host, canCrossfade, isCreatingCrossfade, onExpandSelf]);

  // --- Push loading state to accordion header ---------------------------
  useEffect(() => {
    if (!onLoading) return;
    const anyGenerating = tracks.some((t: SynthTrackState) => t.isGenerating);
    onLoading(isLoadingTracks || anyGenerating || isBulkActive);
    return () => { onLoading(false); };
  }, [onLoading, isLoadingTracks, tracks, isBulkActive]);

  // --- Delete track -----------------------------------------------------
  const handleDeleteTrack = useCallback(async (trackId: string): Promise<void> => {
    try {
      await host.deleteTrack(trackId);
      // Clean up prompt from scene data (use stable DB UUID for key)
      const dbId = engineToDbIdRef.current.get(trackId) ?? trackId;
      if (activeSceneId) {
        await host.deleteSceneData(activeSceneId, `track:${dbId}:prompt`);
      }
      setTracks(prev => prev.filter(t => t.handle.id !== trackId));
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      host.showToast('error', 'Failed to delete track', msg);
    }
  }, [host, activeSceneId]);

  // --- Crossfade group controls -----------------------------------------
  // Mute/solo act on BOTH layers together (group); per-layer volume/pan reuse
  // the normal handlers (members are normal tracks in `tracks`). Delete removes
  // the whole pair + its scene-data keys.
  const handleCrossfadeMute = useCallback((pair: ResolvedCrossfadePair): void => {
    const newMuted = !pair.origin.runtimeState.muted;
    for (const id of [pair.origin.handle.id, pair.target.handle.id]) {
      setTracks(prev => prev.map(t => (t.handle.id === id ? { ...t, runtimeState: { ...t.runtimeState, muted: newMuted } } : t)));
      host.setTrackMute(id, newMuted).catch(() => {});
    }
  }, [host]);

  const handleCrossfadeSolo = useCallback((pair: ResolvedCrossfadePair): void => {
    const newSolo = !pair.origin.runtimeState.solo;
    for (const id of [pair.origin.handle.id, pair.target.handle.id]) {
      setTracks(prev => prev.map(t => (t.handle.id === id ? { ...t, runtimeState: { ...t.runtimeState, solo: newSolo } } : t)));
      host.setTrackSolo(id, newSolo).catch(() => {});
    }
  }, [host]);

  const handleCrossfadeDelete = useCallback(async (pair: ResolvedCrossfadePair): Promise<void> => {
    try {
      for (const member of [pair.origin, pair.target]) {
        await host.deleteTrack(member.handle.id);
        if (activeSceneId) await host.deleteSceneData(activeSceneId, `track:${member.handle.dbId}:crossfade`);
      }
      setCrossfadePairsMeta(prev => prev.filter(p => p.groupId !== pair.groupId));
      setTracks(prev => prev.filter(t => t.handle.id !== pair.origin.handle.id && t.handle.id !== pair.target.handle.id));
      host.showToast('success', 'Crossfade removed');
    } catch (err: unknown) {
      host.showToast('error', 'Failed to delete crossfade', err instanceof Error ? err.message : String(err));
    }
  }, [host, activeSceneId]);

  // --- Update prompt (debounced save) -----------------------------------
  const handlePromptChange = useCallback((trackId: string, prompt: string): void => {
    setTracks(prev => prev.map(t =>
      t.handle.id === trackId ? { ...t, prompt } : t
    ));

    // Debounced save to scene data (use stable DB UUID for key)
    const dbId = engineToDbIdRef.current.get(trackId) ?? trackId;
    if (saveTimeoutRefs.current[trackId]) {
      clearTimeout(saveTimeoutRefs.current[trackId]);
    }
    saveTimeoutRefs.current[trackId] = setTimeout(() => {
      if (activeSceneId) {
        host.setSceneData(activeSceneId, `track:${dbId}:prompt`, prompt).catch(() => {});
      }
    }, 500);
  }, [host, activeSceneId]);

  // --- Generate MIDI ----------------------------------------------------
  const handleGenerate = useCallback(async (trackId: string): Promise<void> => {
    const track = tracks.find(t => t.handle.id === trackId);
    if (!track || !track.prompt.trim()) return;
    if (!isAuthenticated) {
      host.showToast('warning', 'Sign In Required', 'Please sign in to generate MIDI');
      return;
    }

    setTracks(prev => prev.map(t =>
      t.handle.id === trackId ? { ...t, isGenerating: true, error: null, generationProgress: 0 } : t
    ));

    try {
      // 1. Get musical context (for clip timing calculations)
      const musicalContext = await host.getMusicalContext();

      // 2. Get generation context (excludes this track)
      const generationContext = await host.getGenerationContext(trackId);

      // 3. Classify preset category from the prompt
      const presetCategory = await host.classifyPresetCategory(track.prompt);

      // 4. Build user prompt (musical context + scene contract auto-prefixed by SDK).
      // The SDK helper renders other tracks' role + prompt + raw MIDI
      // notes-by-chord, so the LLM sees the full scene state. Empty when
      // no other tracks exist — skip the heading rather than emit
      // "(none yet)" noise.
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

      // 5. Call LLM (SDK auto-prefixes musical context)
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

      // Mute newly generated tracks by default — user explicitly asked for
      // this so fresh generations don't blast out while the user is still
      // setting up the next track. The M button in TrackRow reflects the
      // state; clicking it un-mutes when the user is ready to audition.
      // Optimistic local update so the UI doesn't wait for the
      // trackStateChanged event to round-trip from the engine.
      await host.setTrackMute(trackId, true).catch(() => {});
      setTracks(prev => prev.map(t =>
        t.handle.id === trackId
          ? { ...t, runtimeState: { ...t.runtimeState, muted: true } }
          : t
      ));

      // Store role in scene data for shuffle/duplicate to use (stable DB UUID key)
      const genDbId = engineToDbIdRef.current.get(trackId) ?? trackId;
      const newRole = parsed.role ?? track.role;
      if (activeSceneId && newRole) {
        host.setSceneData(activeSceneId, `track:${genDbId}:role`, newRole).catch(() => {});
      }

      // Persist the role to tracks.role so the v1 transition generator's
      // layer classifier can see it. Without this, plugin-created synth
      // tracks ship as role=NULL, classify as harmonic_unknown, and drop
      // out of the transition chop catalog — transitions silently omit
      // the layer.
      if (newRole && newRole !== track.role) {
        try {
          await host.setTrackRole(trackId, newRole);
        } catch (err) {
          // Non-fatal — MIDI is already written. A follow-up backfill or
          // manual re-generation can populate role later.
          console.warn('[SynthGeneratorPanel] setTrackRole failed:', err);
        }
      }

      // Apply a matching preset based on the role + MIDI notes
      // Without this, the track keeps the default Surge XT init patch.
      // Skip for custom instruments — user chose their sound, don't overwrite it.
      if (!track.instrumentPluginId) {
        try {
          await host.shufflePreset(trackId);
        } catch {
          // Non-fatal — track still has MIDI, just default preset
        }
      }

      // Update state on success. Seed the piano-roll edit buffer with the
      // freshly generated notes so opening the Edit tab needs no round-trip,
      // and mark the track loaded so the tab doesn't re-fetch over them.
      setTracks(prev => prev.map(t =>
        t.handle.id === trackId
          ? {
              ...t,
              isGenerating: false,
              error: null,
              role: newRole,
              hasMidi: true,
              generationProgress: 0,
              editNotes: processedNotes,
              editBars: musicalContext.bars,
              editBpm: musicalContext.bpm,
            }
          : t
      ));
      editLoadStartedRef.current.add(trackId);
      // Fresh baseline — clear history; the next shuffle lazy-seeds this preset.
      soundHistory.clear(trackId);
      host.showToast('success', 'MIDI generated');
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Generation failed';
      setTracks(prev => prev.map(t =>
        t.handle.id === trackId ? { ...t, isGenerating: false, error: msg, generationProgress: 0 } : t
      ));
      host.showToast('error', 'Generation failed', msg);
    }
  }, [host, tracks, isAuthenticated, activeSceneId, soundHistory]);

  // --- Mute/Solo/Volume/Pan -----------------------------------------------
  const handleMuteToggle = useCallback((trackId: string): void => {
    const track = tracks.find(t => t.handle.id === trackId);
    if (!track) return;
    const newMuted = !track.runtimeState.muted;
    // Optimistic update
    setTracks(prev => prev.map(t =>
      t.handle.id === trackId ? { ...t, runtimeState: { ...t.runtimeState, muted: newMuted } } : t
    ));
    host.setTrackMute(trackId, newMuted).catch(() => {
      setTracks(prev => prev.map(t =>
        t.handle.id === trackId ? { ...t, runtimeState: { ...t.runtimeState, muted: !newMuted } } : t
      ));
    });
  }, [host, tracks]);

  const handleSoloToggle = useCallback((trackId: string): void => {
    const track = tracks.find(t => t.handle.id === trackId);
    if (!track) return;
    const newSolo = !track.runtimeState.solo;
    setTracks(prev => prev.map(t =>
      t.handle.id === trackId ? { ...t, runtimeState: { ...t.runtimeState, solo: newSolo } } : t
    ));
    host.setTrackSolo(trackId, newSolo).catch(() => {
      setTracks(prev => prev.map(t =>
        t.handle.id === trackId ? { ...t, runtimeState: { ...t.runtimeState, solo: !newSolo } } : t
      ));
    });
  }, [host, tracks]);

  const handleVolumeChange = useCallback((trackId: string, volume: number): void => {
    setTracks(prev => prev.map(t =>
      t.handle.id === trackId ? { ...t, runtimeState: { ...t.runtimeState, volume } } : t
    ));
    host.setTrackVolume(trackId, volume).catch(() => {});
  }, [host]);

  const handlePanChange = useCallback((trackId: string, pan: number): void => {
    setTracks(prev => prev.map(t =>
      t.handle.id === trackId ? { ...t, runtimeState: { ...t.runtimeState, pan } } : t
    ));
    host.setTrackPan(trackId, pan).catch(() => {});
  }, [host]);

  // --- Shuffle preset (keep MIDI, new sound) ----------------------------
  // Cycle pattern: each track maintains a shuffleHistory Set of preset
  // names already tried. We hand it to host.shufflePreset as excludeNames;
  // when the category pool is exhausted the host throws "No presets
  // available", we wipe the history and retry. After a successful pick
  // the returned preset name is added to the (possibly fresh) history.
  const handleShuffle = useCallback(async (trackId: string): Promise<void> => {
    const track = tracks.find(t => t.handle.id === trackId);
    if (!track) return;
    // Lazy-seed: capture the pre-shuffle preset on the first shuffle so undo
    // can return to it (cheaper than a getPluginState sweep on scene load).
    if (soundHistory.list(trackId).entries.length === 0) {
      await captureSynthSound(trackId, 'Previous preset');
    }
    try {
      let result;
      let nextHistory: Set<string>;
      try {
        result = await host.shufflePreset(trackId, Array.from(track.shuffleHistory));
        nextHistory = new Set(track.shuffleHistory);
      } catch (firstErr: unknown) {
        // Distinguish "exhausted" (expected, retry with fresh deck) from
        // other failures (Surge missing, network, etc — surface to user).
        const msg = firstErr instanceof Error ? firstErr.message : String(firstErr);
        if (/no presets available/i.test(msg)) {
          // Cycle complete — reset history and try again with empty exclude.
          nextHistory = new Set<string>();
          result = await host.shufflePreset(trackId, []);
        } else {
          throw firstErr;
        }
      }
      nextHistory.add(result.presetName);
      setTracks(prev => prev.map(t =>
        t.handle.id === trackId ? { ...t, shuffleHistory: nextHistory } : t
      ));
      // Record the new preset so the ↩ back-arrow + History tab can return to it.
      await captureSynthSound(trackId, result.presetName);
      console.log(
        `[SynthGenerator] Preset shuffled: ${result.presetName} (history ${nextHistory.size})`
      );
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Shuffle failed';
      host.showToast('error', 'Shuffle failed', msg);
    }
  }, [host, tracks, soundHistory, captureSynthSound]);

  // --- Duplicate track (copy MIDI, new preset) --------------------------
  const handleCopy = useCallback(async (trackId: string): Promise<void> => {
    try {
      const newHandle = await host.duplicateTrack(trackId);
      // Reload tracks to pick up the new one with full state
      await loadTracks();
      host.showToast('success', 'Track duplicated', newHandle.name);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Copy failed';
      host.showToast('error', 'Copy failed', msg);
    }
  }, [host, loadTracks]);

  // --- FX Operations (optimistic UI) ------------------------------------
  const handleFxToggle = useCallback((trackId: string, category: FxCategory, enabled: boolean): void => {
    setTracks(prev => prev.map(t =>
      t.handle.id === trackId
        ? { ...t, fxDetailState: { ...t.fxDetailState, [category]: { ...t.fxDetailState[category], enabled } } }
        : t
    ));
    host.toggleTrackFx(trackId, category, enabled).catch(() => {
      setTracks(prev => prev.map(t =>
        t.handle.id === trackId
          ? { ...t, fxDetailState: { ...t.fxDetailState, [category]: { ...t.fxDetailState[category], enabled: !enabled } } }
          : t
      ));
    });
  }, [host]);

  const handleFxPresetChange = useCallback((trackId: string, category: FxCategory, presetIndex: number): void => {
    setTracks(prev => prev.map(t =>
      t.handle.id === trackId
        ? { ...t, fxDetailState: { ...t.fxDetailState, [category]: { ...t.fxDetailState[category], presetIndex } } }
        : t
    ));
    host.setTrackFxPreset(trackId, category, presetIndex).then(result => {
      if (result.dryWet !== undefined) {
        setTracks(prev => prev.map(t =>
          t.handle.id === trackId
            ? { ...t, fxDetailState: { ...t.fxDetailState, [category]: { ...t.fxDetailState[category], dryWet: result.dryWet as number } } }
            : t
        ));
      }
    }).catch(() => {});
  }, [host]);

  const handleFxDryWetChange = useCallback((trackId: string, category: FxCategory, value: number): void => {
    setTracks(prev => prev.map(t =>
      t.handle.id === trackId
        ? { ...t, fxDetailState: { ...t.fxDetailState, [category]: { ...t.fxDetailState[category], dryWet: value } } }
        : t
    ));
    host.setTrackFxDryWet(trackId, category, value).catch(() => {});
  }, [host]);

  const toggleFxDrawer = useCallback((trackId: string): void => {
    setTracks(prev => prev.map(t => {
      if (t.handle.id !== trackId) return t;
      const onFx = t.drawerOpen && t.drawerTab === 'fx';
      return { ...t, drawerOpen: !onFx, drawerTab: 'fx', editorStage: false };
    }));
    // Refresh FX state from the engine whenever we OPEN the FX tab.
    const track = tracks.find(t => t.handle.id === trackId);
    const wasOnFx = !!track && track.drawerOpen && track.drawerTab === 'fx';
    if (track && !wasOnFx) {
      host.getTrackFxState(trackId).then(fxState => {
        setTracks(prev => prev.map(t =>
          t.handle.id === trackId ? { ...t, fxDetailState: pluginFxToToggleFx(fxState) } : t
        ));
      }).catch(() => {});
    }
  }, [host, tracks]);

  // --- Piano-roll edit: load + save ------------------------------------
  // LOAD: read the track's current MIDI back from the engine the first time
  // the Edit tab opens. Reads LIVE engine state (reflects unsaved generator
  // output). Degrades to an empty editor if the host predates readMidiNotes
  // (optional method) or the track has no clip. Also pulls bars/bpm so the
  // grid is sized correctly and re-saves preserve the loop span.
  const loadEditNotes = useCallback(async (trackId: string): Promise<void> => {
    try {
      const mc = await host.getMusicalContext();
      let notes: PluginMidiNote[] = [];
      if (typeof host.readMidiNotes === 'function') {
        const result = await host.readMidiNotes(trackId);
        notes = result.clips[0]?.notes ?? [];
      }
      setTracks(prev => prev.map(t =>
        t.handle.id === trackId
          ? { ...t, editNotes: notes, editBars: mc.bars, editBpm: mc.bpm }
          : t
      ));
    } catch (err: unknown) {
      console.warn('[SynthGeneratorPanel] Failed to load MIDI for editing:', err);
    }
  }, [host]);

  // SAVE: optimistic local update, then debounced (300 ms) persist so a burst
  // of drags/clicks coalesces into one writeMidiClip. Empty note arrays go
  // through clearMidi (writeMidiClip rejects empty MIDI as INVALID_MIDI).
  // Notes persist as quarter-note beats (tempo/span-independent) — the
  // endTime/tempo only set the clip's loop span. Stable ([host]) to avoid
  // re-subscribing the editor / triggering load loops.
  const handleNotesChange = useCallback((trackId: string, notes: PluginMidiNote[]): void => {
    setTracks(prev => prev.map(t =>
      t.handle.id === trackId ? { ...t, editNotes: notes } : t
    ));
    const key = `edit:${trackId}`;
    if (saveTimeoutRefs.current[key]) {
      clearTimeout(saveTimeoutRefs.current[key]);
    }
    saveTimeoutRefs.current[key] = setTimeout(() => {
      void (async (): Promise<void> => {
        try {
          if (notes.length === 0) {
            await host.clearMidi(trackId);
          } else {
            const mc = await host.getMusicalContext();
            await host.writeMidiClip(trackId, {
              startTime: 0,
              endTime: (mc.bars * 4 * 60) / mc.bpm,
              tempo: mc.bpm,
              notes,
            });
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          host.showToast('error', 'Failed to save edit', msg);
        }
      })();
    }, 300);
  }, [host]);

  // Tab-strip clicks: switch the active tab, keeping the drawer open. Refresh
  // FX state when entering FX; lazy-load instruments when entering Pick.
  const handleTabChange = useCallback((trackId: string, tab: DrawerTab): void => {
    setTracks(prev => prev.map(t =>
      t.handle.id === trackId ? { ...t, drawerOpen: true, drawerTab: tab } : t
    ));
    if (tab === 'fx') {
      host.getTrackFxState(trackId).then(fxState => {
        setTracks(prev => prev.map(t =>
          t.handle.id === trackId ? { ...t, fxDetailState: pluginFxToToggleFx(fxState) } : t
        ));
      }).catch(() => {});
    } else if (tab === 'pick' && availableInstruments.length === 0 && !instrumentsLoading) {
      // Lazy-load available instruments the first time the Pick tab is opened.
      setInstrumentsLoading(true);
      host.getAvailableInstruments().then((instruments: InstrumentDescriptor[]) => {
        setAvailableInstruments(instruments);
      }).catch(() => {}).finally(() => {
        setInstrumentsLoading(false);
      });
    } else if (tab === 'edit' && !editLoadStartedRef.current.has(trackId)) {
      // Lazy-load the track's MIDI the first time the Edit tab is opened.
      editLoadStartedRef.current.add(trackId);
      void loadEditNotes(trackId);
    }
  }, [host, availableInstruments.length, instrumentsLoading, loadEditNotes]);

  // --- Progress persistence callback ------------------------------------
  const handleProgressChange = useCallback((trackId: string, pct: number): void => {
    setTracks(prev => prev.map(t =>
      t.handle.id === trackId ? { ...t, generationProgress: pct } : t
    ));
  }, []);

  // --- Instrument selection callbacks ------------------------------------
  // The ▾ button opens the unified drawer to a non-FX tab (History by default;
  // the user reaches Pick / the plugin editor via the tab strip), or closes it.
  const handleToggleDrawer = useCallback((trackId: string): void => {
    setTracks(prev => prev.map((t: SynthTrackState) => {
      if (t.handle.id !== trackId) return t;
      const onSound = t.drawerOpen && t.drawerTab !== 'fx';
      return { ...t, drawerOpen: !onSound, drawerTab: 'history', editorStage: false };
    }));
  }, []);

  const handleInstrumentSelect = useCallback(async (trackId: string, pluginId: string): Promise<void> => {
    const isSurgeXt = pluginId === 'Surge XT';

    if (isSurgeXt) {
      // Revert to default — close drawer
      setTracks(prev => prev.map((t: SynthTrackState) =>
        t.handle.id === trackId ? { ...t, drawerOpen: false, editorStage: false } : t
      ));
      try {
        await host.setTrackInstrument(trackId, pluginId);
        const descriptor = await host.getTrackInstrument(trackId);
        setTracks(prev => prev.map((t: SynthTrackState) =>
          t.handle.id === trackId
            ? {
                ...t,
                instrumentPluginId: descriptor?.pluginId ?? null,
                instrumentName: descriptor?.name ?? null,
                instrumentMissing: descriptor?.missing ?? false,
              }
            : t
        ));
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Failed to load instrument';
        host.showToast('error', 'Instrument load failed', msg);
      }
      return;
    }

    // Custom instrument — load it, then transition to the editor stage of the Pick tab
    setTracks(prev => prev.map((t: SynthTrackState) =>
      t.handle.id === trackId ? { ...t, drawerTab: 'pick', editorStage: true } : t
    ));

    try {
      await host.setTrackInstrument(trackId, pluginId);
      const descriptor = await host.getTrackInstrument(trackId);
      setTracks(prev => prev.map((t: SynthTrackState) =>
        t.handle.id === trackId
          ? {
              ...t,
              instrumentPluginId: descriptor?.pluginId ?? null,
              instrumentName: descriptor?.name ?? null,
              instrumentMissing: descriptor?.missing ?? false,
            }
          : t
      ));

    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to load instrument';
      console.error('[SynthGeneratorPanel] Failed to set instrument:', err);
      host.showToast('error', 'Instrument load failed', msg);
      // Revert to the instrument grid on failure
      setTracks(prev => prev.map((t: SynthTrackState) =>
        t.handle.id === trackId ? { ...t, editorStage: false } : t
      ));
    }
  }, [host]);

  const handleShowEditor = useCallback(async (trackId: string): Promise<void> => {
    try {
      await host.showInstrumentEditor(trackId);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to open editor';
      host.showToast('error', 'Editor failed', msg);
    }
  }, [host]);

  const handleBackToInstruments = useCallback((trackId: string): void => {
    setTracks(prev => prev.map((t: SynthTrackState) =>
      t.handle.id === trackId ? { ...t, editorStage: false } : t
    ));
  }, []);

  const handleRefreshInstruments = useCallback((): void => {
    setInstrumentsLoading(true);
    host.getAvailableInstruments().then((instruments: InstrumentDescriptor[]) => {
      setAvailableInstruments(instruments);
    }).catch(() => {}).finally(() => {
      setInstrumentsLoading(false);
    });
  }, [host]);

  // Resolve crossfade pairs against live track state. Only COMPLETE pairs (both
  // members present in `tracks`) group into a CrossfadeTrackRow; a half-broken
  // pair's surviving member is left to render as a normal row (not excluded).
  const { resolvedCrossfadePairs, crossfadeMemberDbIds } = useMemo(() => {
    const byDbId = new Map(tracks.map((t) => [t.handle.dbId, t]));
    const pairs: ResolvedCrossfadePair[] = [];
    const members = new Set<string>();
    for (const p of crossfadePairsMeta) {
      const origin = byDbId.get(p.originDbId);
      const target = byDbId.get(p.targetDbId);
      if (origin && target) {
        pairs.push({ ...p, origin, target });
        members.add(p.originDbId);
        members.add(p.targetDbId);
      }
    }
    return { resolvedCrossfadePairs: pairs, crossfadeMemberDbIds: members };
  }, [tracks, crossfadePairsMeta]);

  // --- Render -----------------------------------------------------------

  // No scene selected
  if (!activeSceneId) {
    return (
      <div data-testid="no-scene-placeholder-synth" className="flex items-center justify-center py-8">
        <button
          onClick={() => onSelectScene?.()}
          className="text-sas-muted text-xs hover:text-sas-accent transition-colors underline underline-offset-2"
        >
          Select a Scene
        </button>
      </div>
    );
  }

  // Scene selected but no contract generated yet — contract is required
  // before any track operations (add or compose).
  if (!sceneContext?.hasContract) {
    return (
      <div data-testid="no-contract-placeholder-synth" className="flex items-center justify-center py-8">
        <button
          onClick={() => onOpenContract?.()}
          className="text-sas-muted text-xs hover:text-sas-accent transition-colors underline underline-offset-2"
        >
          Generate a Contract
        </button>
      </div>
    );
  }

  // Phase 1: COMPOSING — single progress bar during LLM planning
  if (isComposing) {
    return (
      <div data-testid="synth-section" className="p-2">
        <SorceryProgressBar isLoading={true} statusText="COMPOSING..." heightClass="h-10" />
      </div>
    );
  }

  // Phase 2: HYBRID — completed tracks show full TrackRow, in-progress show progress bars
  const activePlaceholders = placeholders;
  if (activePlaceholders.length > 0) {
    // Build lookup from DB ID → loaded track state for completed tracks
    const tracksByDbId = new Map<string, SynthTrackState>();
    for (const t of tracks) {
      tracksByDbId.set(t.handle.dbId, t);
      if (t.handle.id !== t.handle.dbId) {
        tracksByDbId.set(t.handle.id, t);
      }
    }

    return (
      <div data-testid="synth-section" className="p-2 space-y-2">
        {activePlaceholders.map((ph: BulkAddPlaceholderTrack) => {
          const loadedTrack = ph.status === 'completed' ? tracksByDbId.get(ph.id) : undefined;

          // Completed AND loaded → full TrackRow UI
          if (loadedTrack) {
            return (
              <TrackRow
                key={ph.id}
                track={{ id: loadedTrack.handle.id, name: loadedTrack.handle.name, role: loadedTrack.role }}
                levels={supportsMeters ? trackLevels : undefined}
                prompt={loadedTrack.prompt}
                runtimeState={{
                  muted: loadedTrack.runtimeState.muted,
                  solo: loadedTrack.runtimeState.solo,
                  volume: loadedTrack.runtimeState.volume,
                  pan: loadedTrack.runtimeState.pan,
                }}
                soloedOut={anySolo && !loadedTrack.runtimeState.solo}
                fxDetailState={loadedTrack.fxDetailState}
                drawerOpen={loadedTrack.drawerOpen}
                drawerTab={loadedTrack.drawerTab}
                onTabChange={(tab) => handleTabChange(loadedTrack.handle.id, tab)}
                isGenerating={loadedTrack.isGenerating}
                isAuthenticated={isAuthenticated}
                error={loadedTrack.error}
                hasMidi={loadedTrack.hasMidi}
                generationProgress={loadedTrack.generationProgress}
                estimatedGenerationMs={ESTIMATED_GENERATION_MS}
                onPromptChange={(prompt: string) => handlePromptChange(loadedTrack.handle.id, prompt)}
                onGenerate={() => handleGenerate(loadedTrack.handle.id)}
                onShuffle={() => handleShuffle(loadedTrack.handle.id)}
                onCopy={() => handleCopy(loadedTrack.handle.id)}
                onDelete={() => handleDeleteTrack(loadedTrack.handle.id)}
                onMuteToggle={() => handleMuteToggle(loadedTrack.handle.id)}
                onSoloToggle={() => handleSoloToggle(loadedTrack.handle.id)}
                onVolumeChange={(vol: number) => handleVolumeChange(loadedTrack.handle.id, vol)}
                onPanChange={(pan: number) => handlePanChange(loadedTrack.handle.id, pan)}
                onFxToggle={(cat: FxCategory, enabled: boolean) => handleFxToggle(loadedTrack.handle.id, cat, enabled)}
                onFxPresetChange={(cat: FxCategory, idx: number) => handleFxPresetChange(loadedTrack.handle.id, cat, idx)}
                onFxDryWetChange={(cat: FxCategory, val: number) => handleFxDryWetChange(loadedTrack.handle.id, cat, val)}
                onToggleFxDrawer={() => toggleFxDrawer(loadedTrack.handle.id)}
                onProgressChange={(pct: number) => handleProgressChange(loadedTrack.handle.id, pct)}
                accentColor="#A78BFA"
                instrumentName={loadedTrack.instrumentName}
                instrumentMissing={loadedTrack.instrumentMissing}
                onToggleDrawer={() => handleToggleDrawer(loadedTrack.handle.id)}
                availableInstruments={availableInstruments}
                currentInstrumentPluginId={loadedTrack.instrumentPluginId}
                onInstrumentSelect={(pluginId: string) => handleInstrumentSelect(loadedTrack.handle.id, pluginId)}
                instrumentsLoading={instrumentsLoading}
                onRefreshInstruments={handleRefreshInstruments}
                editorStage={loadedTrack.editorStage}
                onShowEditor={() => handleShowEditor(loadedTrack.handle.id)}
                onBackToInstruments={() => handleBackToInstruments(loadedTrack.handle.id)}
                soundHistory={soundHistory.list(loadedTrack.handle.id).entries}
                soundHistoryCursor={soundHistory.list(loadedTrack.handle.id).cursor}
                onRestoreSound={(i: number) => { void soundHistory.restoreTo(loadedTrack.handle.id, i); }}
                onToggleFavorite={(i: number) => soundHistory.toggleFavorite(loadedTrack.handle.id, i)}
                onImportSound={() => setSoundImportTarget(loadedTrack)}
                importSoundLabel="Import Preset"
                editNotes={loadedTrack.editNotes}
                onNotesChange={(notes) => handleNotesChange(loadedTrack.handle.id, notes)}
                editBars={loadedTrack.editBars}
                editBpm={loadedTrack.editBpm}
                editSnap={0.25}
                onAuditionNote={(pitch, vel, ms) => { void host.auditionNote(loadedTrack.handle.id, pitch, vel, ms); }}
              />
            );
          }

          // In-progress, planned, failed, or completed-but-not-yet-loaded → progress bar
          return (
            <div key={ph.id} data-testid="bulk-placeholder-track"
                 className="relative rounded-sm border w-full overflow-hidden border-sas-border bg-sas-panel-alt"
                 style={{ borderLeftColor: '#3B82F6', borderLeftWidth: '3px' }}>
              <SorceryProgressBar
                isLoading={true}
                statusText="CONJURING MIDI..."
                heightClass="h-10"
              />
            </div>
          );
        })}
      </div>
    );
  }

  // Phase 3: NORMAL — real tracks using SDK TrackRow
  return (
    <div data-testid="synth-section" className="p-2 space-y-2">
      {host.listImportableTracks && (
        <ImportTrackModal
          host={host}
          open={importOpen}
          onClose={() => setImportOpen(false)}
          onImported={() => { void loadTracks(true); }}
          onPortTrack={host.readImportableTrackMidi ? handlePortTrack : undefined}
          testIdPrefix="synth-import"
        />
      )}
      {host.listImportableTracks && host.getTrackSound && (
        <ImportTrackModal
          host={host}
          mode="sound"
          open={!!soundImportTarget}
          title="Import Preset"
          onClose={() => setSoundImportTarget(null)}
          onImported={() => {}}
          onPick={handleSoundImportPick}
          testIdPrefix="synth-sound-import"
        />
      )}
      {canCrossfade && xfFromId && xfToId && (
        <CrossfadeModal
          host={host}
          open={crossfadeOpen}
          fromSceneId={xfFromId}
          toSceneId={xfToId}
          onClose={() => setCrossfadeOpen(false)}
          onCreate={handleCreateCrossfade}
          testIdPrefix="synth-crossfade"
        />
      )}
      {isLoadingTracks ? (
        <div className="text-sas-muted text-xs text-center py-4">Loading tracks...</div>
      ) : (
        <>
          {resolvedCrossfadePairs.map((pair) => (
            <CrossfadeTrackRow
              key={pair.groupId}
              accentColor="#9333EA"
              levels={supportsMeters ? trackLevels : undefined}
              sliderPos={pair.sliderPos}
              origin={{
                trackId: pair.origin.handle.id,
                name: pair.origin.handle.name,
                role: pair.origin.role,
                sourceName: pair.originSourceName,
                soundLabel: pair.originSoundLabel,
                runtimeState: pair.origin.runtimeState,
              }}
              target={{
                trackId: pair.target.handle.id,
                name: pair.target.handle.name,
                role: pair.target.role,
                sourceName: pair.targetSourceName,
                soundLabel: pair.targetSoundLabel,
                runtimeState: pair.target.runtimeState,
              }}
              onMuteToggle={() => handleCrossfadeMute(pair)}
              onSoloToggle={() => handleCrossfadeSolo(pair)}
              onVolumeChange={(slot: CrossfadeSlot, vol: number) =>
                handleVolumeChange(slot === 'origin' ? pair.origin.handle.id : pair.target.handle.id, vol)
              }
              onPanChange={(slot: CrossfadeSlot, pan: number) =>
                handlePanChange(slot === 'origin' ? pair.origin.handle.id : pair.target.handle.id, pan)
              }
              onDelete={() => handleCrossfadeDelete(pair)}
            />
          ))}
          {tracks.map((track: SynthTrackState, index: number) => {
            if (crossfadeMemberDbIds.has(track.handle.dbId)) return null;
            return (
          <TrackRow
            key={track.handle.id}
            drag={reorder.dragPropsFor(index)}
            track={{ id: track.handle.id, name: track.handle.name, role: track.role }}
            levels={supportsMeters ? trackLevels : undefined}
            prompt={track.prompt}
            runtimeState={{
              muted: track.runtimeState.muted,
              solo: track.runtimeState.solo,
              volume: track.runtimeState.volume,
              pan: track.runtimeState.pan,
            }}
            soloedOut={anySolo && !track.runtimeState.solo}
            fxDetailState={track.fxDetailState}
            drawerOpen={track.drawerOpen}
            drawerTab={track.drawerTab}
            onTabChange={(tab) => handleTabChange(track.handle.id, tab)}
            isGenerating={track.isGenerating}
            isAuthenticated={isAuthenticated}
            error={track.error}
            hasMidi={track.hasMidi}
            generationProgress={track.generationProgress}
            estimatedGenerationMs={ESTIMATED_GENERATION_MS}
            onPromptChange={(prompt: string) => handlePromptChange(track.handle.id, prompt)}
            onGenerate={() => handleGenerate(track.handle.id)}
            onShuffle={() => handleShuffle(track.handle.id)}
            onCopy={() => handleCopy(track.handle.id)}
            onDelete={() => handleDeleteTrack(track.handle.id)}
            onMuteToggle={() => handleMuteToggle(track.handle.id)}
            onSoloToggle={() => handleSoloToggle(track.handle.id)}
            onVolumeChange={(vol: number) => handleVolumeChange(track.handle.id, vol)}
            onPanChange={(pan: number) => handlePanChange(track.handle.id, pan)}
            onFxToggle={(cat: FxCategory, enabled: boolean) => handleFxToggle(track.handle.id, cat, enabled)}
            onFxPresetChange={(cat: FxCategory, idx: number) => handleFxPresetChange(track.handle.id, cat, idx)}
            onFxDryWetChange={(cat: FxCategory, val: number) => handleFxDryWetChange(track.handle.id, cat, val)}
            onToggleFxDrawer={() => toggleFxDrawer(track.handle.id)}
            onProgressChange={(pct: number) => handleProgressChange(track.handle.id, pct)}
            accentColor="#A78BFA"
            instrumentName={track.instrumentName}
            instrumentMissing={track.instrumentMissing}
            onToggleDrawer={() => handleToggleDrawer(track.handle.id)}
            availableInstruments={availableInstruments}
            currentInstrumentPluginId={track.instrumentPluginId}
            onInstrumentSelect={(pluginId: string) => handleInstrumentSelect(track.handle.id, pluginId)}
            instrumentsLoading={instrumentsLoading}
            onRefreshInstruments={handleRefreshInstruments}
            editorStage={track.editorStage}
            onShowEditor={() => handleShowEditor(track.handle.id)}
            onBackToInstruments={() => handleBackToInstruments(track.handle.id)}
            soundHistory={soundHistory.list(track.handle.id).entries}
            soundHistoryCursor={soundHistory.list(track.handle.id).cursor}
            onRestoreSound={(i: number) => { void soundHistory.restoreTo(track.handle.id, i); }}
            onToggleFavorite={(i: number) => soundHistory.toggleFavorite(track.handle.id, i)}
            onImportSound={() => setSoundImportTarget(track)}
            importSoundLabel="Import Preset"
            editNotes={track.editNotes}
            onNotesChange={(notes) => handleNotesChange(track.handle.id, notes)}
            editBars={track.editBars}
            editBpm={track.editBpm}
            editSnap={0.25}
            onAuditionNote={(pitch, vel, ms) => { void host.auditionNote(track.handle.id, pitch, vel, ms); }}
          />
            );
          })}
        </>
      )}

      {/* Export Tracks — bundle all synth tracks' MIDI as a ZIP */}
      {!isLoadingTracks && tracks.length > 0 && (() => {
        const hasAnyMidi = tracks.some(t => t.hasMidi);
        const exportDisabled = isExportingMidi || !hasAnyMidi;
        return (
          <div className="pt-2">
            <button
              data-testid="export-midi-tracks-button"
              onClick={handleExportMidi}
              disabled={exportDisabled}
              title={
                isExportingMidi
                  ? 'Exporting...'
                  : !hasAnyMidi
                    ? 'Generate MIDI on at least one track first'
                    : 'Export all tracks as a ZIP of .mid files'
              }
              className={`w-full px-2 py-1.5 text-[10px] uppercase tracking-wide rounded-sm border transition-colors ${
                exportDisabled
                  ? 'text-sas-muted/40 border-transparent hover:border-sas-accent cursor-not-allowed'
                  : 'text-sas-muted hover:text-sas-accent border-sas-border hover:border-sas-accent'
              }`}
            >
              {isExportingMidi ? 'Exporting...' : 'Export Tracks'}
            </button>
          </div>
        );
      })()}
    </div>
  );
}

// ============================================================================
// Helpers
// ============================================================================

/** Convert SDK PluginTrackFxDetailState to the FxToggleBar's expected TrackFxDetailState */
function pluginFxToToggleFx(sdkState: PluginTrackFxDetailState): TrackFxDetailState {
  const result = { ...EMPTY_FX_DETAIL_STATE };
  for (const category of ['eq', 'compressor', 'chorus', 'phaser', 'delay', 'reverb'] as const) {
    const sdkCat = sdkState[category] as PluginFxCategoryDetailState | undefined;
    if (sdkCat) {
      result[category] = {
        enabled: sdkCat.enabled,
        presetIndex: sdkCat.presetIndex,
        dryWet: sdkCat.dryWet,
      };
    }
  }
  return result;
}

/** Parse the LLM JSON response and extract valid MIDI notes */
function parseLLMNoteResponse(content: string): LLMNoteResponse | null {
  try {
    // Try to extract JSON from the response (handle markdown code fences)
    let jsonStr = content.trim();
    const fenceMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
    if (fenceMatch) {
      jsonStr = fenceMatch[1].trim();
    }

    const parsed: unknown = JSON.parse(jsonStr);
    if (typeof parsed !== 'object' || parsed === null || !('notes' in parsed)) {
      return null;
    }

    const obj = parsed as Record<string, unknown>;
    if (!Array.isArray(obj.notes)) {
      return null;
    }

    const validNotes: PluginMidiNote[] = [];
    for (const raw of obj.notes) {
      if (typeof raw !== 'object' || raw === null) continue;
      const note = raw as Record<string, unknown>;

      const pitch = typeof note.pitch === 'number' ? note.pitch : NaN;
      const startBeat = typeof note.startBeat === 'number' ? note.startBeat : NaN;
      const durationBeats = typeof note.durationBeats === 'number' ? note.durationBeats : NaN;
      const velocity = typeof note.velocity === 'number' ? note.velocity : NaN;

      if (
        !isNaN(pitch) && pitch >= 0 && pitch <= 127 &&
        !isNaN(startBeat) && startBeat >= 0 &&
        !isNaN(durationBeats) && durationBeats > 0 &&
        !isNaN(velocity) && velocity >= 1 && velocity <= 127
      ) {
        validNotes.push({
          pitch: Math.round(pitch),
          startBeat,
          durationBeats,
          velocity: Math.round(velocity),
        });
      }
    }

    const role = typeof obj.role === 'string' ? obj.role : undefined;

    return { notes: validNotes, role };
  } catch {
    return null;
  }
}

export default SynthGeneratorPanel;
