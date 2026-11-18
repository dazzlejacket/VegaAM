/**
 * Draft handling for editable text fields that are synchronised with the main
 * process.
 *
 * VegaAM broadcasts the complete application state to the renderer roughly
 * once per second. A naive renderer therefore overwrites whatever the user is
 * currently typing, which is exactly the "the API key field never saves"
 * defect: the typed value was dropped by the next broadcast and nothing ever
 * persisted it.
 *
 * This module owns that state machine in a pure, platform independent way so
 * the same rules are regression tested on Windows, macOS and Linux:
 *
 *   type()    - the user changed the text
 *   commit()  - the field lost focus / changed: the value to persist
 *   confirm() - the main process confirmed the stored value
 *   display() - the value the input has to show
 */

/** One tracked field. */
interface FieldState {
  /** The text the user typed but did not persist yet. */
  draft?: string;
  /** A value that was sent to the main process but is not confirmed yet. */
  pending?: string;
  /** The last value the main process confirmed as stored. */
  persisted?: string;
}

export class DraftFieldRegistry {
  private readonly fields = new Map<string, FieldState>();

  private state(id: string): FieldState {
    let state = this.fields.get(id);
    if (!state) {
      state = {};
      this.fields.set(id, state);
    }
    return state;
  }

  /** Record that the user changed the text of the field. */
  type(id: string, value: string): void {
    this.state(id).draft = value;
  }

  /**
   * True while a remote state update must not overwrite the field.
   *
   * That is the case while the user is typing and while a save is still in
   * flight - both windows in which the value in the input is newer than the
   * value the main process knows about.
   */
  blocksRemote(id: string): boolean {
    const state = this.fields.get(id);
    if (!state) return false;
    return state.draft !== undefined || state.pending !== undefined;
  }

  /** The value the input has to show for the given remote state. */
  display(id: string, remote: string): string {
    const state = this.fields.get(id);
    if (!state) return remote;
    if (state.draft !== undefined) return state.draft;
    if (state.pending !== undefined) return state.pending;
    return remote;
  }

  /**
   * Prepare the value that has to be persisted.
   *
   * Returns `null` when there is nothing new to save (no draft, the draft
   * equals the stored value, or a save for this field is still in flight).
   */
  commit(id: string): string | null {
    const state = this.fields.get(id);
    if (!state || state.draft === undefined) return null;
    const draft = state.draft;
    state.draft = undefined;
    if (state.persisted === draft) return null;
    state.pending = draft;
    return draft;
  }

  /** The main process confirmed the stored value. */
  confirm(id: string, value: string): void {
    const state = this.state(id);
    state.draft = undefined;
    state.pending = undefined;
    state.persisted = value;
  }

  /**
   * The save failed - the typed text has to stay in the input so the user
   * does not lose it, and it has to be offered for a retry.
   */
  reject(id: string): void {
    const state = this.fields.get(id);
    if (!state) return;
    if (state.pending !== undefined) state.draft = state.pending;
    state.pending = undefined;
  }

  /** Forget everything about the field (used when a panel is re-created). */
  reset(id: string): void {
    this.fields.delete(id);
  }
}
