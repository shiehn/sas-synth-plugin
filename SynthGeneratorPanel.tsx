/**
 * SynthGeneratorPanel — Real UI for the @signalsandsorcery/synth-generator plugin
 *
 * Renders the synth track list with prompt input, MIDI generation,
 * and track controls. Uses ONLY PluginHost SDK methods — no EngineContext,
 * no window.electronAPI, no injected compose props.
 *
 * Delegates all track UI rendering to the reusable SDK TrackRow component.
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
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
import { TrackRow, useSceneState, SorceryProgressBar, VALID_INSTRUMENT_ROLES, EMPTY_FX_DETAIL_STATE } from '@signalsandsorcery/plugin-sdk';

// ============================================================================
// Constants
// ============================================================================

const MAX_TRACKS = 16;
const ESTIMATED_GENERATION_MS = 15000;
const EMPTY_PLACEHOLDERS: BulkAddPlaceholderTrack[] = [];

const MIDI_SYSTEM_PROMPT = `You are a MIDI composition AI. Given a musical context and text description, generate MIDI notes.

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
- role: instrument role — MUST be one of: ${VALID_INSTRUMENT_ROLES.join(', ')}`;

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
  fxDrawerOpen: boolean;
  isGenerating: boolean;
  error: string | null;
  hasMidi: boolean;
  generationProgress: number;
  instrumentPluginId: string | null;
  instrumentName: string | null;
  instrumentMissing: boolean;
  instrumentDrawerOpen: boolean;
  instrumentDrawerStage: 'instruments' | 'editor';
}

/** Shape of the parsed LLM JSON response */
interface LLMNoteResponse {
  notes: PluginMidiNote[];
  role?: string;
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
  const [tracks, setTracks] = useState<SynthTrackState[]>([]);
  const [isLoadingTracks, setIsLoadingTracks] = useState(false);
  // Scene-keyed compose state: preserved when switching scenes via SDK hook
  const [isComposing, , setIsComposingForScene] = useSceneState(activeSceneId, false);
  const [placeholders, , setPlaceholdersForScene] = useSceneState<BulkAddPlaceholderTrack[]>(activeSceneId, EMPTY_PLACEHOLDERS);
  const saveTimeoutRefs = useRef<Record<string, NodeJS.Timeout>>({});
  const [availableInstruments, setAvailableInstruments] = useState<InstrumentDescriptor[]>([]);
  const [instrumentsLoading, setInstrumentsLoading] = useState(false);
  /** Maps engine track ID → stable DB UUID for plugin_data key construction */
  const engineToDbIdRef = useRef<Map<string, string>>(new Map());

  // --- Load tracks when scene changes -----------------------------------
  const loadTracks = useCallback(async (incremental = false): Promise<void> => {
    if (!activeSceneId) {
      setTracks([]);
      return;
    }

    // Only show "Loading tracks..." when there are no tracks yet (initial load).
    // Incremental reloads (re-adoption, bulk completion) keep existing tracks visible.
    if (!incremental) setIsLoadingTracks(true);
    try {
      await host.adoptSceneTracks();
      const handles = await host.getPluginTracks();
      const sceneData = await host.getAllSceneData(activeSceneId) as Record<string, unknown>;

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
          // Backfill into plugin_data so future loads find it directly
          if (activeSceneId) {
            host.setSceneData(activeSceneId, promptKey, prompt).catch(() => {});
          }
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
          fxDrawerOpen: false,
          isGenerating: false,
          error: null,
          hasMidi,
          generationProgress: 0,
          instrumentPluginId: handle.instrumentPluginId ?? null,
          instrumentName: handle.instrumentName ?? null,
          instrumentMissing,
          instrumentDrawerOpen: false,
          instrumentDrawerStage: 'instruments',
        });
      }
      setTracks(trackStates);
    } catch (error: unknown) {
      console.error('[SynthGeneratorPanel] Failed to load tracks:', error);
    } finally {
      setIsLoadingTracks(false);
    }
  }, [host, activeSceneId]);

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
  const handleAddTrack = useCallback(async (): Promise<void> => {
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
        fxDrawerOpen: false,
        isGenerating: false,
        error: null,
        hasMidi: false,
        generationProgress: 0,
        instrumentPluginId: null,
        instrumentName: null,
        instrumentMissing: false,
        instrumentDrawerOpen: false,
        instrumentDrawerStage: 'instruments',
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
    }
  }, [host, activeSceneId, isConnected, isAuthenticated, tracks.length, onExpandSelf]);

  // --- Compose (bulk add) -----------------------------------------------
  const handleCompose = useCallback(async (): Promise<void> => {
    if (!activeSceneId) return;
    const composeForScene = activeSceneId;
    // Immediately show progress bar + disable button (don't rely on IPC events)
    setIsComposingForScene(composeForScene, true);
    setPlaceholdersForScene(composeForScene, []);
    try {
      const contractPrompt = sceneContext?.contractPrompt || '';
      const genre = sceneContext?.genre || null;
      await host.composeScene({ contractPrompt, genre });
      await host.adoptSceneTracks();
      await loadTracks();
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Composition failed';
      host.showToast('error', 'Compose failed', msg);
    } finally {
      // Reset composing state for THIS scene (IPC events may have already done this, but be safe)
      setIsComposingForScene(composeForScene, false);
      setPlaceholdersForScene(composeForScene, EMPTY_PLACEHOLDERS);
    }
  }, [host, activeSceneId, sceneContext, loadTracks, setIsComposingForScene, setPlaceholdersForScene]);

  // --- Push header content (Compose + Add buttons) to accordion header ---
  const isBulkActive = !!(isComposing || placeholders.length > 0);
  const needsContract = !sceneContext?.hasContract;
  useEffect(() => {
    if (!onHeaderContent) return;
    const addDisabled = needsContract || !isConnected || !activeSceneId || tracks.length >= MAX_TRACKS;
    const canCompose = !!(
      isAuthenticated &&
      sceneContext?.hasContract &&
      !sceneContext.hasTracks &&
      tracks.length === 0 &&
      !isBulkActive
    );
    const composeDisabled = needsContract || !canCompose || isBulkActive;

    onHeaderContent(
      <div className="flex gap-1">
        <button
          data-testid="bulk-add-button"
          onClick={(e: React.MouseEvent) => {
            e.stopPropagation();
            if (needsContract) { onOpenContract?.(); return; }
            handleCompose();
          }}
          className={`px-2 py-0.5 text-[10px] uppercase tracking-wide rounded-sm border transition-colors ${
            composeDisabled
              ? 'text-sas-muted/50 border-sas-border/50 cursor-not-allowed'
              : 'text-sas-muted hover:text-sas-accent border-sas-border hover:border-sas-accent'
          }`}
          title={needsContract ? 'Generate a contract first' : sceneContext?.hasTracks ? 'Scene already has tracks' : 'Generate a full arrangement'}
        >
          Compose
        </button>
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
          + Add
        </button>
      </div>
    );
    return () => { onHeaderContent(null); };
  }, [onHeaderContent, sceneContext, isBulkActive, isConnected, needsContract,
      activeSceneId, tracks.length, handleAddTrack, handleCompose, onOpenContract]);

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

      // 4. Build user prompt (musical context auto-prefixed by SDK)
      const concurrentSummary = generationContext.concurrentTracks.length > 0
        ? generationContext.concurrentTracks.map(
            (ct) => `  - ${ct.role ?? 'unknown'} (${ct.presetCategory ?? 'unknown category'})`
          ).join('\n')
        : '  (none yet)';

      const userPrompt = [
        `Concurrent tracks already in the scene:`,
        concurrentSummary,
        ``,
        `Classified preset category: ${presetCategory}`,
        ``,
        `User request: "${track.prompt}"`,
        ``,
        `Generate MIDI notes for a synth part that fits this context.`,
      ].join('\n');

      // 5. Call LLM (SDK auto-prefixes musical context)
      const llmResult = await host.generateWithLLM({
        system: MIDI_SYSTEM_PROMPT,
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

      // Store role in scene data for shuffle/duplicate to use (stable DB UUID key)
      const genDbId = engineToDbIdRef.current.get(trackId) ?? trackId;
      const newRole = parsed.role ?? track.role;
      if (activeSceneId && newRole) {
        host.setSceneData(activeSceneId, `track:${genDbId}:role`, newRole).catch(() => {});
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

      // Update state on success
      setTracks(prev => prev.map(t =>
        t.handle.id === trackId
          ? { ...t, isGenerating: false, error: null, role: newRole, hasMidi: true, generationProgress: 0 }
          : t
      ));
      host.showToast('success', 'MIDI generated');
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Generation failed';
      setTracks(prev => prev.map(t =>
        t.handle.id === trackId ? { ...t, isGenerating: false, error: msg, generationProgress: 0 } : t
      ));
      host.showToast('error', 'Generation failed', msg);
    }
  }, [host, tracks, isAuthenticated, activeSceneId]);

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
  const handleShuffle = useCallback(async (trackId: string): Promise<void> => {
    try {
      const result = await host.shufflePreset(trackId);
      console.log(`[SynthGenerator] Preset shuffled: ${result.presetName}`);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Shuffle failed';
      host.showToast('error', 'Shuffle failed', msg);
    }
  }, [host]);

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
    setTracks(prev => prev.map(t =>
      t.handle.id === trackId ? { ...t, fxDrawerOpen: !t.fxDrawerOpen, instrumentDrawerOpen: false, instrumentDrawerStage: 'instruments' as const } : t
    ));
    // Refresh FX state when opening drawer
    const track = tracks.find(t => t.handle.id === trackId);
    if (track && !track.fxDrawerOpen) {
      host.getTrackFxState(trackId).then(fxState => {
        setTracks(prev => prev.map(t =>
          t.handle.id === trackId ? { ...t, fxDetailState: pluginFxToToggleFx(fxState) } : t
        ));
      }).catch(() => {});
    }
  }, [host, tracks]);

  // --- Progress persistence callback ------------------------------------
  const handleProgressChange = useCallback((trackId: string, pct: number): void => {
    setTracks(prev => prev.map(t =>
      t.handle.id === trackId ? { ...t, generationProgress: pct } : t
    ));
  }, []);

  // --- Instrument selection callbacks ------------------------------------
  const toggleInstrumentDrawer = useCallback((trackId: string): void => {
    // Close FX drawer when opening instrument drawer.
    // If track has a custom instrument, open to editor stage; otherwise instrument list.
    setTracks(prev => prev.map((t: SynthTrackState) => {
      if (t.handle.id !== trackId) return t;
      const opening = !t.instrumentDrawerOpen;
      const stage = opening && t.instrumentPluginId ? 'editor' as const : 'instruments' as const;
      return { ...t, instrumentDrawerOpen: opening, fxDrawerOpen: false, instrumentDrawerStage: stage };
    }));
    // Lazy-load available instruments on first drawer open
    if (availableInstruments.length === 0 && !instrumentsLoading) {
      setInstrumentsLoading(true);
      host.getAvailableInstruments().then((instruments: InstrumentDescriptor[]) => {
        setAvailableInstruments(instruments);
      }).catch(() => {}).finally(() => {
        setInstrumentsLoading(false);
      });
    }
  }, [host, availableInstruments.length, instrumentsLoading]);

  const handleInstrumentSelect = useCallback(async (trackId: string, pluginId: string): Promise<void> => {
    const isSurgeXt = pluginId === 'Surge XT';

    if (isSurgeXt) {
      // Revert to default — close drawer
      setTracks(prev => prev.map((t: SynthTrackState) =>
        t.handle.id === trackId ? { ...t, instrumentDrawerOpen: false, instrumentDrawerStage: 'instruments' as const } : t
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

    // Custom instrument — load it, then transition to preset stage
    setTracks(prev => prev.map((t: SynthTrackState) =>
      t.handle.id === trackId ? { ...t, instrumentDrawerStage: 'editor' as const } : t
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
      // Revert to instrument stage on failure
      setTracks(prev => prev.map((t: SynthTrackState) =>
        t.handle.id === trackId ? { ...t, instrumentDrawerStage: 'instruments' as const } : t
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
      t.handle.id === trackId ? { ...t, instrumentDrawerStage: 'instruments' as const } : t
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
                prompt={loadedTrack.prompt}
                runtimeState={{
                  muted: loadedTrack.runtimeState.muted,
                  solo: loadedTrack.runtimeState.solo,
                  volume: loadedTrack.runtimeState.volume,
                  pan: loadedTrack.runtimeState.pan,
                }}
                fxDetailState={loadedTrack.fxDetailState}
                fxDrawerOpen={loadedTrack.fxDrawerOpen}
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
                instrumentDrawerOpen={loadedTrack.instrumentDrawerOpen}
                onToggleInstrumentDrawer={() => toggleInstrumentDrawer(loadedTrack.handle.id)}
                availableInstruments={availableInstruments}
                currentInstrumentPluginId={loadedTrack.instrumentPluginId}
                onInstrumentSelect={(pluginId: string) => handleInstrumentSelect(loadedTrack.handle.id, pluginId)}
                instrumentsLoading={instrumentsLoading}
                onRefreshInstruments={handleRefreshInstruments}
                instrumentDrawerStage={loadedTrack.instrumentDrawerStage}
                onShowEditor={() => handleShowEditor(loadedTrack.handle.id)}
                onBackToInstruments={() => handleBackToInstruments(loadedTrack.handle.id)}
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
      {isLoadingTracks ? (
        <div className="text-sas-muted text-xs text-center py-4">Loading tracks...</div>
      ) : (
        tracks.map((track: SynthTrackState) => (
          <TrackRow
            key={track.handle.id}
            track={{ id: track.handle.id, name: track.handle.name, role: track.role }}
            prompt={track.prompt}
            runtimeState={{
              muted: track.runtimeState.muted,
              solo: track.runtimeState.solo,
              volume: track.runtimeState.volume,
              pan: track.runtimeState.pan,
            }}
            fxDetailState={track.fxDetailState}
            fxDrawerOpen={track.fxDrawerOpen}
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
            instrumentDrawerOpen={track.instrumentDrawerOpen}
            onToggleInstrumentDrawer={() => toggleInstrumentDrawer(track.handle.id)}
            availableInstruments={availableInstruments}
            currentInstrumentPluginId={track.instrumentPluginId}
            onInstrumentSelect={(pluginId: string) => handleInstrumentSelect(track.handle.id, pluginId)}
            instrumentsLoading={instrumentsLoading}
            onRefreshInstruments={handleRefreshInstruments}
            instrumentDrawerStage={track.instrumentDrawerStage}
            onShowEditor={() => handleShowEditor(track.handle.id)}
            onBackToInstruments={() => handleBackToInstruments(track.handle.id)}
          />
        ))
      )}
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
