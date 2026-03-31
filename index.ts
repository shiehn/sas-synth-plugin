/**
 * @sas/synth-generator — Built-in Synth Generator Plugin
 *
 * AI-powered MIDI generation with Surge XT synthesis.
 * Supports single and bulk track generation, preset management,
 * and orphaned track detection.
 */

import type { ComponentType } from 'react';
import type {
  GeneratorPlugin,
  PluginHost,
  PluginUIProps,
  PluginSettingsSchema,
  MusicalContext,
} from '../../../shared/types/plugin-sdk.types';
import { SynthGeneratorPanel } from './SynthGeneratorPanel';

export class SynthGeneratorPlugin implements GeneratorPlugin {
  readonly id = '@sas/synth-generator';
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
