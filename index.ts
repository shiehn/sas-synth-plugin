/**
 * @signalsandsorcery/synth-generator — Synth Generator Plugin
 *
 * AI-powered MIDI generation with Surge XT synthesis.
 * Supports single and bulk track generation, preset management,
 * and orphaned track detection.
 *
 * Extracted from the in-tree built-in (W9). The host consumes this package
 * via `file:../sas-synth-plugin` and registers it exactly like the chat
 * plugin — importing both the class and the manifest from the package root.
 */

import type { ComponentType } from 'react';
import type {
  GeneratorPlugin,
  PluginHost,
  PluginUIProps,
  PluginSettingsSchema,
  MusicalContext,
} from '@signalsandsorcery/plugin-sdk';
import { SynthGeneratorPanel } from './SynthGeneratorPanel';
import synthManifest from './plugin.json';

/** Plugin manifest (re-exported so the host registers it from the package root). */
export { synthManifest };

export class SynthGeneratorPlugin implements GeneratorPlugin {
  readonly id = '@signalsandsorcery/synth-generator';
  readonly displayName = 'Synths';
  readonly version = '1.0.0';
  readonly description = 'AI-powered MIDI generation with Surge XT synthesis';
  readonly generatorType = 'midi' as const;
  readonly minHostVersion = '1.0.0';

  private host: PluginHost | null = null;

  async activate(host: PluginHost): Promise<void> {
    this.host = host;
    console.log('[SynthGeneratorPlugin] Activated');
  }

  async deactivate(): Promise<void> {
    this.host = null;
    console.log('[SynthGeneratorPlugin] Deactivated');
  }

  getUIComponent(): ComponentType<PluginUIProps> {
    return SynthGeneratorPanel;
  }

  getSettingsSchema(): PluginSettingsSchema | null {
    return null;
  }

  async onSceneChanged(_sceneId: string | null): Promise<void> {
    // Synth tracks are loaded by the host on scene change
  }

  onContextChanged(_context: MusicalContext): void {
    // Could trigger re-generation suggestions when chords change
  }
}

export default SynthGeneratorPlugin;
