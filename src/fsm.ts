import type { HandoffStatus, MessageState, SlipState } from "./types.ts";

export const SLIP_TRANSITIONS: Readonly<Record<SlipState, readonly SlipState[]>> = {
  draft: ["kept", "expired"],
  kept: ["expired"],
  expired: [],
};

export const MESSAGE_TRANSITIONS: Readonly<Record<MessageState, readonly MessageState[]>> = {
  pending: ["read", "archived"],
  read: ["archived"],
  archived: [],
};

export const HANDOFF_TRANSITIONS: Readonly<Record<HandoffStatus, readonly HandoffStatus[]>> = {
  active: ["completed", "abandoned"],
  completed: [],
  abandoned: [],
};

export function sourcesFor<State extends string>(table: Readonly<Record<State, readonly State[]>>, target: State): State[] {
  return (Object.keys(table) as State[]).filter((from) => table[from].includes(target));
}

export function canTransition<State extends string>(table: Readonly<Record<State, readonly State[]>>, from: State, to: State): boolean {
  return table[from]?.includes(to) ?? false;
}
