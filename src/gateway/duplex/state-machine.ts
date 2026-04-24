/**
 * Duplex session state machine — Phase D.1.
 */

import {
  DuplexState,
  type DuplexEvent,
  type StateTransition,
  type TransitionMeta,
} from "./types.js";

const TRANSITION_TABLE: ReadonlyMap<DuplexState, ReadonlyMap<DuplexEvent, DuplexState>> =
  new Map<DuplexState, Map<DuplexEvent, DuplexState>>([
    [DuplexState.INIT, new Map<DuplexEvent, DuplexState>([
      ["duplex.session.start", DuplexState.LISTENING],
      ["session.error", DuplexState.ERROR],
      ["duplex.session.end", DuplexState.ENDED],
      ["timeout", DuplexState.ENDED],
    ])],
    [DuplexState.LISTENING, new Map<DuplexEvent, DuplexState>([
      ["user.speech.started", DuplexState.LISTENING],
      ["user.speech.stopped", DuplexState.LISTENING],
      ["response.started", DuplexState.AGENT_SPEAKING],
      ["session.pause", DuplexState.PAUSED],
      ["session.error", DuplexState.ERROR],
      ["duplex.session.end", DuplexState.ENDED],
      ["timeout", DuplexState.ENDED],
    ])],
    [DuplexState.AGENT_SPEAKING, new Map<DuplexEvent, DuplexState>([
      ["user.speech.started", DuplexState.SIMULTANEOUS],
      ["response.audio_done", DuplexState.LISTENING],
      ["interrupt", DuplexState.ROLLING_BACK],
      ["session.pause", DuplexState.PAUSED],
      ["session.error", DuplexState.ERROR],
      ["duplex.session.end", DuplexState.ENDED],
      ["timeout", DuplexState.ENDED],
    ])],
    [DuplexState.SIMULTANEOUS, new Map<DuplexEvent, DuplexState>([
      ["interrupt", DuplexState.ROLLING_BACK],
      ["user.speech.stopped", DuplexState.AGENT_SPEAKING],
      ["response.audio_done", DuplexState.LISTENING],
      ["session.error", DuplexState.ERROR],
      ["duplex.session.end", DuplexState.ENDED],
      ["timeout", DuplexState.ENDED],
    ])],
    [DuplexState.ROLLING_BACK, new Map<DuplexEvent, DuplexState>([
      ["rollback.complete", DuplexState.LISTENING],
      ["session.error", DuplexState.ERROR],
      ["duplex.session.end", DuplexState.ENDED],
      ["timeout", DuplexState.ENDED],
    ])],
    [DuplexState.PAUSED, new Map<DuplexEvent, DuplexState>([
      ["session.resume", DuplexState.LISTENING],
      ["session.error", DuplexState.ERROR],
      ["duplex.session.end", DuplexState.ENDED],
      ["timeout", DuplexState.ENDED],
    ])],
    [DuplexState.ENDED, new Map()],
    [DuplexState.ERROR, new Map()],
  ]);

export class DuplexStateMachineError extends Error {
  readonly code: "INVALID_TRANSITION" | "TERMINAL_STATE";
  readonly from: DuplexState;
  readonly event: DuplexEvent;
  constructor(code: DuplexStateMachineError["code"], from: DuplexState, event: DuplexEvent, message: string) {
    super(`[duplex-state-machine:${code}] ${message}`);
    this.name = "DuplexStateMachineError";
    this.code = code;
    this.from = from;
    this.event = event;
  }
}

export type TransitionListener = (transition: StateTransition) => void;

export interface DuplexStateMachineOptions {
  initialState?: DuplexState;
  now?: () => number;
}

export class DuplexStateMachine {
  private _state: DuplexState;
  private readonly _history: StateTransition[] = [];
  private readonly _listeners: TransitionListener[] = [];
  private readonly clock: () => number;

  constructor(options: DuplexStateMachineOptions = {}) {
    this._state = options.initialState ?? DuplexState.INIT;
    this.clock = options.now ?? (() => Date.now());
  }

  get state(): DuplexState { return this._state; }
  get history(): readonly StateTransition[] { return this._history; }
  get isTerminal(): boolean { return this._state === DuplexState.ENDED || this._state === DuplexState.ERROR; }

  transition(event: DuplexEvent, meta?: Partial<TransitionMeta>): StateTransition {
    const from = this._state;
    const stateTransitions = TRANSITION_TABLE.get(from);
    if (!stateTransitions || stateTransitions.size === 0) {
      throw new DuplexStateMachineError("TERMINAL_STATE", from, event, `cannot process event "${event}" in terminal state "${from}"`);
    }
    const to = stateTransitions.get(event);
    if (to === undefined) {
      throw new DuplexStateMachineError("INVALID_TRANSITION", from, event, `event "${event}" is not allowed from state "${from}"`);
    }
    const fullMeta: TransitionMeta = { timestamp: meta?.timestamp ?? this.clock(), ...meta };
    const record: StateTransition = { from, to, event, meta: fullMeta };
    this._state = to;
    this._history.push(record);
    for (const listener of this._listeners) {
      try { listener(record); } catch { /* never let listener errors poison the machine */ }
    }
    return record;
  }

  tryTransition(event: DuplexEvent, meta?: Partial<TransitionMeta>): StateTransition | null {
    try { return this.transition(event, meta); } catch { return null; }
  }

  canTransition(event: DuplexEvent): boolean {
    const stateTransitions = TRANSITION_TABLE.get(this._state);
    return stateTransitions?.has(event) === true;
  }

  onTransition(listener: TransitionListener): () => void {
    this._listeners.push(listener);
    return () => {
      const idx = this._listeners.indexOf(listener);
      if (idx >= 0) this._listeners.splice(idx, 1);
    };
  }

  allowedEvents(): ReadonlySet<DuplexEvent> {
    const stateTransitions = TRANSITION_TABLE.get(this._state);
    return new Set(stateTransitions?.keys() ?? []);
  }
}
