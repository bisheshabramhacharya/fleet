import type { Fidelity, ToolId, UsageRecord } from "../core/types.ts";

export interface ReaderContext {
  /** The user's home folder on this device. */
  readonly homeDir: string;
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  /** Extra folders the owner added for this tool in settings. */
  readonly customHomes: readonly string[];
}

export interface SourceHome {
  /** Root folder the reader scans. */
  readonly dir: string;
  /** Shown when a tool has several homes, for example "codex-personal". */
  readonly label?: string;
}

export interface FileContext {
  readonly path: string;
  readonly home: SourceHome;
  readonly ctx: ReaderContext;
}

/**
 * Line-oriented logs (JSONL). The collector resumes from the last complete
 * line, so `state` must be JSON-serializable when present.
 */
export interface LineFormat<State = unknown> {
  readonly kind: "lines";
  /** A line is parsed only when it contains one of these strings. Omit to parse every line. */
  readonly usageMarkers?: readonly string[];
  readonly initialState?: () => State;
  parseLine(line: string, state: State, file: FileContext): readonly UsageRecord[];
}

/** Whole-file formats: JSON documents, SQLite databases, compressed logs. */
export interface FileFormat {
  readonly kind: "file";
  parseFile(file: FileContext): Promise<readonly UsageRecord[]>;
}

export interface SourceReader {
  readonly tool: ToolId;
  readonly fidelity: Fidelity;
  /** Folders that exist on this device for this tool. Return [] when the tool is absent. */
  homes(ctx: ReaderContext): Promise<readonly SourceHome[]>;
  /** Absolute paths of every log file under a home. */
  files(home: SourceHome, ctx: ReaderContext): Promise<readonly string[]>;
  readonly format: LineFormat<any> | FileFormat;
  /** Home-folder names this reader covers, used to flag unread AI folders. */
  readonly knownFolders?: readonly string[];
}
