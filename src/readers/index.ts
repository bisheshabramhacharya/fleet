import { claudeReader } from "./claude.ts";
import { codexReader } from "./codex.ts";
import { commandcodeReader } from "./commandcode.ts";
import { droidReader } from "./droid.ts";
import { dshReader } from "./dsh.ts";
import { grokReader } from "./grok.ts";
import { hermesReader } from "./hermes.ts";
import { makeInboxReader } from "./inbox.ts";
import { opencodeReader } from "./opencode.ts";
import { ompReader, piReader } from "./pi.ts";
import type { SourceReader } from "./types.ts";

export function allReaders(inboxDir: string): SourceReader[] {
  return [
    claudeReader,
    codexReader,
    droidReader,
    commandcodeReader,
    piReader,
    ompReader,
    opencodeReader,
    dshReader,
    hermesReader,
    grokReader,
    makeInboxReader(inboxDir),
  ];
}
